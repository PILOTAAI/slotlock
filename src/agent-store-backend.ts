import {
  SLOTLOCK_RESOURCE_PROFILE_FIELDS,
  type SlotlockLocation,
  type SlotlockPoolOrder,
  type SlotlockResourceGroup,
  type SlotlockResourceKind,
  type SlotlockResourceProfileInput,
  SLOTLOCK_RECONCILE_TOLERANCE_PERCENT,
  slotlockResourceHasLabels,
} from './resource-profile.js';
import type { Sql } from 'postgres';
import {
  SLOTLOCK_USAGE_RETENTION_DAYS,
  slotlockUsageDay,
  slotlockUsageMonthToDate,
  slotlockUsageSpanDays,
  summarizeSlotlockUsage,
} from './usage.js';
import type { SlotlockAgentChangeSource } from './change-watch.js';
import { type SlotlockChangeOrigin, type SlotlockWebhookEndpoint, slotlockChangeFeedHead } from './event-feed.js';
import { slotlockCloudEvent } from './webhooks.js';
import { createHash } from 'node:crypto';
import {
  SLOTLOCK_DEFAULT_APPROVAL_MINUTES,
  SLOTLOCK_KEY_APPROVAL_POLICY,
  SLOTLOCK_MAX_APPROVAL_MINUTES,
  SlotlockApprovalPolicyError,
} from './approvals.js';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
} from './agent-server.js';
import type {
  SlotlockApplicationBackend,
  SlotlockApplicationInvocationContext,
} from './application-api.js';
import {
  type SlotlockBookingRule,
  type SlotlockBookingRules,
  bookingSearch,
  hoursApplyOf,
  bookingSearchBlocked,
  bookingSearchReach,
} from './booking-rules.js';
import { findNextAvailable, mergeIntervals } from './engine.js';
import {
  type SlotlockAvailabilityException,
  applicableHours,
  coveredByOpenWindows,
  dayToDate,
  epochDay,
  exceptionDays,
  exceptionRanges,
  openWindows,
} from './hours.js';
import { readSlotlockHolidayCalendar } from './holiday-import.js';
import {
  SLOTLOCK_OVERRIDE_RESOURCES,
  type SlotlockHolidayCalendar,
  type SlotlockOverrideResources,
} from './availability-store.js';
import { findEarliestRange } from './ranges.js';
import { emitVAvailability, parseVAvailability, toJSCalendarEvent } from './interop.js';
import {
  type SlotlockStore,
  type SlotlockTenantStore,
  type SlotlockWaitlistEntry,
  SLOTLOCK_INTERNAL_EVENT_OWNER_REF,
  calendarEventRollingHorizon,
} from './store.js';
import { slotlockResourceSearchWords, slotlockSearchResources } from './resource-search.js';
import type {
  CalendarAttendee,
  CalendarEventContent,
  CalendarRecurrence,
  CalendarRecurrenceException,
  CalendarReminder,
  Interval,
  SlotlockApproval,
  SlotlockApprovalKind,
  SlotlockApprovalPolicy,
  SlotlockCalendarEvent,
  SlotlockContact,
  SlotlockContactConsent,
  SlotlockHold,
  SlotlockReservation,
  SlotlockResource,
  WeeklyAvailabilityRule,
} from './types.js';
import { maintainSlotlockTenant } from './maintenance.js';
import {
  type SlotlockSandboxScenario,
  fastForwardSlotlockSandbox,
  raceSlotlockSandbox,
  resetSlotlockSandbox,
  seedSlotlockSandbox,
} from './sandbox.js';
import { SLOTLOCK_TEST_TENANT_SUFFIX, type SlotlockApiKeyScope } from './api-keys.js';
import {
  type SlotlockPartnerAccount,
  type SlotlockPartnerStore,
  slotlockPartnerKeyOutput,
  slotlockPrincipalPartner,
} from './partners.js';

/** A partner's account as the partner API shows it. */
function partnerAccountOutput(account: SlotlockPartnerAccount): Record<string, unknown> {
  return {
    account: account.account,
    plan: account.plan,
    status: account.status,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
    ...(account.resources !== undefined ? { resources: account.resources } : {}),
    ...(account.apiKeys !== undefined ? { api_keys: account.apiKeys } : {}),
  };
}
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
  /**
   * The longest an approval policy may hold a write for a person (RFC 0004 A4), in minutes: each
   * policy sets its own wait, bounded by the booking's start less its lead time and by this. 1 to
   * 43,200 (30 days, the default).
   */
  maxApprovalMinutes?: number;
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
  notify?: boolean;
  recurrence_exceptions?: AgentRecurrenceExceptionInput[];
  idempotency_key: string;
}

/**
 * Writes run under READ COMMITTED whatever the role's default: tenant limits are counted under a
 * lock that needs that level.
 */
const WRITE = { isolation: 'read committed' } as const;

/**
 * Keys a context carries only from inside this module: a request cannot set a symbol, and spreading
 * a context (`{ ...context, operation }`) keeps them.
 */
const APPROVAL_GRANT = Symbol('slotlock.approvalGrant');
const OCCUPANCY_PROBE = Symbol('slotlock.occupancyProbe');
/**
 * A booking the tenant's own systems make through the application API (RFC 0004 B7), not an
 * agent's: its events are the tenant's (owner `internal`), outside any key's quota and kept when the
 * key is revoked, and only approval policies that include the application hold it.
 */
const TENANT_ACTOR = Symbol('slotlock.tenantActor');

/** The approval a granted write runs for: its holds give way, and it is marked, in the write's transaction. */
interface ApprovalGrant {
  id: string;
  decidedBy: string;
  /** A pool booking's pool, whose round-robin place moves on as a direct booking's would. */
  pool?: string;
}

interface TenantCallContext {
  principal: {
    tenantRef: string;
    subject?: string;
    keyId?: string;
    resourceScope?: { readonly locations: readonly string[]; readonly groups: readonly string[] };
  };
  signal: AbortSignal;
  /** The surface the call came through, recorded with its changes. */
  origin?: SlotlockChangeOrigin;
  /** A dry run (RFC 0004 A3): every transaction this call opens is rolled back. */
  dryRun?: boolean;
  /** A grant running its approval's write (RFC 0004 A4); internal, never from a request. */
  [APPROVAL_GRANT]?: ApprovalGrant;
  /** Read what a dry run's write would occupy, in its transaction, before it is undone. */
  [OCCUPANCY_PROBE]?: (tenantStore: SlotlockTenantStore) => Promise<void>;
  /** Made for the tenant's own systems, not an agent; internal, never from a request. */
  [TENANT_ACTOR]?: true;
}

/** Whether the call books for the tenant's own systems (TENANT_ACTOR), not an agent. */
function forTenant(context: SlotlockAgentInvocationContext): boolean {
  return (context as unknown as TenantCallContext)[TENANT_ACTOR] === true;
}

/** The tenant's own identity for a retry key: per tenant, so any of its keys replays it. */
function tenantDigest(context: SlotlockAgentInvocationContext, idempotencyKey: string): string {
  return createHash('sha256').update(`${context.principal.tenantRef}\0tenant\0${idempotencyKey}`).digest('hex');
}

/** Thrown out of a dry run's transaction, with its answer, so the transaction rolls back. */
class DryRunRollback {
  constructor(readonly value: unknown) {}
}

// The UUIDs withTenant takes as a keyId (versions 1-5); any other from a custom authenticator is
// left out, not refused.
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const keyId = context.principal.keyId;
    // A granted approval's write: its holds give way and it is marked granted in the same
    // transaction, so the time passes from the approval to the booking with no gap between.
    const grant = context[APPROVAL_GRANT];
    const write: typeof callback = grant
      ? async (tenantStore) => {
          const tenantRef = context.principal.tenantRef;
          const begun = await tenantStore.beginApprovalGrant({ tenantRef, id: grant.id });
          if (!begun.ok) {
            throw new SlotlockAgentOperationError(begun.code, begun.code === 'approval_not_found' ? 404 : 409);
          }
          const value = await callback(tenantStore);
          const booked = (value as { event?: { resource_id?: unknown } }).event?.resource_id;
          if (grant.pool !== undefined && typeof booked === 'string') {
            await tenantStore.notePoolBooking({ tenantRef, pool: grant.pool, resourceId: booked });
          }
          await tenantStore.finishApprovalGrant({ tenantRef, id: grant.id, decidedBy: grant.decidedBy });
          return value;
        }
      : callback;
    // A dry run's transaction does everything, constraints included, then is undone: its answer
    // is carried out of it by the rollback.
    const probe = context[OCCUPANCY_PROBE];
    const run: typeof callback = context.dryRun
      ? async (tenantStore) => {
          const value = await write(tenantStore);
          if (probe) await probe(tenantStore);
          throw new DryRunRollback(value);
        }
      : write;
    value = await store.withTenant(context.principal.tenantRef, run, {
      ...options,
      signal: context.signal,
      ...(actor !== undefined ? { actor } : {}),
      ...(context.origin !== undefined ? { origin: context.origin } : {}),
      ...(typeof keyId === 'string' && KEY_ID.test(keyId) ? { keyId } : {}),
      // A key limited to part of the tenant reaches only its resources, by the database's policies.
      ...(context.principal.resourceScope ? { resourceScope: context.principal.resourceScope } : {}),
    });
  } catch (error) {
    if (error instanceof DryRunRollback) {
      assertActive(context);
      return error.value as T;
    }
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
 * Busy intervals one free/busy read or search may gather across all its resources: as many as the
 * store reads for one, so naming many resources cannot multiply the work.
 */
const MAX_REQUEST_BUSY_INTERVALS = 10_000;

/**
 * Bookable windows one search may expand from its resources' rules in all (five resources of 50
 * daily rules over a year, or a hundred of two), so a broad search cannot hold the process.
 */
const MAX_REQUEST_RULE_WINDOWS = 100_000;

function distinctResourceIds(input: Record<string, unknown>): string[] {
  return [...new Set(input.resource_ids as string[])];
}

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
  if (forTenant(context)) return SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
  return `agent:${createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}`)
    .digest('hex')}`;
}

function agentExternalRef(context: SlotlockAgentInvocationContext, idempotencyKey: string): string {
  if (forTenant(context)) return `tenant:${tenantDigest(context, idempotencyKey)}`;
  // Already a stable client-visible identity; keep it unchanged.
  return `agent:${agentPrincipalDigest(context, idempotencyKey)}`;
}

function agentCommandIdempotencyKey(
  context: SlotlockAgentInvocationContext,
  idempotencyKey: string,
): string {
  if (forTenant(context)) return `tenant-command:${tenantDigest(context, idempotencyKey)}`;
  // The principal stays in the digest so this remains safe with older tenant-only stores; hashing
  // keeps the subject and raw retry key out of durable rows.
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
    // External references are the tenant-visible identity: internal UUIDs never become an unscoped
    // lookup at the protocol boundary.
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
  if (code.startsWith('invalid_') || code === 'duration_required') return 400;
  if (code === 'owner_event_quota_exceeded' || code === 'owner_command_quota_exceeded') return 429;
  return 409;
}

/** The code an agent's error carries for each booking rule a write breaks. */
const BOOKING_RULE_CODES: Readonly<Record<SlotlockBookingRule, string>> = Object.freeze({
  min_notice: 'booking_rule_min_notice',
  max_advance: 'booking_rule_max_advance',
  slot_step: 'booking_rule_slot_step',
  outside_hours: 'booking_rule_outside_hours',
  uncertain: 'booking_rule_uncertain',
  min_duration: 'booking_rule_min_duration',
  max_duration: 'booking_rule_max_duration',
  duration_not_allowed: 'booking_rule_duration_not_allowed',
  pickup_time: 'booking_rule_pickup_time',
  return_time: 'booking_rule_return_time',
  cancel_cutoff: 'booking_rule_cancel_cutoff',
  reschedule_cutoff: 'booking_rule_reschedule_cutoff',
});

function operationError(
  refusal: string | { code: string; rule?: string },
  details?: Record<string, string>,
): SlotlockAgentOperationError {
  const code =
    typeof refusal === 'string'
      ? refusal
      : refusal.code === 'booking_rule_violated' && refusal.rule
        ? (BOOKING_RULE_CODES[refusal.rule as SlotlockBookingRule] ?? refusal.code)
        : refusal.code;
  const status = slotlockAgentErrorStatus(code);
  // A gone hold (another holder's, released or reaped) is named, so the agent holds again.
  return new SlotlockAgentOperationError(
    status === 404 && code !== 'hold_not_found' ? 'not_found' : code,
    status,
    details,
  );
}

/**
 * What an agent may be told about the booking in the way of its write: when that time is busy
 * (as free/busy shows anyone who may read the resource), and the booking itself only when it is
 * the agent's own hold or event, so it can release or move it. Nothing for another refusal, or for
 * a booking the key may not see (its scope, or another tenant's).
 */
async function overlapDetails(
  tenantStore: SlotlockTenantStore,
  context: SlotlockAgentInvocationContext,
  refusal: { code: string; conflictingReservationId?: string | null },
): Promise<Record<string, string>> {
  if (refusal.code !== 'overlap' || typeof refusal.conflictingReservationId !== 'string') return {};
  const booking = await tenantStore.describeBooking({
    tenantRef: context.principal.tenantRef,
    id: refusal.conflictingReservationId,
  });
  if (!booking) return {};
  const owner = agentOwnerRef(context);
  return {
    busy_start: booking.start.toISOString(),
    busy_end: booking.end.toISOString(),
    ...(booking.status === 'held' && booking.holderRef === owner ? { conflicting_hold_id: booking.id } : {}),
    ...(booking.eventRef !== null && booking.eventOwnerRef === owner ? { conflicting_event_id: booking.eventRef } : {}),
  };
}

/**
 * Slots on a resource whose hours hold a hire only at its ends (`hoursApply`): up to `limit` of
 * `durationMs` from `from` to the window's end, each the range search's earliest after the last,
 * so a slot may run from one local day to another and is judged as a write of it is.
 */
async function rangedSlots(
  tenantStore: SlotlockTenantStore,
  context: SlotlockAgentInvocationContext,
  resource: SlotlockResource,
  window: Interval,
  from: number,
  durationMs: number,
  busy: readonly Interval[],
  limit: number,
  availabilityRules: (context: SlotlockAgentInvocationContext, resource: SlotlockResource) => Promise<WeeklyAvailabilityRule[]>,
): Promise<Interval[]> {
  const fallback =
    resource.availabilityRules === undefined && resource.inheritedAvailability === undefined
      ? await availabilityRules(context, resource)
      : [];
  const exceptions =
    (
      await tenantStore.availabilityExceptionsFor({
        tenantRef: context.principal.tenantRef,
        resourceIds: [resource.id],
        window: { start: new Date(window.start.getTime() - 86_400_000), end: new Date(window.end.getTime() + 86_400_000) },
      })
    ).get(resource.id) ?? [];
  const rules = { ...resource.effectiveBookingRules, allowedDurations: [Math.round(durationMs / 60_000)] };
  const hours = applicableHours(resource, fallback).rules;
  const now = new Date();
  const lastStart = window.end.getTime() - durationMs;
  const slots: Interval[] = [];
  for (let start = from; slots.length < limit && start <= lastStart; ) {
    const range = findEarliestRange({
      busy,
      rules,
      timezone: resource.timezone,
      hours,
      exceptions,
      now,
      pickup: { start: new Date(start), end: new Date(lastStart) },
      return: { start: new Date(start + durationMs), end: window.end },
    });
    if (!range) break;
    slots.push(range);
    start = range.end.getTime();
  }
  return slots;
}

/** Resource and event ids: the UUIDs the store issues and validates. */
const STORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * The caller's resource with this id, or `resource_not_found`. Agents may send any id; one that is
 * not a store-issued (v1-5) UUID names no resource and is not found, like another tenant's. With
 * `visibility`, a resource of the other visibility is not found either, so private ones are
 * invisible to agents.
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
/** The most resources a search or a not-found's candidates look through: more than a tenant may have. */
const MAX_SEARCHED_RESOURCES = 5_000;

/** A tenant's resources agents may see, in pages, up to MAX_SEARCHED_RESOURCES. */
async function sharedResources(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  filter: { kind?: NonNullable<SlotlockResource['kind']>; labels?: string[]; location?: string; group?: string } = {},
): Promise<SlotlockResource[]> {
  const all: SlotlockResource[] = [];
  let after: string | undefined;
  while (all.length < MAX_SEARCHED_RESOURCES) {
    const page = await tenantStore.listResources({
      tenantRef,
      visibility: 'shared',
      limit: 1_000,
      ...(after !== undefined ? { after } : {}),
      ...filter,
    });
    all.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
  }
  return all.slice(0, MAX_SEARCHED_RESOURCES);
}

/**
 * The refusal for an id that names no resource the caller can see. When what was given is not an
 * id at all (a name or a reference, as a model will pass), it names up to three resources that best
 * match it, so the caller can try again with the right id.
 */
async function resourceNotFound(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  given: string,
): Promise<SlotlockAgentOperationError> {
  if (STORE_ID_PATTERN.test(given) || typeof given !== 'string' || given.trim() === '') {
    return new SlotlockAgentOperationError('resource_not_found', 404);
  }
  let words: string[];
  try {
    words = slotlockResourceSearchWords(given);
  } catch {
    return new SlotlockAgentOperationError('resource_not_found', 404);
  }
  const best = slotlockSearchResources(await sharedResources(tenantStore, tenantRef), words).slice(0, 3);
  const details = Object.fromEntries(
    best.map((match, index) => [
      `candidate_${String(index + 1)}`,
      `${match.resource.id} ${match.resource.name ?? match.resource.externalRef ?? ''}`.trim().slice(0, 200),
    ]),
  );
  return new SlotlockAgentOperationError('resource_not_found', 404, details);
}

async function requireAgentResource(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  resourceId: string,
): Promise<SlotlockResource> {
  try {
    return await requireResource(tenantStore, tenantRef, resourceId, 'shared');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'resource_not_found') throw error;
    throw await resourceNotFound(tenantStore, tenantRef, resourceId);
  }
}

/**
 * The store's change feed for live updates (`subscriptions.changes`): each tenant's changes read
 * under its RLS, one indexed query per read. Readers poll it (change-watch.ts); `sql` is the
 * store's client, used for the feed's head.
 */
export function createSlotlockStoreChangeSource(
  store: SlotlockStore,
  sql: Sql,
): SlotlockAgentChangeSource {
  return {
    head: () => slotlockChangeFeedHead(sql),
    async listChanges(params) {
      const page = await store.withTenant(params.tenantRef, (tenant) => tenant.listChanges(params));
      return page.ok ? { ok: true, changes: page.changes, next: page.next } : page;
    },
  };
}

/** Bind the protocol server to the production store without giving a request control of tenancy. */
/**
 * Each resource's open hours within `window` (RFC 0004 B1, B2): its own weekly hours, else what it
 * inherits from its location or tenant, else the server's, with the exceptions that reach it applied.
 * One query reads every resource's exceptions.
 */
async function hoursWithin(
  tenantStore: SlotlockTenantStore,
  context: SlotlockAgentInvocationContext,
  resources: readonly SlotlockResource[],
  window: Interval,
  options: Pick<SlotlockStoreAgentBackendOptions, 'availabilityRules'>,
): Promise<Map<string, Interval[]>> {
  const exceptions = await tenantStore.availabilityExceptionsFor({
    tenantRef: context.principal.tenantRef,
    resourceIds: resources.map((resource) => resource.id),
    window,
  });
  const open = new Map<string, Interval[]>();
  for (const resource of resources) {
    const fallback =
      resource.availabilityRules === undefined && resource.inheritedAvailability === undefined
        ? await options.availabilityRules(context, resource)
        : [];
    open.set(
      resource.id,
      openWindows({
        hours: applicableHours(resource, fallback).rules,
        exceptions: exceptions.get(resource.id) ?? [],
        timezone: resource.timezone,
        window,
      }),
    );
  }
  return open;
}

export function createSlotlockStoreAgentBackend(
  store: SlotlockStore,
  options: SlotlockStoreAgentBackendOptions,
): SlotlockAgentCalendarBackend {
  const maxApprovalMinutes = options.maxApprovalMinutes ?? SLOTLOCK_MAX_APPROVAL_MINUTES;
  if (!(Number.isSafeInteger(maxApprovalMinutes) && maxApprovalMinutes >= 1 && maxApprovalMinutes <= SLOTLOCK_MAX_APPROVAL_MINUTES)) {
    throw new RangeError(`maxApprovalMinutes must be a whole number from 1 to ${SLOTLOCK_MAX_APPROVAL_MINUTES}`);
  }
  const backend: SlotlockAgentCalendarBackend = {
    async holdSlots(context, input) {
      const slots = input.slots as { resource_id: string; start: string; end: string }[];
      const key = input.idempotency_key as string;
      const holderRef = agentOwnerRef(context);
      const limits = context.principal.limits;
      const holderCaps =
        limits?.maxHolds !== undefined || limits?.maxHeldHours !== undefined
          ? {
              ...(limits.maxHolds !== undefined ? { maxHolds: limits.maxHolds } : {}),
              ...(limits.maxHeldHours !== undefined ? { maxHeldHours: limits.maxHeldHours } : {}),
            }
          : undefined;
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
            // The key's own caps, below the server's (RFC 0004 A5).
            ...(holderCaps ? { holderCaps } : {}),
            // Booked only once your system records its payment (RFC 0004 C3).
            ...(input.payment_required === true ? { paymentRequired: true } : {}),
            ...(input.payment !== undefined ? { payment: amountInput(input.payment) as { amountMinor: number; currency: string } } : {}),
          });
          if (result.ok) {
            holds.push({
              hold_id: result.hold.id,
              resource_id: result.hold.resourceId,
              start: result.hold.start.toISOString(),
              end: result.hold.end.toISOString(),
              expires_at: result.hold.expiresAt.toISOString(),
              ...(result.hold.paymentRequired ? { payment_required: true, payment_amount: amountOutput(result.hold.paymentAmount) } : {}),
            });
          } else {
            refused.push({ index, code: operationError(result).code });
          }
        }
        return { group_id: groupId, holds, refused };
      });
    },

    async holdTogether(context, rawInput) {
      const input = rawInput as {
        resource_ids: string[];
        start: string;
        end: string;
        ttl_seconds: number;
        idempotency_key: string;
      };
      const holderRef = agentOwnerRef(context);
      const limits = context.principal.limits;
      const holderCaps =
        limits?.maxHolds !== undefined || limits?.maxHeldHours !== undefined
          ? {
              ...(limits.maxHolds !== undefined ? { maxHolds: limits.maxHolds } : {}),
              ...(limits.maxHeldHours !== undefined ? { maxHeldHours: limits.maxHeldHours } : {}),
            }
          : undefined;
      // Sorted, so sets over the same resources lock in one order; one group per agent and key.
      const resourceIds = [...new Set(input.resource_ids)].sort();
      if (resourceIds.length < 2) throw new SlotlockAgentOperationError('invalid_arguments', 400);
      const groupId = uuidFromDigest(`slotlock-hold-together\0${holderRef}\0${input.idempotency_key}`);
      return withTenant(store, context, async (tenantStore) => {
        for (const resourceId of resourceIds) {
          try {
            await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
          } catch (error) {
            if (!(error instanceof SlotlockAgentOperationError)) throw error;
            throw new SlotlockAgentOperationError(error.code, error.status, { resource_id: resourceId });
          }
          const result = await tenantStore.acquireHold({
            tenantRef: context.principal.tenantRef,
            principalRef: holderRef,
            holderRef,
            idempotencyKey: agentCommandIdempotencyKey(context, `${input.idempotency_key}\0together\0${resourceId}`),
            groupId,
            resourceId,
            start: new Date(input.start),
            end: new Date(input.end),
            ttlMs: input.ttl_seconds * 1_000,
            source: 'slotlock:together',
            ...(holderCaps ? { holderCaps } : {}),
          });
          // All or nothing: thrown, so the holds already made roll back with it.
          if (!result.ok) {
            const refusal = operationError(result);
            throw new SlotlockAgentOperationError(refusal.code, refusal.status, { resource_id: resourceId });
          }
        }
        // One time to live for the set: each expires when the earliest does.
        const holds = await tenantStore.holdGroup({
          tenantRef: context.principal.tenantRef,
          holderRef,
          groupId,
          alignExpiry: true,
        });
        if (holds.length !== resourceIds.length) throw new SlotlockAgentOperationError('store_inconsistent', 503);
        return {
          group_id: groupId,
          holds: holds.map((hold) => ({
            hold_id: hold.holdId,
            resource_id: hold.resourceId,
            start: hold.start.toISOString(),
            end: hold.end.toISOString(),
            expires_at: hold.expiresAt.toISOString(),
          })),
          expires_at: (holds[0] as { expiresAt: Date }).expiresAt.toISOString(),
        };
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
        // In the pool's order (stable, least booked first, or round robin).
        const members = await tenantStore.listPoolMembers({
          tenantRef,
          pool: input.pool,
          visibility: 'shared',
          ordered: true,
          forBooking: true,
        });
        if (members.length === 0) throw new SlotlockAgentOperationError('pool_not_found', 404);
        // Each member in turn, each in its own savepoint: one taken or refused by its rules is
        // passed over; the exclusion constraint still decides.
        for (const member of members) {
          const result = await put(member.id);
          if (result.ok) {
            await tenantStore.notePoolBooking({ tenantRef, pool: input.pool, resourceId: member.id });
            return answer(result);
          }
          if (result.code !== 'overlap' && result.code !== 'booking_rule_violated') {
            throw operationError(result);
          }
        }
        throw new SlotlockAgentOperationError('pool_full', 409);
      }, WRITE);
    },

    async getPoolAvailability(context, input) {
      const window = interval(input as { start: string; end: string });
      const pool = input.pool as string;
      const charge = busyBudget();
      let windowsLeft = MAX_REQUEST_RULE_WINDOWS;
      const now = new Date();
      return withTenant(store, context, async (tenantStore) => {
        const tenantRef = context.principal.tenantRef;
        const members = await tenantStore.listPoolMembers({ tenantRef, pool, visibility: 'shared' });
        if (members.length === 0) throw new SlotlockAgentOperationError('pool_not_found', 404);
        // Busy time as edges: a count of busy members that rises and falls.
        const edges = new Map<number, number>([
          [window.start.getTime(), 0],
          [window.end.getTime(), 0],
        ]);
        let complete = true;
        const enforced = members.filter((member) => member.effectiveBookingRules?.enforceHours === true);
        const memberHours =
          enforced.length > 0 ? await hoursWithin(tenantStore, context, enforced, window, options) : new Map();
        for (const member of members) {
          const sources = await requiredSources(options, context, member);
          const freeBusy = await readFreeBusy(tenantStore, {
            tenantRef,
            resourceId: member.id,
            window,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: options.coverageMaxAgeMs }
              : {}),
          });
          charge(freeBusy.busy.length);
          if (freeBusy.coverage.state !== 'complete') complete = false;
          // Also not free where its booking rules refuse a booking (notice, advance, enforced
          // hours). Its slot step is not counted: it moves when a booking may start, not whether
          // the member is free.
          const rules = member.effectiveBookingRules;
          const search = bookingSearch({ rules, timezone: member.timezone, window, now });
          const latestStart =
            rules?.maxAdvanceDays !== undefined
              ? now.getTime() + rules.maxAdvanceDays * 86_400_000
              : window.end.getTime();
          let open: Interval[] = search
            ? [{ start: search.window.start, end: new Date(Math.min(search.window.end.getTime(), latestStart)) }]
            : [];
          if (rules?.enforceHours === true && open.length > 0) {
            const windows: Interval[] = memberHours.get(member.id) ?? [];
            windowsLeft -= windows.length;
            if (windowsLeft < 0) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
            open = windows.flatMap((hoursWindow) => {
              const start = Math.max(hoursWindow.start.getTime(), (open[0] as Interval).start.getTime());
              const end = Math.min(hoursWindow.end.getTime(), (open[0] as Interval).end.getTime());
              return end > start ? [{ start: new Date(start), end: new Date(end) }] : [];
            });
          }
          const closed: Interval[] = [];
          let from = window.start.getTime();
          for (const part of mergeIntervals(open.filter((part) => part.end > part.start))) {
            if (part.start.getTime() > from) closed.push({ start: new Date(from), end: part.start });
            from = Math.max(from, part.end.getTime());
          }
          if (from < window.end.getTime()) closed.push({ start: new Date(from), end: window.end });
          for (const taken of mergeIntervals([...freeBusy.busy, ...closed])) {
            edges.set(taken.start.getTime(), (edges.get(taken.start.getTime()) ?? 0) + 1);
            edges.set(taken.end.getTime(), (edges.get(taken.end.getTime()) ?? 0) - 1);
          }
        }
        const times = [...edges.keys()].sort((a, b) => a - b);
        const intervals: { start: string; end: string; free: number }[] = [];
        let busy = 0;
        for (const [index, at] of times.entries()) {
          busy += edges.get(at) ?? 0;
          const next = times[index + 1];
          if (next === undefined || at >= window.end.getTime()) break;
          const free = members.length - busy;
          const last = intervals.at(-1);
          if (last && last.free === free) last.end = new Date(next).toISOString();
          else intervals.push({ start: new Date(at).toISOString(), end: new Date(next).toISOString(), free });
        }
        return {
          pool,
          members: members.length,
          intervals,
          coverage: coverageProjection(window, complete),
        };
      });
    },

    async bookTogether(context, rawInput) {
      const input = rawInput as {
        resource_ids: string[];
        starts_at: string;
        ends_at: string;
        timezone: string;
        title?: string;
        idempotency_key: string;
        hold_group_id?: string;
      };
      // Sorted, so bundles over the same resources lock in one order and never deadlock.
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
        // A set held together (RFC 0004 B7) is booked from its holds: each must be the agent's, live,
        // and for exactly this time.
        const held = new Map<string, string>();
        if (input.hold_group_id !== undefined) {
          const holds = await tenantStore.holdGroup({
            tenantRef: context.principal.tenantRef,
            holderRef: agentOwnerRef(context),
            groupId: input.hold_group_id,
          });
          for (const hold of holds) held.set(hold.resourceId, hold.holdId);
        }
        const events: Record<string, unknown>[] = [];
        let replayed = true;
        for (const resourceId of resourceIds) {
          const key = `${input.idempotency_key}\0${resourceId}`;
          const holdId = held.get(resourceId);
          const result = await tenantStore.putCalendarEvent({
            ...(holdId !== undefined ? { fromHold: { holdId, holderRef: agentOwnerRef(context) } } : {}),
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
          // Thrown, so the whole transaction rolls back with the events already put.
          if (!result.ok) {
            const refusal = operationError(result);
            throw new SlotlockAgentOperationError(refusal.code, refusal.status, {
              resource_id: resourceId,
              ...(await overlapDetails(tenantStore, context, result)),
            });
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

    async confirmHold(this: SlotlockAgentCalendarBackend, context, rawInput) {
      const input = rawInput as {
        hold_id: string;
        title?: string;
        description?: string;
        location?: string;
        timezone?: string;
        idempotency_key: string;
      };
      // The holder's own hold, lapsed or live, and its resource's zone; then the booking exactly
      // as create_event with its hold_id makes it, which judges the hold again under its lock.
      const found = await withTenant(store, context, async (tenantStore) => {
        const held = await tenantStore.getHolderHold({
          tenantRef: context.principal.tenantRef,
          holdId: input.hold_id,
          holderRef: agentOwnerRef(context),
        });
        if (!held) return null;
        const resource = await requireAgentResource(tenantStore, context.principal.tenantRef, held.hold.resourceId);
        return { ...held, timezone: resource.timezone };
      });
      if (!found) {
        // Booked already: a retry answers the event this key made (the store compares the
        // request, so another one with the same key is idempotency_conflict).
        const booked = await withTenant(store, context, (tenantStore) =>
          tenantStore.getCalendarEvent({
            tenantRef: context.principal.tenantRef,
            ownerRef: agentOwnerRef(context),
            externalRef: agentExternalRef(context, input.idempotency_key),
          }),
        );
        if (!booked) throw new SlotlockAgentOperationError('hold_not_found', 404);
        return this.createEvent(
          { ...context, operation: 'slotlock_create_event' },
          {
            resource_id: booked.resourceId,
            starts_at: booked.start.toISOString(),
            ends_at: booked.end.toISOString(),
            timezone: input.timezone ?? booked.timezone,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            transparency: 'opaque',
            status: 'confirmed',
            hold_id: input.hold_id,
            idempotency_key: input.idempotency_key,
          },
        );
      }
      if (!found.live) throw new SlotlockAgentOperationError('hold_expired', 409);
      return this.createEvent(
        { ...context, operation: 'slotlock_create_event' },
        {
          resource_id: found.hold.resourceId,
          starts_at: found.hold.start.toISOString(),
          ends_at: found.hold.end.toISOString(),
          timezone: input.timezone ?? found.timezone,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          transparency: 'opaque',
          status: 'confirmed',
          hold_id: input.hold_id,
          idempotency_key: input.idempotency_key,
        },
      );
    },

    async releaseSlots(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) return { released: false };
      const result = await withTenant(store, context, async (tenantStore) =>
        tenantStore.releaseHold(id, {
          tenantRef: context.principal.tenantRef,
          holderRef: agentOwnerRef(context),
        }).then(({ released }) => ({ released })),
      );
      if (result.released) await offerFreedTime(store, context);
      return result;
    },

    async describeResource(context, resourceId) {
      if (!STORE_ID_PATTERN.test(resourceId)) return null;
      return withTenant(store, context, async (tenantStore) => {
        const resource = await tenantStore.getResource({
          tenantRef: context.principal.tenantRef,
          id: resourceId,
          visibility: 'shared',
        });
        // Its profile's name when it has one, as a person reading a confirmation knows it.
        return resource
          ? { name: resource.name ?? resource.externalRef ?? null, timezone: resource.timezone }
          : null;
      });
    },

    async selectResources(context, selection) {
      return withTenant(store, context, async (tenantStore) => {
        let resources: SlotlockResource[];
        try {
          // Shared and in use, as an agent may search them, in the store's stable order.
          resources = await tenantStore.listResources({
            tenantRef: context.principal.tenantRef,
            visibility: 'shared',
            limit: selection.limit + 1,
            ...(selection.kind !== undefined ? { kind: selection.kind as SlotlockResourceKind } : {}),
            ...(selection.labels !== undefined ? { labels: selection.labels } : {}),
            ...(selection.location !== undefined ? { location: selection.location } : {}),
            ...(selection.group !== undefined ? { group: selection.group } : {}),
            ...(selection.pool !== undefined ? { pool: selection.pool } : {}),
          });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (resources.length > selection.limit) {
          throw new SlotlockAgentOperationError('selection_too_large', 400, { limit: String(selection.limit) });
        }
        return resources.map((resource) => resource.id);
      });
    },

    async listResources(context, input) {
      const cursor = parseResourceCursor(input.cursor);
      const kind = input.kind as SlotlockResource['kind'] | 'other' | undefined;
      const labels = input.labels as string[] | undefined;
      const location = input.location as string | undefined;
      const group = input.group as string | undefined;
      let words: string[] | undefined;
      try {
        words = typeof input.query === 'string' ? slotlockResourceSearchWords(input.query) : undefined;
      } catch {
        throw new SlotlockAgentOperationError('invalid_arguments', 400);
      }
      // What a resource says about itself, for an agent to show and choose by; its attributes are
      // the integrator's, and stay on the application API.
      const output = (resource: SlotlockResource) => ({
        id: resource.id,
        external_ref: resource.externalRef,
        timezone: resource.timezone,
        ...(resource.pool !== undefined ? { pool: resource.pool } : {}),
        ...(resource.name !== undefined ? { name: resource.name } : {}),
        ...(resource.description !== undefined
          ? {
              description:
                [...resource.description].length > 500
                  ? `${[...resource.description].slice(0, 500).join('')}…`
                  : resource.description,
            }
          : {}),
        ...(resource.kind !== undefined ? { kind: resource.kind } : {}),
        ...(resource.capacity !== undefined ? { capacity: resource.capacity } : {}),
        ...(resource.labels !== undefined ? { labels: resource.labels } : {}),
        ...(resource.location !== undefined
          ? { location: { ref: resource.location, name: resource.locationName ?? resource.location } }
          : {}),
        ...(resource.groups !== undefined ? { groups: resource.groups } : {}),
        ...(resource.parentId !== undefined ? { part_of: resource.parentId } : {}),
      });
      if (typeof input.pool === 'string') {
        return withTenant(store, context, async (tenantStore) => {
          // A pool's members are filtered here: a location filter takes the locations under it.
          const places =
            location === undefined
              ? null
              : locationAndBelow(await tenantStore.listLocations({ tenantRef: context.principal.tenantRef }), location);
          const members = (
            await tenantStore.listPoolMembers({
              tenantRef: context.principal.tenantRef,
              pool: input.pool as string,
              visibility: 'shared',
            })
          ).filter(
            (resource) =>
              (kind === undefined || (resource.kind ?? 'other') === kind) &&
              (labels === undefined || slotlockResourceHasLabels(resource.labels, labels)) &&
              (places === null || (resource.location !== undefined && places.has(resource.location))) &&
              (group === undefined || resource.groups?.includes(group) === true),
          );
          // Searched, the best matches first; else in the order slotlock_book_pool tries them.
          const shown =
            words === undefined
              ? members
              : slotlockSearchResources(members, words)
                  .slice(0, input.limit as number)
                  .map((match) => match.resource);
          return { resources: shown.map(output), next_cursor: null };
        });
      }
      if (words !== undefined) {
        // A search ranks every resource the filters allow (as many as a tenant may have), best first.
        return withTenant(store, context, async (tenantStore) => {
          const candidates = await sharedResources(tenantStore, context.principal.tenantRef, {
            ...(kind !== undefined ? { kind } : {}),
            ...(labels !== undefined ? { labels } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(group !== undefined ? { group } : {}),
          });
          const best = slotlockSearchResources(candidates, words).slice(0, input.limit as number);
          return { resources: best.map((match) => output(match.resource)), next_cursor: null };
        });
      }
      return withTenant(store, context, async (tenantStore) => {
        const limit = input.limit as number;
        const resources = await tenantStore.listResources({
          tenantRef: context.principal.tenantRef,
          visibility: 'shared',
          limit: limit + 1,
          ...(cursor !== undefined ? { after: cursor } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(labels !== undefined ? { labels } : {}),
          ...(location !== undefined ? { location } : {}),
          ...(group !== undefined ? { group } : {}),
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

    async findNextSlots(context, input) {
      const window = interval(input);
      const durationMs = input.duration_minutes * 60_000;
      const charge = busyBudget();
      return withTenant(store, context, async (tenantStore) => {
        const resource = await requireAgentResource(tenantStore, context.principal.tenantRef, input.resource_id);
        const search = bookingSearch({
          rules: resource.effectiveBookingRules,
          timezone: resource.timezone,
          window,
          now: new Date(),
          durationMs,
        });
        const sources = await requiredSources(options, context, resource);
        const freeBusy = await readFreeBusy(tenantStore, {
          tenantRef: context.principal.tenantRef,
          resourceId: input.resource_id,
          window: search ? bookingSearchReach({ ...search, window }) : window,
          requiredSources: [...sources],
          ...(options.coverageMaxAgeMs !== undefined ? { coverageMaxAgeMs: options.coverageMaxAgeMs } : {}),
        });
        charge(freeBusy.busy.length);
        if (freeBusy.coverage.state !== 'complete') return { slots: [], certain: false };
        if (!search) return { slots: [], certain: true };
        // Where the hours hold a hire only at its ends (hoursApply), a slot may run from one local
        // day to another: each from the range search, judged as a write of it is.
        if (hoursApplyOf(resource.effectiveBookingRules) === 'ends') {
          const ranged = await rangedSlots(tenantStore, context, resource, window, search.window.start.getTime(), durationMs, freeBusy.busy, input.limit, options.availabilityRules);
          return { slots: ranged.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })), certain: true };
        }
        const windows =
          (await hoursWithin(tenantStore, context, [resource], search.window, options)).get(resource.id) ?? [];
        if (windows.length > MAX_REQUEST_RULE_WINDOWS) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
        const busy = bookingSearchBlocked(freeBusy.busy, search);
        // Each next slot as a search from where the last one ended would find it: the same busy
        // time and hours, with the hours before that end left out.
        const slots: { start: string; end: string }[] = [];
        let from = search.window.start.getTime();
        while (slots.length < input.limit) {
          const open = windows
            .map((hours) => ({ start: new Date(Math.max(hours.start.getTime(), from)), end: hours.end }))
            .filter((hours) => hours.end.getTime() - hours.start.getTime() >= durationMs);
          const found = findNextAvailable({ busy, windows: open, durationMs, ...(search.align ? { align: search.align } : {}) });
          if (!found) break;
          slots.push({ start: found.start.toISOString(), end: found.end.toISOString() });
          from = found.end.getTime();
        }
        return { slots, certain: true };
      });
    },

    async defaultDuration(context, resourceIds) {
      return withTenant(store, context, async (tenantStore) => {
        const lengths = new Set<number | undefined>();
        for (const resourceId of resourceIds) {
          const resource = await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
          lengths.add(resource.effectiveBookingRules?.defaultDurationMinutes);
        }
        const [only] = [...lengths];
        return lengths.size === 1 && only !== undefined ? only : null;
      });
    },

    async findAvailableRanges(context, input) {
      const tenantRef = context.principal.tenantRef;
      const pickup = { start: new Date(input.pickup_start as string), end: new Date(input.pickup_end as string) };
      const days = input.days as number | undefined;
      const back =
        input.return_start !== undefined
          ? { start: new Date(input.return_start as string), end: new Date(input.return_end as string) }
          : undefined;
      const limit = input.limit as number;
      const charge = busyBudget();
      const now = new Date();
      return withTenant(store, context, async (tenantStore) => {
        let resources: SlotlockResource[];
        if (typeof input.pool === 'string') {
          resources = await tenantStore.listPoolMembers({ tenantRef, pool: input.pool, visibility: 'shared', ordered: true });
          if (resources.length === 0) throw new SlotlockAgentOperationError('pool_not_found', 404);
          resources = resources.slice(0, 100);
        } else {
          resources = [];
          for (const resourceId of distinctResourceIds(input)) {
            resources.push(await requireAgentResource(tenantStore, tenantRef, resourceId));
          }
        }
        // What a range may reach: the pick-up window, the longest it may run, and its buffers.
        const lastEnd = back ? back.end.getTime() : pickup.end.getTime() + ((days ?? 1) + 1) * 86_400_000;
        const reach = { start: new Date(pickup.start.getTime() - 86_400_000), end: new Date(lastEnd + 8 * 86_400_000) };
        const exceptions = await tenantStore.availabilityExceptionsFor({
          tenantRef,
          resourceIds: resources.map((resource) => resource.id),
          window: reach,
        });
        const ranges: { resource_id: string; start: string; end: string }[] = [];
        let complete = true;
        for (const resource of resources) {
          const sources = await requiredSources(options, context, resource);
          const freeBusy = await readFreeBusy(tenantStore, {
            tenantRef,
            resourceId: resource.id,
            window: reach,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined ? { coverageMaxAgeMs: options.coverageMaxAgeMs } : {}),
          });
          charge(freeBusy.busy.length);
          if (freeBusy.coverage.state !== 'complete') {
            complete = false;
            continue;
          }
          const fallback =
            resource.availabilityRules === undefined && resource.inheritedAvailability === undefined
              ? await options.availabilityRules(context, resource)
              : [];
          const found = findEarliestRange({
            busy: freeBusy.busy,
            rules: resource.effectiveBookingRules,
            timezone: resource.timezone,
            hours: applicableHours(resource, fallback).rules,
            exceptions: exceptions.get(resource.id) ?? [],
            now,
            pickup,
            ...(back ? { return: back } : {}),
            ...(days !== undefined ? { days } : {}),
          });
          if (found) ranges.push({ resource_id: resource.id, start: found.start.toISOString(), end: found.end.toISOString() });
        }
        const window = { start: pickup.start, end: new Date(lastEnd) };
        const answer = {
          ranges: complete
            ? ranges
                .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.resource_id.localeCompare(b.resource_id))
                .slice(0, limit)
            : [],
          coverage: coverageProjection(window, complete),
        };
        return typeof input.pool === 'string'
          ? { ...answer, selected_resource_ids: resources.map((resource) => resource.id) }
          : answer;
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
          // The resource's booking rules bound the search, as they bound the write that follows.
          const search = bookingSearch({
            rules: resource.effectiveBookingRules,
            timezone: resource.timezone,
            window,
            now: new Date(),
            durationMs,
          });
          const sources = await requiredSources(options, context, resource);
          const freeBusy = await readFreeBusy(tenantStore, {
            tenantRef: context.principal.tenantRef,
            resourceId,
            // A slot's buffers may run past the window: what they reach must be free too.
            window: search ? bookingSearchReach({ ...search, window }) : window,
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
          let candidate: Interval | null;
          if (hoursApplyOf(resource.effectiveBookingRules) === 'ends') {
            // A slot may run from one local day to another: the range search's earliest.
            [candidate = null] = await rangedSlots(tenantStore, context, resource, window, search.window.start.getTime(), durationMs, freeBusy.busy, 1, options.availabilityRules);
          } else {
            const windows =
              (await hoursWithin(tenantStore, context, [resource], search.window, options)).get(resource.id) ?? [];
            windowsLeft -= windows.length;
            if (windowsLeft < 0) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
            candidate = findNextAvailable({
              busy: bookingSearchBlocked(freeBusy.busy, search),
              windows,
              durationMs,
              ...(search.align ? { align: search.align } : {}),
            });
          }
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
        // A cross-resource answer is only certain when every resource is: one healthy calendar must
        // not mask a stale one.
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
          // Tell no one about it (RFC 0004 P3).
          ...(input.notify === false ? { notify: false } : {}),
        });
        if (!result.ok) throw operationError(result, await overlapDetails(tenantStore, context, result));
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
      if (
        input.expected_resource_id !== undefined &&
        !STORE_ID_PATTERN.test(input.expected_resource_id)
      ) {
        throw new SlotlockAgentOperationError('event_not_found', 404);
      }
      const moved = await withTenant(store, context, async (tenantStore) => {
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
          // The caller's fence when sent, checked under the event's lock; otherwise the resource
          // just read, so a move in between is not overwritten.
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
        if (!result.ok) throw operationError(result, await overlapDetails(tenantStore, context, result));
        const updated = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: result.externalRef,
        });
        if (!updated) throw new SlotlockAgentOperationError('store_inconsistent', 503);
        return { event: projectSlotlockCalendarEvent(updated), replayed: result.idempotent };
      }, WRITE);
      if (!moved.replayed) await offerFreedTime(store, context);
      return moved;
    },

    async deleteEvent(context, input) {
      const deleted = await withTenant(store, context, async (tenantStore) => {
        const externalRef = input.event_id as string;
        const current = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef,
        });
        // Gone already: a retry of a cancellation that succeeded, answered from its key, or
        // event_not_found from the store when there was none.
        const result = await tenantStore.cancelCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef,
          ...(current ? { expectedResourceId: current.resourceId } : {}),
          idempotencyKey: agentCommandIdempotencyKey(context, input.idempotency_key as string),
          expectedRevision: input.expected_revision as number,
          // An agent is held to the resource's cancel cutoff (RFC 0004 B5).
          enforceBookingRules: true,
        });
        if (!result.ok) throw operationError(result);
        return {
          event_id: externalRef,
          revision: result.revision,
          deleted: true,
          replayed: result.idempotent,
        };
      }, WRITE);
      if (!deleted.replayed) await offerFreedTime(store, context);
      return deleted;
    },
  };
  return withApprovalPolicies(store, options, maxApprovalMinutes, backend);
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
  /**
   * The partner API (RFC 0003 P3): the partner store (partners.ts) its operations run through, for
   * the partner a partner key names. Unset: they answer 404 partner_api_not_served.
   */
  partners?: SlotlockPartnerStore;
  /**
   * The agent backend (`createSlotlockStoreAgentBackend`) a granted approval's booking is made
   * through (RFC 0004 A4), as the agent that asked. Unset: a grant answers 409
   * approvals_unavailable; declining still works.
   */
  agentBackend?: SlotlockAgentCalendarBackend;
  /**
   * How `slotlock_import_holidays` fetches a calendar's url (RFC 0004 B1): give it a fetch that
   * refuses private addresses (`createSlotlockGuardedFetch`). Unset: a url answers 400
   * holiday_url_not_served and only the calendar's text is read.
   */
  holidayFetch?: typeof fetch;
}

/** An exception as the API answers it. */
function exceptionOutput(exception: SlotlockAvailabilityException) {
  return {
    id: exception.id,
    location: exception.location ?? null,
    resource_id: exception.resourceId ?? null,
    starts_on: exception.startsOn,
    ends_on: exception.endsOn,
    outcome: exception.outcome,
    hours:
      exception.hours?.map((window) => ({ start_minutes: window.startMinutes, duration_minutes: window.durationMinutes })) ??
      null,
    label: exception.label,
    source: exception.source,
    calendar_id: exception.calendarId ?? null,
    created_at: exception.createdAt.toISOString(),
  };
}

function holidayCalendarOutput(calendar: SlotlockHolidayCalendar) {
  return {
    calendar_id: calendar.id,
    name: calendar.name,
    location: calendar.location ?? null,
    resource_id: calendar.resourceId ?? null,
    url: calendar.url ?? null,
    imported_at: calendar.importedAt?.toISOString() ?? null,
    next_import_at: calendar.nextImportAt?.toISOString() ?? null,
    last_error: calendar.lastError ?? null,
    closures: calendar.closures,
    created_at: calendar.createdAt.toISOString(),
  };
}

/** Days the exports and imports of hours reach: a year on from yesterday. */
function exportDays(): { from: string; to: string } {
  const today = Math.floor(Date.now() / 86_400_000);
  return { from: dayToDate(today - 1), to: dayToDate(today + 366) };
}

function storeRefusal(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return error;
  if (code === 'invalid_resource_profile' || code === 'invalid_location' || code === 'invalid_group') {
    // Which field, so a client can say what to change.
    const field = (error as { field?: unknown }).field;
    return new SlotlockAgentOperationError(code, 400, typeof field === 'string' ? { field } : undefined);
  }
  if (code === 'location_not_found' || code === 'group_not_found' || code === 'resource_not_found' || code === 'parent_not_found') {
    return new SlotlockAgentOperationError(code, 404);
  }
  if (
    code === 'location_in_use' ||
    code === 'location_too_deep' ||
    code === 'location_cycle' ||
    code === 'location_limit_reached' ||
    code === 'group_limit_reached' ||
    code === 'resource_group_limit_reached'
  ) {
    return new SlotlockAgentOperationError(code, 409);
  }
  if (
    code === 'resource_limit_reached' ||
    code === 'resource_visibility_conflict' ||
    code === 'pool_rules_limit_reached' ||
    code === 'pool_order_limit_reached' ||
    code === 'composite_too_deep' ||
    code === 'composite_parts_limit' ||
    code === 'composite_busy' ||
    code === 'availability_exceptions_limit_reached'
  ) {
    return new SlotlockAgentOperationError(code, 409);
  }
  if (code === 'holiday_calendar_unreachable') return new SlotlockAgentOperationError(code, 400);
  if (code.startsWith('invalid_') && code !== 'invalid_transaction_isolation') {
    return new SlotlockAgentOperationError(code, 400);
  }
  return error;
}

/** A key's limits as the API takes them (snake_case), as the key store takes them. */
function keyLimitsFromInput(value: unknown) {
  const given = value as { max_holds?: number; max_held_hours?: number; requests_per_minute?: number; requires_approval?: boolean };
  return {
    ...(given.max_holds !== undefined ? { maxHolds: given.max_holds } : {}),
    ...(given.max_held_hours !== undefined ? { maxHeldHours: given.max_held_hours } : {}),
    ...(given.requests_per_minute !== undefined ? { requestsPerMinute: given.requests_per_minute } : {}),
    ...(given.requires_approval === true ? { requiresApproval: true } : {}),
  };
}

/** A sandbox refusal as the API answers it: 403 for a live tenant, 409 for one not empty. */
function sandboxRefusal(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'sandbox_test_only') return new SlotlockAgentOperationError(code, 403);
  if (code === 'sandbox_not_empty') return new SlotlockAgentOperationError(code, 409);
  return error;
}

/** An approval decision refused: 404 for none, 409 for one decided or past its wait. */
function approvalRefusal(code: 'approval_not_found' | 'approval_not_pending' | 'approval_expired'): SlotlockAgentOperationError {
  return new SlotlockAgentOperationError(code, code === 'approval_not_found' ? 404 : 409);
}

function approvalPolicyOutput(policy: SlotlockApprovalPolicy) {
  const applies = policy.appliesTo;
  const conditions = policy.conditions;
  return {
    policy_ref: policy.ref,
    name: policy.name,
    applies_to: {
      ...(applies.resourceIds ? { resource_ids: applies.resourceIds } : {}),
      ...(applies.pools ? { pools: applies.pools } : {}),
      ...(applies.locations ? { locations: applies.locations } : {}),
      ...(applies.groups ? { groups: applies.groups } : {}),
    },
    conditions: {
      ...(conditions.longerThanMinutes !== undefined ? { longer_than_minutes: conditions.longerThanMinutes } : {}),
      ...(conditions.outsideHours !== undefined ? { outside_hours: conditions.outsideHours } : {}),
      ...(conditions.kinds ? { kinds: conditions.kinds } : {}),
    },
    outcome: policy.outcome,
    approval_ttl_minutes: policy.approvalTtlMinutes,
    lead_minutes: policy.leadMinutes,
    include_application: policy.includeApplication,
    created_at: policy.createdAt.toISOString(),
    updated_at: policy.updatedAt.toISOString(),
  };
}

function approvalAppliesTo(value: unknown): SlotlockApprovalPolicy['appliesTo'] {
  const given = value as { resource_ids?: string[]; pools?: string[]; locations?: string[]; groups?: string[] };
  return {
    ...(given.resource_ids ? { resourceIds: given.resource_ids } : {}),
    ...(given.pools ? { pools: given.pools } : {}),
    ...(given.locations ? { locations: given.locations } : {}),
    ...(given.groups ? { groups: given.groups } : {}),
  };
}

function approvalConditions(value: unknown): SlotlockApprovalPolicy['conditions'] {
  const given = value as { longer_than_minutes?: number; outside_hours?: boolean; kinds?: SlotlockApprovalKind[] };
  return {
    ...(given.longer_than_minutes !== undefined ? { longerThanMinutes: given.longer_than_minutes } : {}),
    ...(given.outside_hours !== undefined ? { outsideHours: given.outside_hours } : {}),
    ...(given.kinds ? { kinds: given.kinds } : {}),
  };
}

function approvalOutput(approval: SlotlockApproval) {
  return {
    approval_id: approval.id,
    policy_ref: approval.policyRef,
    status: approval.status,
    operation: approval.operation,
    request: approval.request,
    requested_by: approval.requestedBy,
    resource_ids: approval.resourceIds,
    starts_at: approval.start.toISOString(),
    ends_at: approval.end.toISOString(),
    expires_at: approval.expiresAt.toISOString(),
    decided_by: approval.decidedBy,
    decided_at: approval.decidedAt?.toISOString() ?? null,
    reason: approval.reason,
    created_at: approval.createdAt.toISOString(),
  };
}

/** A store refusal as the application API answers it, a broken booking rule by its own code. */
function applicationRuleRefusal(result: { code: string; rule?: string }): SlotlockAgentOperationError {
  return result.code === 'booking_rule_violated' && result.rule
    ? new SlotlockAgentOperationError(`booking_rule_${result.rule}`, 409)
    : applicationRefusal(result.code);
}

/** A recorded cancellation fee as the API answers it (RFC 0004 B5). */
function feeOutput(fee: { amountMinor: number; currency: string } | undefined) {
  return fee ? { amount_minor: fee.amountMinor, currency: fee.currency } : null;
}

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
    duration_minutes: entry.durationMs === null ? null : Math.round(entry.durationMs / 60_000),
    decided_at: entry.decidedAt?.toISOString() ?? null,
    created_at: entry.createdAt.toISOString(),
  };
}

/** Occupied time as eventOccupancy reads it. */
interface Occupation {
  resourceId: string;
  start: Date;
  end: Date;
  recurring: boolean;
}

/** The writes a policy can hold for a person, and the operation each is kept as. */
type GatedOperation = 'slotlock_create_event' | 'slotlock_book_pool' | 'slotlock_book_together' | 'slotlock_update_event';

/** What one write asks, for its policies: found before it is tried. */
interface ApprovalPlan {
  kind: SlotlockApprovalKind;
  stored: SlotlockApproval['operation'];
  /** The resources it may take: a pool's members, before one is chosen. */
  resourceIds: string[];
  /** The events it writes, by external reference, to read what they occupy. */
  externalRefs: string[];
  start: Date;
  end: Date;
  series: boolean;
  /** A move's event as it is: its own time is not held again. */
  before: Occupation[];
  consumeHold?: { holdId: string; holderRef: string };
  pool?: string;
  policies: SlotlockApprovalPolicy[];
  /** The key's own approval (RFC 0004 A5), beside the tenant's policies. */
  keyPolicy?: SlotlockApprovalPolicy;
}

/**
 * The policy a key whose bookings wait for a person (`requiresApproval`, RFC 0004 A5) is held by:
 * every resource, a day's wait. A tenant cannot name a policy of its own `api-key`.
 */
function keyApprovalPolicy(): SlotlockApprovalPolicy {
  return {
    ref: SLOTLOCK_KEY_APPROVAL_POLICY,
    name: 'Bookings by this API key',
    appliesTo: {},
    conditions: {},
    outcome: 'require_approval',
    approvalTtlMinutes: SLOTLOCK_DEFAULT_APPROVAL_MINUTES,
    leadMinutes: 0,
    // The key's own approval holds whatever it books, for the tenant too.
    includeApplication: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A JSON value with its object keys sorted, so two requests compare by content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Each interval of `wanted` less the parts `kept` already covers on the same resource. */
function uncovered(wanted: readonly Occupation[], kept: readonly Occupation[]): (Interval & { resourceId: string })[] {
  const pieces: (Interval & { resourceId: string })[] = [];
  for (const want of wanted) {
    let open: Interval[] = [{ start: want.start, end: want.end }];
    for (const own of kept) {
      if (own.resourceId !== want.resourceId) continue;
      open = open.flatMap((piece) => {
        if (own.end <= piece.start || own.start >= piece.end) return [piece];
        return [
          ...(own.start > piece.start ? [{ start: piece.start, end: own.start }] : []),
          ...(own.end < piece.end ? [{ start: own.end, end: piece.end }] : []),
        ];
      });
    }
    pieces.push(...open.map((piece) => ({ ...piece, resourceId: want.resourceId })));
  }
  return pieces;
}

/** How a request already put to a person answers its retry: waiting, declined or expired. */
function approvalAnswer(approval: SlotlockApproval): SlotlockAgentOperationError {
  const id = { approval_id: approval.id, policy_ref: approval.policyRef };
  if (approval.status === 'declined') {
    return new SlotlockAgentOperationError('approval_declined', 403, {
      ...id,
      ...(approval.reason ? { reason: approval.reason.slice(0, 200) } : {}),
    });
  }
  if (approval.status === 'expired' || approval.expiresAt.getTime() <= Date.now()) {
    return new SlotlockAgentOperationError('approval_expired', 409, id);
  }
  return new SlotlockAgentOperationError('approval_pending', 409, {
    ...id,
    expires_at: approval.expiresAt.toISOString(),
  });
}

/**
 * Approval policies (RFC 0004 A4) in front of the backend's writes. A write a policy covers is
 * tried first as a dry run, so it meets every check and the database's constraints as it would;
 * a `refuse` policy then refuses it, and a `require_approval` one holds the exact time it would
 * occupy for the approval and answers `approval_pending`. A retry with the same idempotency key
 * answers as the request stands, and once granted, with the booking itself. Tenants with no policy
 * pay one indexed read per write.
 */
function withApprovalPolicies(
  store: SlotlockStore,
  options: SlotlockStoreAgentBackendOptions,
  maxApprovalMinutes: number,
  backend: SlotlockAgentCalendarBackend,
): SlotlockAgentCalendarBackend {
  type Method = (
    this: SlotlockAgentCalendarBackend,
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  const requestKeyOf = (context: SlotlockAgentInvocationContext, stored: string, key: string) =>
    createHash('sha256')
      .update(JSON.stringify(['slotlock-approval', context.principal.tenantRef, agentOwnerRef(context), stored, key]))
      .digest('hex');

  /** Whether [start, end) on the resource falls outside its bookable hours. */
  async function outsideHours(
    tenantStore: SlotlockTenantStore,
    context: SlotlockAgentInvocationContext,
    resourceId: string,
    start: Date,
    end: Date,
  ): Promise<boolean> {
    const resource = await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
    const reach = { start: new Date(start.getTime() - 86_400_000), end: new Date(end.getTime() + 86_400_000) };
    const windows = (await hoursWithin(tenantStore, context, [resource], reach, options)).get(resource.id) ?? [];
    return !coveredByOpenWindows(windows, { start, end });
  }

  /**
   * What an update may change without booking any time: everything else (time, resource, zone,
   * transparency, status, recurrence and its exceptions) is judged by what it would add.
   */
  const EVENT_DETAIL_FIELDS: ReadonlySet<string> = new Set([
    'event_id',
    'expected_revision',
    'expected_resource_id',
    'idempotency_key',
    'title',
    'description',
    'location',
    'organizer',
    'attendees',
    'reminders',
  ]);

  /** The write's ask and the policies that may cover it, or null when none can. */
  async function plan(
    tenantStore: SlotlockTenantStore,
    context: SlotlockAgentInvocationContext,
    operation: GatedOperation,
    input: Record<string, unknown>,
  ): Promise<ApprovalPlan | null> {
    const tenantRef = context.principal.tenantRef;
    const ownerRef = agentOwnerRef(context);
    const key = input.idempotency_key as string;
    // A key whose bookings all wait for a person (RFC 0004 A5) is a policy of its own.
    const keyPolicy = context.principal.limits?.requiresApproval === true ? keyApprovalPolicy() : undefined;
    // Most tenants have none: one small indexed read, and nothing else looked up.
    if (!keyPolicy && (await tenantStore.listApprovalPolicies({ tenantRef })).length === 0) return null;
    let asked: Omit<ApprovalPlan, 'policies'>;
    if (operation === 'slotlock_create_event') {
      asked = {
        kind: 'single',
        stored: 'slotlock_create_event',
        resourceIds: [input.resource_id as string],
        externalRefs: [agentExternalRef(context, key)],
        start: new Date(input.starts_at as string),
        end: new Date(input.ends_at as string),
        series: typeof input.recurrence_rule === 'string',
        before: [],
        ...(typeof input.hold_id === 'string' ? { consumeHold: { holdId: input.hold_id, holderRef: ownerRef } } : {}),
      };
    } else if (operation === 'slotlock_book_pool') {
      const members = await tenantStore.listPoolMembers({ tenantRef, pool: input.pool as string, visibility: 'shared' });
      if (members.length === 0) return null;
      asked = {
        kind: 'pool',
        stored: 'slotlock_create_event',
        resourceIds: members.map((member) => member.id),
        externalRefs: [agentExternalRef(context, key)],
        start: new Date(input.starts_at as string),
        end: new Date(input.ends_at as string),
        series: false,
        before: [],
        pool: input.pool as string,
      };
    } else if (operation === 'slotlock_book_together') {
      const resourceIds = [...new Set(input.resource_ids as string[])].sort();
      asked = {
        kind: 'bundle',
        stored: 'slotlock_book_together',
        resourceIds,
        externalRefs: resourceIds.map((resourceId) => agentExternalRef(context, `${key}\0${resourceId}`)),
        start: new Date(input.starts_at as string),
        end: new Date(input.ends_at as string),
        series: false,
        before: [],
      };
    } else {
      const current = await tenantStore.getCalendarEvent({ tenantRef, ownerRef, externalRef: input.event_id as string });
      if (!current) return null;
      // Details alone book nothing. Any other change may: a move, or time the event did not hold
      // (made opaque or confirmed, given occurrences or fewer exceptions, another zone), judged
      // below by what the write would add to what the event holds.
      if (Object.keys(input).every((field) => EVENT_DETAIL_FIELDS.has(field))) return null;
      const resourceId = (input.resource_id as string | undefined) ?? current.resourceId;
      const start = input.starts_at ? new Date(input.starts_at as string) : current.start;
      const end = input.ends_at ? new Date(input.ends_at as string) : current.end;
      const moved =
        resourceId !== current.resourceId || start.getTime() !== current.start.getTime() || end.getTime() !== current.end.getTime();
      asked = {
        // Time added in place is a booking of its own; a move is a move.
        kind: moved ? 'move' : 'single',
        stored: 'slotlock_update_event',
        resourceIds: [resourceId],
        externalRefs: [current.externalRef],
        start,
        end,
        series:
          input.recurrence_rule !== undefined ? typeof input.recurrence_rule === 'string' : current.recurrence !== undefined,
        before: await tenantStore.eventOccupancy({ tenantRef, ownerRef, externalRefs: [current.externalRef] }),
      };
    }
    const minutes = (asked.end.getTime() - asked.start.getTime()) / 60_000;
    // What the ask alone decides; hours wait for the resource the write takes.
    const policies = (await tenantStore.approvalPoliciesFor({ tenantRef, resourceIds: asked.resourceIds })).filter(
      (policy) =>
        // The tenant's own bookings are held only by policies that include the application.
        (!forTenant(context) || policy.includeApplication === true) &&
        (policy.conditions.kinds === undefined || policy.conditions.kinds.includes(asked.kind)) &&
        (policy.conditions.longerThanMinutes === undefined || minutes > policy.conditions.longerThanMinutes),
    );
    if (policies.length === 0 && !keyPolicy) return null;
    return { ...asked, policies, ...(keyPolicy ? { keyPolicy } : {}) };
  }

  function gated(operation: GatedOperation, method: Method): Method {
    return async function (this: SlotlockAgentCalendarBackend, context, input) {
      // The grant itself, or a write a person already approved and its retries.
      if ((context as TenantCallContext)[APPROVAL_GRANT]) return method.call(this, context, input);
      const tenantRef = context.principal.tenantRef;
      const stored = operation === 'slotlock_book_together' || operation === 'slotlock_update_event' ? operation : 'slotlock_create_event';
      const requestKey = requestKeyOf(context, stored, input.idempotency_key as string);
      const asked = await withTenant(store, { ...context, dryRun: false }, async (tenantStore) => {
        const prior = await tenantStore.findApproval({ tenantRef, requestKey });
        if (prior) return { prior };
        return { plan: await plan(tenantStore, context, operation, input) };
      });
      if (asked.prior) {
        const { hold_id: _held, ...request } = input;
        const kept: Record<string, unknown> = { ...asked.prior.request };
        // A pool booking is kept as the member it would take.
        if (operation === 'slotlock_book_pool') delete kept.resource_id;
        // The key answers only the request a person was asked about, granted or not: a grant
        // approves that booking, never another made with its key (a bundle's other resources, say,
        // which the store would take as new).
        if (JSON.stringify(canonical(kept)) !== JSON.stringify(canonical(request))) {
          throw new SlotlockAgentOperationError('idempotency_conflict', 409);
        }
        // Granted: the booking was made with this key, so the write answers it as a replay.
        // Without the hold the approval took over, as the grant made it.
        if (asked.prior.status === 'granted') return method.call(this, context, request);
        throw approvalAnswer(asked.prior);
      }
      const ask = asked.plan;
      if (!ask) return method.call(this, context, input);
      // Tried as a dry run, reading what it would occupy before it is undone: a write that would be
      // refused is refused as it would be.
      let occupied: Occupation[] = [];
      const probed = await method.call(
        this,
        {
          ...context,
          dryRun: true,
          [OCCUPANCY_PROBE]: async (tenantStore: SlotlockTenantStore) => {
            occupied = await tenantStore.eventOccupancy({
              tenantRef,
              ownerRef: agentOwnerRef(context),
              externalRefs: ask.externalRefs,
            });
          },
        } as SlotlockAgentInvocationContext,
        input,
      );
      // Made already (before the policy, say), or takes no time (a transparent event): nothing to hold.
      if (probed.replayed === true || occupied.length === 0) {
        return context.dryRun ? probed : method.call(this, context, input);
      }
      // Only time the event did not already hold needs a person: an edit or a move within its own
      // time books nothing new.
      const holds = uncovered(occupied, ask.before);
      if (holds.length === 0) return context.dryRun ? probed : method.call(this, context, input);
      const written = [...new Set(occupied.map((occupation) => occupation.resourceId))];
      const decided = await withTenant(store, { ...context, dryRun: false }, async (tenantStore) => {
        // A pool's policies are those of the member the write would take, and its pool.
        const candidates = [
          ...(ask.pool
            ? (await tenantStore.approvalPoliciesFor({ tenantRef, resourceIds: written })).filter((policy) =>
                ask.policies.some((known) => known.ref === policy.ref),
              )
            : ask.policies),
          ...(ask.keyPolicy ? [ask.keyPolicy] : []),
        ];
        const applying: SlotlockApprovalPolicy[] = [];
        for (const policy of candidates) {
          if (policy.conditions.outsideHours === true) {
            let outside = false;
            for (const resourceId of written) {
              if (await outsideHours(tenantStore, context, resourceId, ask.start, ask.end)) outside = true;
            }
            if (!outside) continue;
          }
          applying.push(policy);
        }
        return applying;
      });
      if (decided.length === 0) return context.dryRun ? probed : method.call(this, context, input);
      const refusing = decided.find((policy) => policy.outcome === 'refuse');
      if (refusing) throw new SlotlockAgentOperationError('approval_policy_refused', 403, { policy_ref: refusing.ref });
      // The strictest wait: the earliest a person must decide by, under each policy's own wait, its
      // lead before the start, and the server's ceiling.
      const now = Date.now();
      const deadline = (policy: SlotlockApprovalPolicy) =>
        Math.min(
          now + Math.min(policy.approvalTtlMinutes, maxApprovalMinutes) * 60_000,
          ask.start.getTime() - policy.leadMinutes * 60_000,
        );
      const policy = [...decided].sort((left, right) => deadline(left) - deadline(right) || left.ref.localeCompare(right.ref))[0] as SlotlockApprovalPolicy;
      const expiresAt = new Date(deadline(policy));
      if (ask.series || occupied.some((occupation) => occupation.recurring)) {
        throw new SlotlockAgentOperationError('approval_series_unsupported', 409, { policy_ref: policy.ref });
      }
      if (expiresAt.getTime() < now + 60_000) {
        throw new SlotlockAgentOperationError('approval_too_late', 409, { policy_ref: policy.ref });
      }
      if (context.dryRun) {
        throw new SlotlockAgentOperationError('approval_required', 409, {
          policy_ref: policy.ref,
          expires_at: expiresAt.toISOString(),
        });
      }
      const chosen = ask.pool ? written[0] : undefined;
      const { hold_id: _hold, ...request } = input;
      const principal = context.principal;
      const result = await withTenant(store, context, (tenantStore) =>
        tenantStore.requestApproval({
          tenantRef,
          policyRef: policy.ref,
          operation: ask.stored,
          request: canonical(chosen ? { ...request, resource_id: chosen } : request) as Record<string, unknown>,
          requester: {
            subject: principal.subject,
            ...(principal.scopes ? { scopes: [...principal.scopes] } : {}),
            ...(principal.keyId !== undefined ? { key_id: principal.keyId } : {}),
            ...(principal.resourceScope
              ? { resource_scope: { locations: [...principal.resourceScope.locations], groups: [...principal.resourceScope.groups] } }
              : {}),
            ...(context.origin !== undefined ? { origin: context.origin } : {}),
            ...(ask.pool !== undefined ? { pool: ask.pool } : {}),
            // Granted, it is made as the tenant's again, never as the key's agent.
            ...(forTenant(context) ? { for: 'tenant' } : {}),
          },
          requesterRef: principal.subject,
          requestKey,
          holds,
          start: ask.start,
          end: ask.end,
          expiresAt,
          ...(ask.consumeHold ? { consumeHold: ask.consumeHold } : {}),
        }),
      WRITE);
      if (!result.ok) {
        if (result.code === 'approval_limit_reached') {
          throw new SlotlockAgentOperationError('approval_limit_reached', 429, { limit: String(result.limit ?? '') });
        }
        throw new SlotlockAgentOperationError(result.code, 409);
      }
      throw approvalAnswer(result.approval);
    };
  }

  const wrapped: SlotlockAgentCalendarBackend = { ...backend };
  wrapped.createEvent = gated('slotlock_create_event', backend.createEvent as Method);
  wrapped.updateEvent = gated('slotlock_update_event', backend.updateEvent as Method);
  if (backend.bookPool) wrapped.bookPool = gated('slotlock_book_pool', backend.bookPool as Method);
  if (backend.bookTogether) wrapped.bookTogether = gated('slotlock_book_together', backend.bookTogether as Method);
  if (backend.confirmHold) {
    const confirm = backend.confirmHold as Method;
    // A confirm already put to a person answers as it stands, before its hold (now the
    // approval's) is looked for; otherwise it books through createEvent, policies and all.
    wrapped.confirmHold = async function (this: SlotlockAgentCalendarBackend, context, input) {
      if (!(context as TenantCallContext)[APPROVAL_GRANT]) {
        const requestKey = requestKeyOf(context, 'slotlock_create_event', input.idempotency_key as string);
        const prior = await withTenant(store, { ...context, dryRun: false }, (tenantStore) =>
          tenantStore.findApproval({ tenantRef: context.principal.tenantRef, requestKey }),
        );
        if (prior && prior.status !== 'granted') throw approvalAnswer(prior);
      }
      return confirm.call(this, context, input);
    };
  }
  return wrapped;
}

/**
 * Run a granted approval's write as the agent that asked for it, in one transaction with the grant:
 * its holds give way, the write is made, and the approval is marked granted.
 */
export async function runSlotlockApprovalGrant(
  agentBackend: SlotlockAgentCalendarBackend,
  approval: SlotlockApproval & { requester: Record<string, unknown> },
  grant: {
    tenantRef: string;
    decidedBy: string;
    signal: AbortSignal;
    origin?: SlotlockChangeOrigin;
    /** Make the booking and the grant, then roll both back (RFC 0004 A3). */
    dryRun?: boolean;
  },
): Promise<Record<string, unknown>> {
  const requester = approval.requester as {
    subject?: unknown;
    scopes?: unknown;
    key_id?: unknown;
    resource_scope?: { locations?: unknown; groups?: unknown };
    pool?: unknown;
    for?: unknown;
  };
  if (typeof requester.subject !== 'string') throw new SlotlockAgentOperationError('store_inconsistent', 503);
  const scope = requester.resource_scope;
  const context = {
    principal: {
      subject: requester.subject,
      tenantRef: grant.tenantRef,
      ...(Array.isArray(requester.scopes) ? { scopes: requester.scopes as string[] } : {}),
      ...(typeof requester.key_id === 'string' ? { keyId: requester.key_id } : {}),
      ...(scope && Array.isArray(scope.locations) && Array.isArray(scope.groups)
        ? { resourceScope: { locations: scope.locations as string[], groups: scope.groups as string[] } }
        : {}),
    },
    operation: approval.operation,
    signal: grant.signal,
    ...(grant.origin !== undefined ? { origin: grant.origin } : {}),
    ...(grant.dryRun ? { dryRun: true } : {}),
    [APPROVAL_GRANT]: {
      id: approval.id,
      decidedBy: grant.decidedBy,
      ...(typeof requester.pool === 'string' ? { pool: requester.pool } : {}),
    },
    ...(requester.for === 'tenant' ? { [TENANT_ACTOR]: true } : {}),
  } as SlotlockAgentInvocationContext;
  const method =
    approval.operation === 'slotlock_book_together'
      ? agentBackend.bookTogether
      : approval.operation === 'slotlock_update_event'
        ? agentBackend.updateEvent
        : agentBackend.createEvent;
  if (!method) throw new SlotlockAgentOperationError('approvals_unavailable', 409);
  return method.call(agentBackend, context, approval.request);
}

/**
 * Offer what a cancel or release just freed to the waitlist now. Best effort, after commit:
 * maintenance offers whatever this misses.
 */
async function offerFreedTime(store: SlotlockStore, context: TenantCallContext): Promise<void> {
  // A dry run freed nothing.
  if (context.dryRun) return;
  const tenantRef = context.principal.tenantRef;
  try {
    await store.withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef, limit: 20 }), {
      origin: 'maintenance',
    });
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
    filter: endpoint.filter
      ? {
          ...(endpoint.filter.resourceIds ? { resource_ids: endpoint.filter.resourceIds } : {}),
          ...(endpoint.filter.pools ? { pools: endpoint.filter.pools } : {}),
          ...(endpoint.filter.locations ? { locations: endpoint.filter.locations } : {}),
          ...(endpoint.filter.groups ? { groups: endpoint.filter.groups } : {}),
        }
      : null,
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

function bookingRulesOutput(rules: SlotlockBookingRules | undefined) {
  if (!rules) return null;
  return {
    ...(rules.minNoticeMinutes !== undefined ? { min_notice_minutes: rules.minNoticeMinutes } : {}),
    ...(rules.maxAdvanceDays !== undefined ? { max_advance_days: rules.maxAdvanceDays } : {}),
    ...(rules.slotStepMinutes !== undefined ? { slot_step_minutes: rules.slotStepMinutes } : {}),
    ...(rules.stepOffsetMinutes !== undefined ? { step_offset_minutes: rules.stepOffsetMinutes } : {}),
    ...(rules.bufferBeforeMinutes !== undefined ? { buffer_before_minutes: rules.bufferBeforeMinutes } : {}),
    ...(rules.turnaroundMinutes !== undefined ? { turnaround_minutes: rules.turnaroundMinutes } : {}),
    ...(rules.enforceHours !== undefined ? { enforce_hours: rules.enforceHours } : {}),
    ...(rules.checkInMinutes !== undefined ? { check_in_minutes: rules.checkInMinutes } : {}),
    ...(rules.requireCertain !== undefined ? { require_certain: rules.requireCertain } : {}),
    ...(rules.minDurationMinutes !== undefined ? { min_duration_minutes: rules.minDurationMinutes } : {}),
    ...(rules.maxDurationMinutes !== undefined ? { max_duration_minutes: rules.maxDurationMinutes } : {}),
    ...(rules.allowedDurations !== undefined ? { allowed_durations: [...rules.allowedDurations] } : {}),
    ...(rules.defaultDurationMinutes !== undefined ? { default_duration_minutes: rules.defaultDurationMinutes } : {}),
    ...(rules.pickupTimes !== undefined ? { pickup_times: dayWindowsOutput(rules.pickupTimes) } : {}),
    ...(rules.returnTimes !== undefined ? { return_times: dayWindowsOutput(rules.returnTimes) } : {}),
    ...(rules.hoursApply !== undefined ? { hours_apply: rules.hoursApply } : {}),
    ...(rules.cancelCutoffMinutes !== undefined ? { cancel_cutoff_minutes: rules.cancelCutoffMinutes } : {}),
    ...(rules.rescheduleCutoffMinutes !== undefined ? { reschedule_cutoff_minutes: rules.rescheduleCutoffMinutes } : {}),
    ...(rules.cancellationFee !== undefined
      ? {
          cancellation_fee: {
            amount_minor: rules.cancellationFee.amountMinor,
            currency: rules.cancellationFee.currency,
            ...(rules.cancellationFee.withinMinutes !== undefined ? { within_minutes: rules.cancellationFee.withinMinutes } : {}),
          },
        }
      : {}),
  };
}

const dayWindowsOutput = (windows: readonly { startMinutes: number; durationMinutes: number }[]) =>
  windows.map((window) => ({ start_minutes: window.startMinutes, duration_minutes: window.durationMinutes }));
const dayWindowsInput = (value: unknown) =>
  (value as { start_minutes: number; duration_minutes: number }[]).map((window) => ({
    startMinutes: window.start_minutes,
    durationMinutes: window.duration_minutes,
  }));

function bookingRulesInput(value: unknown): SlotlockBookingRules | null {
  if (value === null || value === undefined) return null;
  const input = value as Record<string, unknown>;
  const rules: SlotlockBookingRules = {};
  if (input.min_notice_minutes !== undefined) rules.minNoticeMinutes = input.min_notice_minutes as number;
  if (input.max_advance_days !== undefined) rules.maxAdvanceDays = input.max_advance_days as number;
  if (input.slot_step_minutes !== undefined) rules.slotStepMinutes = input.slot_step_minutes as number;
  if (input.step_offset_minutes !== undefined) rules.stepOffsetMinutes = input.step_offset_minutes as number;
  if (input.buffer_before_minutes !== undefined) {
    rules.bufferBeforeMinutes = input.buffer_before_minutes as number;
  }
  if (input.turnaround_minutes !== undefined) rules.turnaroundMinutes = input.turnaround_minutes as number;
  if (input.enforce_hours !== undefined) rules.enforceHours = input.enforce_hours as boolean;
  if (input.check_in_minutes !== undefined) rules.checkInMinutes = input.check_in_minutes as number;
  if (input.require_certain !== undefined) rules.requireCertain = input.require_certain as boolean;
  if (input.min_duration_minutes !== undefined) rules.minDurationMinutes = input.min_duration_minutes as number;
  if (input.max_duration_minutes !== undefined) rules.maxDurationMinutes = input.max_duration_minutes as number;
  if (input.allowed_durations !== undefined) rules.allowedDurations = [...(input.allowed_durations as number[])];
  if (input.default_duration_minutes !== undefined) {
    rules.defaultDurationMinutes = input.default_duration_minutes as number;
  }
  if (input.pickup_times !== undefined) rules.pickupTimes = dayWindowsInput(input.pickup_times);
  if (input.return_times !== undefined) rules.returnTimes = dayWindowsInput(input.return_times);
  if (input.hours_apply === 'whole' || input.hours_apply === 'ends') rules.hoursApply = input.hours_apply;
  if (input.cancel_cutoff_minutes !== undefined) rules.cancelCutoffMinutes = input.cancel_cutoff_minutes as number;
  if (input.reschedule_cutoff_minutes !== undefined) {
    rules.rescheduleCutoffMinutes = input.reschedule_cutoff_minutes as number;
  }
  if (input.cancellation_fee !== undefined) {
    const fee = input.cancellation_fee as { amount_minor: number; currency: string; within_minutes?: number };
    rules.cancellationFee = {
      amountMinor: fee.amount_minor,
      currency: fee.currency,
      ...(fee.within_minutes !== undefined ? { withinMinutes: fee.within_minutes } : {}),
    };
  }
  return rules;
}

function resourceOutput(resource: SlotlockResource) {
  return {
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
    availability: rulesOutput(resource.availabilityRules),
    booking_rules: bookingRulesOutput(resource.bookingRules),
    effective_booking_rules: bookingRulesOutput(resource.effectiveBookingRules),
    visibility: resource.visibility ?? 'shared',
    archived_at: resource.archivedAt?.toISOString() ?? null,
    pool: resource.pool ?? null,
    name: resource.name ?? null,
    description: resource.description ?? null,
    kind: resource.kind ?? 'other',
    capacity: resource.capacity ?? null,
    labels: resource.labels ?? [],
    attributes: resource.attributes ?? {},
    location: resource.location ?? null,
    groups: resource.groups ?? [],
    parent_id: resource.parentId ?? null,
    inherited_availability: resource.inheritedAvailability
      ? {
          source: resource.inheritedAvailability.source,
          location: resource.inheritedAvailability.location ?? null,
          rules: rulesOutput(resource.inheritedAvailability.rules) ?? [],
        }
      : null,
    part_index: resource.partIndex ?? null,
  };
}

function locationOutput(location: SlotlockLocation) {
  return {
    ref: location.ref,
    name: location.name,
    parent_ref: location.parentRef,
    timezone: location.timezone,
    resources: location.resources,
  };
}

function groupOutput(group: SlotlockResourceGroup) {
  return { ref: group.ref, name: group.name, description: group.description, members: group.members };
}

/** The references of a location and every location under it, from the tenant's whole tree. */
function locationAndBelow(locations: readonly SlotlockLocation[], ref: string): Set<string> {
  const found = new Set([ref]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const location of locations) {
      if (location.parentRef !== null && found.has(location.parentRef) && !found.has(location.ref)) {
        found.add(location.ref);
        grew = true;
      }
    }
  }
  return found;
}

/** The profile fields of an operation's input, as the store takes them; absent ones left out. */
function profileInput(input: Record<string, unknown>): SlotlockResourceProfileInput {
  const profile: Record<string, unknown> = {};
  for (const field of SLOTLOCK_RESOURCE_PROFILE_FIELDS) {
    if (input[field] !== undefined) profile[field] = input[field];
  }
  return profile as SlotlockResourceProfileInput;
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
    ...(hold.paymentRequired
      ? {
          payment_required: true as const,
          payment_ref: hold.paymentRef ?? null,
          paid_at: hold.paidAt?.toISOString() ?? null,
          payment_amount: amountOutput(hold.paymentAmount),
          paid_amount: amountOutput(hold.paidAmount),
        }
      : {}),
  };
}

function amountOutput(amount: { amountMinor: number; currency: string } | null | undefined) {
  return amount ? { amount_minor: amount.amountMinor, currency: amount.currency } : null;
}

function amountInput(value: unknown): { amountMinor: number; currency: string } | undefined {
  const amount = value as { amount_minor: number; currency: string } | undefined;
  return amount ? { amountMinor: amount.amount_minor, currency: amount.currency } : undefined;
}

function contactOutput(contact: SlotlockContact) {
  return {
    contact_ref: contact.ref,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    whatsapp: contact.whatsapp,
    consent: contact.consent,
    consent_at: Object.fromEntries(Object.entries(contact.consentAt).map(([channel, at]) => [channel, (at as Date).toISOString()])),
    locale: contact.locale,
    created_at: contact.createdAt.toISOString(),
    updated_at: contact.updatedAt.toISOString(),
  };
}

function reservationOutput(reservation: SlotlockReservation) {
  return {
    id: reservation.id,
    resource_id: reservation.resourceId,
    reservation_ref: reservation.externalRef,
    start: reservation.start.toISOString(),
    end: reservation.end.toISOString(),
    // The store keeps milliseconds; round up so a sub-minute buffer still shows as busy.
    buffer_after_minutes: Math.ceil(reservation.bufferAfterMs / 60_000),
    revision: reservation.revision,
    source: reservation.source,
    ...(reservation.contactRef ? { contact_ref: reservation.contactRef } : {}),
    ...(reservation.notify === false ? { notify: false as const } : {}),
    ...(reservation.reminderMinutes ? { reminder_minutes: reservation.reminderMinutes } : {}),
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
 * Serve the application API (application-api.ts) from the store in the principal's tenant. Every
 * resource named must be the tenant's, or it is not found; holds are under the tenant's RLS, so
 * another tenant's is not found either.
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
          origin: entry.origin,
          key_id: entry.keyId,
          data: entry.data,
        })),
        next_before: entries.length === limit ? (entries.at(-1)?.id ?? null) : null,
      };
    });
  }

  /** The partner store and the partner a partner key names; any other caller is forbidden. */
  function partnerOf(context: SlotlockApplicationInvocationContext) {
    assertActive(context);
    const partners = options.partners;
    if (!partners) throw new SlotlockAgentOperationError('partner_api_not_served', 404);
    return { partners, partner: slotlockPrincipalPartner(context.principal) };
  }

  /** As partnerOf, with the account's tenant: 404 account_not_found for one the partner lacks. */
  async function partnerAccount(context: SlotlockApplicationInvocationContext, input: Record<string, unknown>) {
    const { partners, partner } = partnerOf(context);
    const tenantRef = await partners.tenantOf(partner, input.account as string);
    if (!tenantRef) throw new SlotlockAgentOperationError('account_not_found', 404);
    // Its test environment (RFC 0003 G9): a tenant of its own, on the same plan, never billed.
    return { partners, partner, tenantRef: input.environment === 'test' ? `${tenantRef}${SLOTLOCK_TEST_TENANT_SUFFIX}` : tenantRef };
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
              ...(input.timezone !== undefined ? { timezone: input.timezone as string } : {}),
              ...(input.location !== undefined ? { location: input.location as string } : {}),
              ...(input.visibility !== undefined
                ? { visibility: input.visibility as 'shared' | 'private' }
                : {}),
              ...(max !== undefined ? { maxTenantResources: max } : {}),
              ...(SLOTLOCK_RESOURCE_PROFILE_FIELDS.some((field) => input[field] !== undefined)
                ? { profile: profileInput(input) }
                : {}),
            });
            return { resource: resourceOutput(resource) };
          } catch (error) {
            throw storeRefusal(error);
          }
        },
        max !== undefined ? { isolation: 'read committed' } : undefined,
      );
    },

    async updateResource(context, input) {
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.updateResourceProfile({
            tenantRef: tenantOf(context),
            id,
            profile: profileInput(input),
            ...(input.location !== undefined ? { location: input.location as string | null } : {}),
          });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      }, WRITE);
    },

    async listLocations(context) {
      return withTenant(store, context, async (tenant) => ({
        locations: (await tenant.listLocations({ tenantRef: tenantOf(context) })).map(locationOutput),
      }));
    },

    async createLocation(context, input) {
      return withTenant(store, context, async (tenant) => {
        try {
          const location = await tenant.putLocation({
            tenantRef: tenantOf(context),
            ref: input.ref as string,
            name: input.name as string,
            ...(input.parent_ref !== undefined ? { parentRef: input.parent_ref as string | null } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone as string | null } : {}),
          });
          return { location: locationOutput(location) };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async updateLocation(context, input) {
      return withTenant(store, context, async (tenant) => {
        let location: SlotlockLocation | null;
        try {
          location = await tenant.updateLocation({
            tenantRef: tenantOf(context),
            ref: input.location_ref as string,
            ...(input.name !== undefined ? { name: input.name as string } : {}),
            ...(input.parent_ref !== undefined ? { parentRef: input.parent_ref as string | null } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone as string | null } : {}),
          });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!location) throw new SlotlockAgentOperationError('location_not_found', 404);
        return { location: locationOutput(location) };
      }, WRITE);
    },

    async deleteLocation(context, input) {
      return withTenant(store, context, async (tenant) => {
        try {
          return {
            deleted: await tenant.deleteLocation({ tenantRef: tenantOf(context), ref: input.location_ref as string }),
          };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async listGroups(context) {
      return withTenant(store, context, async (tenant) => ({
        groups: (await tenant.listGroups({ tenantRef: tenantOf(context) })).map(groupOutput),
      }));
    },

    async createGroup(context, input) {
      return withTenant(store, context, async (tenant) => {
        try {
          const group = await tenant.putGroup({
            tenantRef: tenantOf(context),
            ref: input.ref as string,
            name: input.name as string,
            ...(input.description !== undefined ? { description: input.description as string | null } : {}),
          });
          return { group: groupOutput(group) };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async deleteGroup(context, input) {
      return withTenant(store, context, async (tenant) => {
        try {
          return { deleted: await tenant.deleteGroup({ tenantRef: tenantOf(context), ref: input.group_ref as string }) };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async addGroupMember(context, input) {
      const resourceId = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(resourceId)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        try {
          return {
            added: await tenant.addGroupMember({
              tenantRef: tenantOf(context),
              group: input.group_ref as string,
              resourceId,
            }),
          };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async removeGroupMember(context, input) {
      const resourceId = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(resourceId)) return { removed: false };
      return withTenant(store, context, async (tenant) => {
        try {
          return {
            removed: await tenant.removeGroupMember({
              tenantRef: tenantOf(context),
              group: input.group_ref as string,
              resourceId,
            }),
          };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
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
        const rules = resource.availabilityRules ?? resource.inheritedAvailability?.rules;
        if (rules === undefined) return { icalendar: null };
        // The year ahead's closures and special hours, as EXDATE and RDATE (RFC 0004 B1).
        const span = exportDays();
        const window = {
          start: new Date((epochDay(span.from) as number) * 86_400_000),
          end: new Date(((epochDay(span.to) as number) + 1) * 86_400_000),
        };
        const exceptions = await tenant.availabilityExceptionsFor({
          tenantRef: tenantOf(context),
          resourceIds: [resource.id],
          window,
        });
        const icalendar = emitVAvailability({
          rules,
          timezone: resource.timezone,
          uid: `${resource.id}-hours`,
          days: exceptionDays(exceptions.get(resource.id) ?? [], span.from, span.to),
        });
        if (icalendar.length > 200_000) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
        return { icalendar };
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
          if (resource) {
            // The days it names replace those an earlier import of its hours made.
            await tenant.replaceImportedExceptions({
              tenantRef: tenantOf(context),
              resourceId: id,
              ranges: exceptionRanges(parsed.days),
            });
          }
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

    async setResourceParent(context, input) {
      const id = input.resource_id as string;
      const parentId = input.parent_id as string | null;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      if (parentId !== null && !STORE_ID_PATTERN.test(parentId)) throw new SlotlockAgentOperationError('parent_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.setResourceParent({ tenantRef: tenantOf(context), id, parentId });
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

    async setPoolOrder(context, input) {
      return withTenant(store, context, async (tenant) => {
        try {
          const order = await tenant.setPoolOrder({
            tenantRef: tenantOf(context),
            pool: input.pool as string,
            order: input.order as SlotlockPoolOrder,
          });
          return { pool: input.pool as string, order };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async getBookingRuleDefaults(context) {
      return withTenant(store, context, async (tenant) => {
        const defaults = await tenant.getBookingRuleDefaults({ tenantRef: tenantOf(context) });
        return {
          tenant: bookingRulesOutput(defaults.tenant ?? undefined),
          pools: Object.entries(defaults.pools).map(([pool, rules]) => ({
            pool,
            rules: bookingRulesOutput(rules) ?? {},
          })),
        };
      });
    },

    async setTenantBookingRules(context, input) {
      const rules = bookingRulesInput(input.rules);
      return withTenant(store, context, async (tenant) => {
        try {
          const stored = await tenant.setBookingRuleDefaults({ tenantRef: tenantOf(context), pool: null, rules });
          return { rules: bookingRulesOutput(stored ?? undefined) };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async setPoolBookingRules(context, input) {
      const rules = bookingRulesInput(input.rules);
      const pool = input.pool as string;
      return withTenant(store, context, async (tenant) => {
        try {
          const stored = await tenant.setBookingRuleDefaults({ tenantRef: tenantOf(context), pool, rules });
          return { pool, rules: bookingRulesOutput(stored ?? undefined) };
        } catch (error) {
          throw storeRefusal(error);
        }
      }, WRITE);
    },

    async setTenantAvailability(context, input) {
      const rules = rulesInput(input.rules);
      return withTenant(store, context, async (tenant) => {
        try {
          const result = await tenant.storeTenantAvailability({
            tenantRef: tenantOf(context),
            rules,
            overrideResources: SLOTLOCK_OVERRIDE_RESOURCES.includes(input.override_resources as SlotlockOverrideResources)
              ? (input.override_resources as SlotlockOverrideResources)
              : 'none',
          });
          return { resources_updated: result.inheriting, resources_with_own_hours: result.ownHours };
        } catch (error) {
          throw storeRefusal(error);
        }
      });
    },

    async getAvailabilityDefaults(context) {
      return withTenant(store, context, async (tenant) => {
        const defaults = await tenant.getAvailabilityDefaults({ tenantRef: tenantOf(context) });
        return {
          tenant: rulesOutput(defaults.tenant),
          locations: defaults.locations.map((entry) => ({
            location: entry.location,
            rules: rulesOutput(entry.rules) ?? [],
          })),
        };
      });
    },

    async setLocationAvailability(context, input) {
      const rules = rulesInput(input.rules);
      const location = input.location as string;
      return withTenant(store, context, async (tenant) => {
        let result: Awaited<ReturnType<typeof tenant.setLocationAvailability>>;
        try {
          result = await tenant.setLocationAvailability({ tenantRef: tenantOf(context), location, rules });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!result) throw new SlotlockAgentOperationError('location_not_found', 404);
        return { location, resources_updated: result.inheriting, resources_with_own_hours: result.ownHours };
      });
    },

    async listAvailabilityExceptions(context, input) {
      const limit = (input.limit as number | undefined) ?? 100;
      return withTenant(store, context, async (tenant) => {
        let exceptions: SlotlockAvailabilityException[];
        try {
          exceptions = await tenant.listAvailabilityExceptions({
            tenantRef: tenantOf(context),
            ...(input.resource_id !== undefined ? { resourceId: input.resource_id as string } : {}),
            ...(input.location !== undefined ? { location: input.location as string } : {}),
            ...(input.from !== undefined ? { from: input.from as string } : {}),
            ...(input.to !== undefined ? { to: input.to as string } : {}),
            ...(input.after !== undefined ? { after: input.after as string } : {}),
            limit: limit + 1,
          });
        } catch (error) {
          throw storeRefusal(error);
        }
        const page = exceptions.slice(0, limit);
        return {
          exceptions: page.map(exceptionOutput),
          next: exceptions.length > limit ? (page.at(-1)?.id ?? null) : null,
        };
      });
    },

    async createAvailabilityException(context, input) {
      const hours = input.hours as { start_minutes: number; duration_minutes: number }[] | undefined;
      return withTenant(store, context, async (tenant) => {
        try {
          const exception = await tenant.createAvailabilityException({
            tenantRef: tenantOf(context),
            ...(input.location !== undefined ? { location: input.location as string } : {}),
            ...(input.resource_id !== undefined ? { resourceId: input.resource_id as string } : {}),
            startsOn: input.starts_on as string,
            ...(input.ends_on !== undefined ? { endsOn: input.ends_on as string } : {}),
            outcome: input.outcome as 'closed' | 'open',
            ...(hours
              ? { hours: hours.map((window) => ({ startMinutes: window.start_minutes, durationMinutes: window.duration_minutes })) }
              : {}),
            label: input.label as string,
          });
          return { exception: exceptionOutput(exception) };
        } catch (error) {
          throw storeRefusal(error);
        }
      });
    },

    async deleteAvailabilityException(context, input) {
      return withTenant(store, context, async (tenant) => {
        const deleted = await tenant.deleteAvailabilityException({
          tenantRef: tenantOf(context),
          id: input.exception_id as string,
        });
        if (!deleted) throw new SlotlockAgentOperationError('availability_exception_not_found', 404);
        return { deleted: true };
      });
    },

    async importHolidays(context, input) {
      if (input.location !== undefined && input.resource_id !== undefined) {
        throw new SlotlockAgentOperationError('invalid_holiday_calendar', 400, { reason: 'a location or a resource, not both' });
      }
      // Read (a URL fetched) before the transaction opens.
      let read: Awaited<ReturnType<typeof readSlotlockHolidayCalendar>>;
      try {
        read = await readSlotlockHolidayCalendar(
          {
            ...(input.icalendar !== undefined ? { icalendar: input.icalendar as string } : {}),
            ...(input.url !== undefined ? { url: input.url as string } : {}),
            ...(input.name !== undefined ? { name: input.name as string } : {}),
            ...(input.subscribe !== undefined ? { subscribe: input.subscribe as boolean } : {}),
            ...(input.from !== undefined ? { from: input.from as string } : {}),
            ...(input.to !== undefined ? { to: input.to as string } : {}),
          },
          options.holidayFetch,
        );
      } catch (error) {
        throw storeRefusal(error);
      }
      return withTenant(store, context, async (tenant) => {
        try {
          const result = await tenant.importHolidayCalendar({
            tenantRef: tenantOf(context),
            ...(input.location !== undefined ? { location: input.location as string } : {}),
            ...(input.resource_id !== undefined ? { resourceId: input.resource_id as string } : {}),
            name: read.name,
            ...(read.url !== undefined ? { url: read.url } : {}),
            holidays: read.holidays,
            span: read.span,
          });
          return {
            imported: result.imported,
            skipped: read.skipped,
            removed: result.removed,
            calendar: holidayCalendarOutput(result.calendar),
          };
        } catch (error) {
          throw storeRefusal(error);
        }
      });
    },

    async listHolidayCalendars(context) {
      return withTenant(store, context, async (tenant) => ({
        calendars: (await tenant.listHolidayCalendars({ tenantRef: tenantOf(context) })).map(holidayCalendarOutput),
      }));
    },

    async deleteHolidayCalendar(context, input) {
      return withTenant(store, context, async (tenant) => {
        const deleted = await tenant.deleteHolidayCalendar({ tenantRef: tenantOf(context), id: input.calendar_id as string });
        return { deleted: deleted !== null, closures: deleted?.closures ?? 0 };
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
          ...(input.payment_required === true ? { paymentRequired: true } : {}),
          ...(input.payment !== undefined ? { payment: amountInput(input.payment) as { amountMinor: number; currency: string } } : {}),
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

    async markHoldPaid(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('hold_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.markHoldPaid({
          tenantRef: tenantOf(context),
          holdId: id,
          paymentRef: input.payment_ref as string,
          ...(input.received !== undefined ? { received: amountInput(input.received) as { amountMinor: number; currency: string } } : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { hold: holdOutput(result.hold), replayed: result.idempotent };
      }, WRITE);
    },

    async putContact(context, input) {
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.putContact({
          tenantRef: tenantOf(context),
          ref: input.contact_ref as string,
          name: (input.name as string | null | undefined) ?? null,
          email: (input.email as string | null | undefined) ?? null,
          phone: (input.phone as string | null | undefined) ?? null,
          whatsapp: (input.whatsapp as string | null | undefined) ?? null,
          consent: (input.consent as SlotlockContactConsent | undefined) ?? {},
          locale: (input.locale as string | null | undefined) ?? null,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { contact: contactOutput(result.contact), created: result.created };
      }, WRITE);
    },

    async getContact(context, input) {
      return withTenant(store, context, async (tenant) => {
        const contact = await tenant.getContact({ tenantRef: tenantOf(context), ref: input.contact_ref as string });
        if (!contact) throw new SlotlockAgentOperationError('contact_not_found', 404);
        return { contact: contactOutput(contact) };
      });
    },

    async listContacts(context, input) {
      const limit = input.limit as number;
      return withTenant(store, context, async (tenant) => {
        const contacts = await tenant.listContacts({
          tenantRef: tenantOf(context),
          limit: limit + 1,
          ...(input.cursor !== undefined ? { after: input.cursor as string } : {}),
        });
        const shown = contacts.slice(0, limit);
        return {
          contacts: shown.map(contactOutput),
          next_cursor: contacts.length > limit ? (shown.at(-1)?.ref ?? null) : null,
        };
      });
    },

    async deleteContact(context, input) {
      return withTenant(store, context, async (tenant) =>
        tenant.deleteContact({ tenantRef: tenantOf(context), ref: input.contact_ref as string }),
      WRITE);
    },

    async releaseHold(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) return { released: false };
      const released = await withTenant(store, context, async (tenant) => ({
        released: (await tenant.releaseHold(id, { tenantRef: tenantOf(context) })).released,
      }));
      if (released.released) await offerFreedTime(store, context);
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
      const put = await withTenant(store, context, async (tenant) => {
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
          ...(input.override_reason !== undefined ? { overrideReason: input.override_reason as string } : {}),
          ...(input.local_start !== undefined ? { localStart: input.local_start as string } : {}),
          ...(input.contact_ref !== undefined ? { contactRef: input.contact_ref as string } : {}),
          ...(input.notify !== undefined ? { notify: input.notify as boolean } : {}),
          ...(input.reminder_minutes !== undefined ? { reminderMinutes: input.reminder_minutes as number[] } : {}),
        };
        const result =
          command.revision === 1
            ? await tenant.createExternalReservation(command)
            : await tenant.rescheduleExternalReservation(command);
        if (!result.ok) throw applicationRuleRefusal(result);
        return { reservation: reservationOutput(result.reservation), replayed: result.idempotent };
      }, WRITE);
      if ((input.revision as number) > 1 && !put.replayed) {
        await offerFreedTime(store, context);
      }
      return put;
    },

    async cancelReservation(context, input) {
      const cancelled = await withTenant(store, context, async (tenant) => {
        const result = await tenant.cancelExternalReservation({
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
          revision: input.revision as number,
          ...(input.override_reason !== undefined ? { overrideReason: input.override_reason as string } : {}),
        });
        if (!result.ok) throw applicationRuleRefusal(result);
        return { cancelled: result.cancelled, revision: result.revision, cancellation_fee: feeOutput(result.cancellationFee) };
      }, WRITE);
      if (cancelled.cancelled) await offerFreedTime(store, context);
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
          ...(input.duration_minutes !== undefined ? { durationMs: (input.duration_minutes as number) * 60_000 } : {}),
          ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key as string } : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { entry: waitlistOutput(result.entry), replayed: result.replayed };
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
      if (left.left) await offerFreedTime(store, context);
      return left;
    },

    async tenantBookTogether(context, input) {
      if (!options.agentBackend?.bookTogether) throw new SlotlockAgentOperationError('bundles_unavailable', 409);
      // Through the agents' bundle (one transaction, the booking rules applied), as the tenant's:
      // owned by the tenant, not the key, and held only by policies that include the application.
      return options.agentBackend.bookTogether(
        { ...context, operation: 'slotlock_book_together', [TENANT_ACTOR]: true } as unknown as SlotlockAgentInvocationContext,
        input,
      );
    },

    async tenantBookPool(context, input) {
      if (!options.agentBackend?.bookPool) throw new SlotlockAgentOperationError('pools_unavailable', 409);
      return options.agentBackend.bookPool(
        { ...context, operation: 'slotlock_book_pool', [TENANT_ACTOR]: true } as unknown as SlotlockAgentInvocationContext,
        input,
      );
    },

    async declineWaitlistOffer(context, input) {
      const declined = await withTenant(store, context, (tenant) =>
        tenant.declineWaitlistOffer({ tenantRef: tenantOf(context), id: input.entry_id as string }),
      );
      if (!declined) throw new SlotlockAgentOperationError('waitlist_offer_not_found', 404);
      // The time it let go goes to the next who waits.
      await offerFreedTime(store, context);
      return { entry: waitlistOutput(declined) };
    },

    async getCoverage(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const sources = await tenant.listCoverage({ tenantRef: tenantOf(context), resourceId: resource.id });
        return {
          sources: sources.map((source) => ({
            source: source.source,
            source_id: source.sourceId,
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

    async deleteCoverage(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const deleted = await tenant.deleteCoverage({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          source: input.source as string,
        });
        if (!deleted) throw applicationRefusal('coverage_not_found');
        return { deleted: true };
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

    async putSourceBusy(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const result = await tenant.replaceSourceBusy({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          source: input.source as string,
          window: interval(input as { start: string; end: string }),
          revision: input.revision as number,
          busy: (input.busy as { start: string; end: string }[]).map((busy) => ({
            start: new Date(busy.start),
            end: new Date(busy.end),
          })),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { revision: result.revision, replayed: result.idempotent, busy: result.busy, conflicts: result.conflicts };
      }, WRITE);
    },

    async reportCoverageConflict(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const result = await tenant.reportCoverageConflict({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          source: input.source as string,
          booking:
            input.event_id !== undefined
              ? { eventId: input.event_id as string }
              : { reservationRef: input.reservation_ref as string },
          reason: input.reason as 'changed_in_calendar' | 'removed_from_calendar',
          ...(input.calendar_start !== undefined
            ? { calendar: interval({ start: input.calendar_start as string, end: input.calendar_end as string }) }
            : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { reported: true };
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
          ...(input.override_reason !== undefined ? { overrideReason: input.override_reason as string } : {}),
        });
        if (!result.ok) throw applicationRuleRefusal(result);
        return {
          event_id: result.eventId,
          revision: result.revision,
          cancelled: true,
          replayed: result.idempotent,
          cancellation_fee: feeOutput(result.cancellationFee),
        };
      }, WRITE);
      if (!cancelled.replayed) await offerFreedTime(store, context);
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
        // Read under the tenant's lock: a suspended tenant's data is kept for its operator to
        // erase.
        if (await tenant.isTenantSuspended({ tenantRef: tenantOf(context) })) {
          throw new SlotlockAgentOperationError('tenant_suspended', 403);
        }
        const erased = await tenant.eraseTenant({ tenantRef: tenantOf(context) }).catch((error: unknown) => {
          // A paid hosted plan is cancelled first, so it does not renew for an erased tenant.
          if ((error as { code?: unknown } | null)?.code === 'billing_active') {
            throw new SlotlockAgentOperationError('billing_active', 409);
          }
          throw error;
        });
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
          ...(['resource_ids', 'pools', 'locations', 'groups'].some((field) => input[field] !== undefined)
            ? {
                filter: {
                  ...(input.resource_ids !== undefined ? { resourceIds: input.resource_ids as string[] } : {}),
                  ...(input.pools !== undefined ? { pools: input.pools as string[] } : {}),
                  ...(input.locations !== undefined ? { locations: input.locations as string[] } : {}),
                  ...(input.groups !== undefined ? { groups: input.groups as string[] } : {}),
                },
              }
            : {}),
          ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key as string } : {}),
        });
        if (!created.ok) {
          throw new SlotlockAgentOperationError(
            created.code,
            created.code === 'webhook_limit_reached' || created.code === 'idempotency_conflict' ? 409 : 400,
          );
        }
        return {
          webhook: webhookOutput(created.endpoint),
          secret: created.secret,
          replayed: created.replayed === true,
        };
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

    // The partner API (RFC 0003 P3): the partner the key names, its own accounts only.
    async partnerPutAccount(context, input) {
      const { partners, partner } = partnerOf(context);
      const put = await partners.putAccount(partner, input.account as string, input.plan as string);
      if (!put) throw new SlotlockAgentOperationError('forbidden', 403);
      return { account: partnerAccountOutput(put.account), created: put.created };
    },

    async partnerListAccounts(context) {
      const { partners, partner } = partnerOf(context);
      return { accounts: (await partners.listAccounts(partner)).map(partnerAccountOutput) };
    },

    async partnerGetAccount(context, input) {
      const { partners, partner } = partnerOf(context);
      const found = await partners.getAccount(partner, input.account as string);
      if (!found) throw new SlotlockAgentOperationError('account_not_found', 404);
      return { account: partnerAccountOutput(found) };
    },

    async partnerListKeys(context, input) {
      const { partners, tenantRef } = await partnerAccount(context, input);
      return { keys: (await partners.keys.list({ tenantRef })).map(slotlockPartnerKeyOutput) };
    },

    async partnerCreateKey(context, input) {
      const { partners, partner, tenantRef } = await partnerAccount(context, input);
      const contract = await partners.contract(partner);
      if (!contract) throw new SlotlockAgentOperationError('forbidden', 403);
      const scopes = (input.scopes as SlotlockApiKeyScope[] | undefined) ?? [...contract.keyScopes];
      if (scopes.some((scope) => !contract.keyScopes.includes(scope))) {
        throw new SlotlockAgentOperationError('scope_not_in_contract', 403);
      }
      const days = input.expires_in_days as number | undefined;
      try {
        const created = await partners.keys.create({
          tenantRef,
          name: input.name as string,
          scopes,
          createdBy: `partner:${partner}`,
          actor: context.principal.subject,
          origin: 'application',
          ...(days !== undefined ? { expiresAt: new Date(Date.now() + days * 86_400_000) } : {}),
          ...(input.limits !== undefined ? { limits: keyLimitsFromInput(input.limits) } : {}),
        });
        return { key: created.key, api_key: slotlockPartnerKeyOutput(created.apiKey) };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'api_key_limit_reached') throw new SlotlockAgentOperationError(code, 409);
        if (code === 'tenant_suspended') throw new SlotlockAgentOperationError(code, 403);
        throw error;
      }
    },

    async partnerRotateKey(context, input) {
      const { partners, tenantRef } = await partnerAccount(context, input);
      const rotated = await partners.keys
        .rotate({ tenantRef, id: input.key_id as string, actor: context.principal.subject, origin: 'application' })
        .catch((error: unknown) => {
          if ((error as { code?: unknown }).code === 'tenant_suspended') {
            throw new SlotlockAgentOperationError('tenant_suspended', 403);
          }
          throw error;
        });
      if (!rotated) throw new SlotlockAgentOperationError('key_not_found', 404);
      return { key: rotated.key, api_key: slotlockPartnerKeyOutput(rotated.apiKey) };
    },

    async partnerRevokeKey(context, input) {
      const { partners, tenantRef } = await partnerAccount(context, input);
      const revoked = await partners.keys.revoke({
        tenantRef,
        id: input.key_id as string,
        actor: context.principal.subject,
        origin: 'application',
      });
      if (!revoked) throw new SlotlockAgentOperationError('key_not_found', 404);
      return { api_key: slotlockPartnerKeyOutput(revoked) };
    },

    async partnerSuspendAccount(context, input) {
      const { partners, partner } = partnerOf(context);
      const changed = await partners.setSuspended(partner, input.account as string, true, input.reason as string | undefined);
      if (changed === null) throw new SlotlockAgentOperationError('account_not_found', 404);
      return { suspended: changed };
    },

    async partnerUnsuspendAccount(context, input) {
      const { partners, partner } = partnerOf(context);
      const changed = await partners.setSuspended(partner, input.account as string, false);
      if (changed === null) throw new SlotlockAgentOperationError('account_not_found', 404);
      return { unsuspended: changed };
    },

    async partnerEraseAccount(context, input) {
      const { partners, partner } = partnerOf(context);
      if (input.confirm !== input.account) throw new SlotlockAgentOperationError('confirmation_mismatch', 400);
      const erased = await partners.eraseAccount(partner, input.account as string);
      if (!erased.erased) throw new SlotlockAgentOperationError('account_not_found', 404);
      return { erased: true, rows: erased.total };
    },

    async partnerGetUsage(context, input) {
      const { partners, partner } = partnerOf(context);
      const now = Date.now();
      const range = slotlockUsageMonthToDate(now);
      const from = (input.from as string | undefined) ?? range.from;
      const to = (input.to as string | undefined) ?? range.to;
      const span = slotlockUsageSpanDays(from, to);
      if (span < 0 || span > SLOTLOCK_USAGE_RETENTION_DAYS || slotlockUsageSpanDays(to, slotlockUsageDay(now)) < 0) {
        throw new SlotlockAgentOperationError('invalid_usage_range', 400);
      }
      const rows = await partners.usage(partner, from, to, input.account as string | undefined);
      return { from, to, usage: rows };
    },

    async partnerReconcileUsage(context, input) {
      const { partners, partner } = partnerOf(context);
      const day = input.day as string;
      // An ended day: today's counts are still arriving.
      if (slotlockUsageSpanDays(day, slotlockUsageDay(Date.now())) < 1) {
        throw new SlotlockAgentOperationError('invalid_usage_range', 400);
      }
      const theirs = new Map<string, { operations: number; bookings?: number }>();
      for (const row of input.accounts as { account: string; operations: number; bookings?: number }[]) {
        theirs.set(row.account, { operations: row.operations, ...(row.bookings !== undefined ? { bookings: row.bookings } : {}) });
      }
      const ours = new Map<string, { operations: number; bookings: number }>();
      for (const row of await partners.usage(partner, day, day)) {
        if (row.metric !== 'operations' && row.metric !== 'bookings') continue;
        const counted = ours.get(row.account) ?? { operations: 0, bookings: 0 };
        counted[row.metric] += row.count;
        ours.set(row.account, counted);
      }
      const accounts = [...new Set([...ours.keys(), ...theirs.keys()])].sort();
      const lines: { account: string; metric: 'operations' | 'bookings'; ours: number; theirs: number | null; difference_percent: number | null }[] = [];
      const mismatched = new Set<string>();
      let worst = 0;
      for (const account of accounts) {
        for (const metric of ['operations', 'bookings'] as const) {
          const mine = ours.get(account)?.[metric] ?? 0;
          const told = theirs.get(account)?.[metric];
          if (told === undefined && (metric === 'bookings' || !theirs.has(account)) && mine === 0) continue;
          // Not sent by them, where we counted some: a difference of all of it.
          const theirCount = told ?? null;
          const difference =
            theirCount === null
              ? mine === 0 ? 0 : 100
              : Math.max(mine, theirCount) === 0 ? 0 : (Math.abs(mine - theirCount) * 100) / Math.max(mine, theirCount);
          if (theirCount === null && metric === 'bookings') {
            lines.push({ account, metric, ours: mine, theirs: null, difference_percent: null });
            continue;
          }
          const rounded = Math.round(difference * 100) / 100;
          if (difference > SLOTLOCK_RECONCILE_TOLERANCE_PERCENT) mismatched.add(account);
          worst = Math.max(worst, rounded);
          lines.push({ account, metric, ours: mine, theirs: theirCount, difference_percent: rounded });
        }
      }
      await partners.recordReconciliation(partner, day, accounts.length, mismatched.size, worst);
      return {
        day,
        within_tolerance: mismatched.size === 0,
        tolerance_percent: SLOTLOCK_RECONCILE_TOLERANCE_PERCENT,
        accounts: lines,
      };
    },

    async getUsage(context, input) {
      const now = Date.now();
      const range = slotlockUsageMonthToDate(now);
      const from = (input.from as string | undefined) ?? range.from;
      const to = (input.to as string | undefined) ?? range.to;
      const span = slotlockUsageSpanDays(from, to);
      if (span < 0 || span > SLOTLOCK_USAGE_RETENTION_DAYS || slotlockUsageSpanDays(to, slotlockUsageDay(now)) < 0) {
        throw new SlotlockAgentOperationError('invalid_usage_range', 400);
      }
      const rows = await withTenant(store, context, (tenant) =>
        tenant.readUsage({ tenantRef: tenantOf(context), from, to }),
      );
      const summary = summarizeSlotlockUsage(rows);
      return {
        from,
        to,
        totals: summary.totals,
        days: summary.days,
        keys: summary.keys.map(({ keyId, ...totals }) => ({ key_id: keyId, ...totals })),
        surfaces: summary.surfaces,
      };
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

    async listApprovalPolicies(context) {
      return withTenant(store, context, async (tenant) => ({
        policies: (await tenant.listApprovalPolicies({ tenantRef: tenantOf(context) })).map(approvalPolicyOutput),
      }));
    },

    async putApprovalPolicy(context, input) {
      return withTenant(store, context, async (tenant) => {
        let policy: SlotlockApprovalPolicy | null;
        try {
          policy = await tenant.putApprovalPolicy({
            tenantRef: tenantOf(context),
            ref: input.policy_ref as string,
            name: input.name as string,
            outcome: input.outcome as SlotlockApprovalPolicy['outcome'],
            ...(input.applies_to !== undefined ? { appliesTo: approvalAppliesTo(input.applies_to) } : {}),
            ...(input.conditions !== undefined ? { conditions: approvalConditions(input.conditions) } : {}),
            ...(input.approval_ttl_minutes !== undefined ? { approvalTtlMinutes: input.approval_ttl_minutes as number } : {}),
            ...(input.lead_minutes !== undefined ? { leadMinutes: input.lead_minutes as number } : {}),
            ...(input.include_application !== undefined ? { includeApplication: input.include_application as boolean } : {}),
          });
        } catch (error) {
          if (error instanceof SlotlockApprovalPolicyError) {
            throw new SlotlockAgentOperationError(error.code, 400, { reason: error.message.slice(0, 200) });
          }
          throw error;
        }
        if (!policy) throw new SlotlockAgentOperationError('approval_policy_limit_reached', 409);
        return { policy: approvalPolicyOutput(policy) };
      }, WRITE);
    },

    async deleteApprovalPolicy(context, input) {
      return withTenant(store, context, (tenant) =>
        tenant.deleteApprovalPolicy({ tenantRef: tenantOf(context), ref: input.policy_ref as string }),
      );
    },

    async listApprovals(context, input) {
      return withTenant(store, context, async (tenant) => ({
        approvals: (
          await tenant.listApprovals({
            tenantRef: tenantOf(context),
            limit: input.limit as number,
            ...(input.status !== undefined ? { status: input.status as SlotlockApproval['status'] } : {}),
          })
        ).map(approvalOutput),
      }));
    },

    async getApproval(context, input) {
      return withTenant(store, context, async (tenant) => {
        const approval = await tenant.getApproval({ tenantRef: tenantOf(context), id: input.approval_id as string });
        if (!approval) throw new SlotlockAgentOperationError('approval_not_found', 404);
        return { approval: approvalOutput(approval) };
      });
    },

    async decideApproval(context, input) {
      const tenantRef = tenantOf(context);
      const id = input.approval_id as string;
      const decidedBy = actorOf(context) ?? 'unknown';
      if (input.decision === 'decline') {
        const declined = await withTenant(store, context, (tenant) =>
          tenant.declineApproval({
            tenantRef,
            id,
            decidedBy,
            ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
          }),
        WRITE);
        if (!declined.ok) throw approvalRefusal(declined.code);
        await offerFreedTime(store, context);
        return { approval: approvalOutput(declined.approval), booking: null };
      }
      if (!options.agentBackend) throw new SlotlockAgentOperationError('approvals_unavailable', 409);
      const approval = await withTenant(store, context, (tenant) => tenant.getApproval({ tenantRef, id }));
      if (!approval) throw approvalRefusal('approval_not_found');
      if (approval.status !== 'pending') throw approvalRefusal('approval_not_pending');
      // A dry run's grant is a dry run of the booking: rolled back with it.
      const booking = await runSlotlockApprovalGrant(options.agentBackend, approval, {
        tenantRef,
        decidedBy,
        signal: context.signal,
        ...(context.origin !== undefined ? { origin: context.origin } : {}),
        ...(context.dryRun ? { dryRun: true } : {}),
      });
      const granted = context.dryRun
        ? { ...approval, status: 'granted' as const, decidedBy, decidedAt: new Date() }
        : await withTenant(store, context, (tenant) => tenant.getApproval({ tenantRef, id }));
      if (!granted) throw new SlotlockAgentOperationError('store_inconsistent', 503);
      return { approval: approvalOutput(granted), booking };
    },

    async sandboxSeed(context, input) {
      try {
        return { ...(await seedSlotlockSandbox(store, tenantOf(context), input.scenario as SlotlockSandboxScenario)) };
      } catch (error) {
        throw sandboxRefusal(error);
      }
    },

    async sandboxReset(context) {
      try {
        return { removed: await resetSlotlockSandbox(store, tenantOf(context)) };
      } catch (error) {
        throw sandboxRefusal(error);
      }
    },

    async sandboxFastForward(context, input) {
      try {
        const forward = await fastForwardSlotlockSandbox(store, tenantOf(context), input.minutes as number);
        const { rollPending: _, ...maintenance } = forward.maintenance;
        return { minutes: forward.minutes, holds: forward.holds, approvals: forward.approvals, maintenance };
      } catch (error) {
        throw sandboxRefusal(error);
      }
    },

    async sandboxRace(context, input) {
      if (!options.agentBackend) throw new SlotlockAgentOperationError('sandbox_unavailable', 409);
      try {
        const raced = await raceSlotlockSandbox({
          backend: options.agentBackend,
          tenantRef: tenantOf(context),
          resourceId: input.resource_id as string,
          start: new Date(input.starts_at as string),
          end: new Date(input.ends_at as string),
          ...(input.agents !== undefined ? { agents: input.agents as number } : {}),
        });
        return {
          agents: raced.agents,
          booked: raced.booked,
          refused: raced.refused,
          with_alternatives: raced.withAlternatives,
          server_errors: raced.serverErrors,
          p50_ms: raced.p50Ms,
          p99_ms: raced.p99Ms,
          max_ms: raced.maxMs,
        };
      } catch (error) {
        throw sandboxRefusal(error);
      }
    },

    async runMaintenance(context) {
      assertActive(context);
      try {
        const { rollPending: _, holidayCalendarsImported: _holidays, zoneShifts, staleSources, noShows, waitlistOffers, approvalsExpired, bookingsCompleted, remindersDue, ...result } = await maintainSlotlockTenant(store, tenantOf(context), {
          batches,
          signal: context.signal,
          ...(options.holidayFetch ? { holidayFetch: options.holidayFetch } : {}),
        });
        return {
          ...result,
          zone_shifts: zoneShifts,
          stale_sources: staleSources,
          no_shows: noShows,
          waitlist_offers: waitlistOffers,
          approvals_expired: approvalsExpired,
          bookings_completed: bookingsCompleted,
          reminders_due: remindersDue,
        };
      } catch (error) {
        if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
        throw error;
      }
    },
  };
}
