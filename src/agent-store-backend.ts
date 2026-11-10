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
  bookingSearchBlocked,
  bookingSearchReach,
} from './booking-rules.js';
import { findNextAvailable, mergeIntervals } from './engine.js';
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
 * Writes run under READ COMMITTED whatever the role's default: tenant limits are counted under a
 * lock that needs that level.
 */
const WRITE = { isolation: 'read committed' } as const;

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
    value = await store.withTenant(context.principal.tenantRef, callback, {
      ...options,
      signal: context.signal,
      ...(actor !== undefined ? { actor } : {}),
      ...(context.origin !== undefined ? { origin: context.origin } : {}),
      ...(typeof keyId === 'string' && KEY_ID.test(keyId) ? { keyId } : {}),
      // A key limited to part of the tenant reaches only its resources, by the database's policies.
      ...(context.principal.resourceScope ? { resourceScope: context.principal.resourceScope } : {}),
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
  return `agent:${createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}`)
    .digest('hex')}`;
}

function agentExternalRef(context: SlotlockAgentInvocationContext, idempotencyKey: string): string {
  // Already a stable client-visible identity; keep it unchanged.
  return `agent:${agentPrincipalDigest(context, idempotencyKey)}`;
}

function agentCommandIdempotencyKey(
  context: SlotlockAgentInvocationContext,
  idempotencyKey: string,
): string {
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
  uncertain: 'booking_rule_uncertain',
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
function requireAgentResource(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  resourceId: string,
): Promise<SlotlockResource> {
  return requireResource(tenantStore, tenantRef, resourceId, 'shared');
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
            const hours = member.availabilityRules ?? (await options.availabilityRules(context, member));
            const windows = expandRules(hours, window, member.timezone);
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

    async releaseSlots(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) return { released: false };
      const result = await withTenant(store, context, async (tenantStore) =>
        tenantStore.releaseHold(id, {
          tenantRef: context.principal.tenantRef,
          holderRef: agentOwnerRef(context),
        }).then(({ released }) => ({ released })),
      );
      if (result.released) await offerFreedTime(store, context.principal.tenantRef);
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
          return {
            resources: (
              await tenantStore.listPoolMembers({
                tenantRef: context.principal.tenantRef,
                pool: input.pool as string,
                visibility: 'shared',
              })
            )
              .filter(
                (resource) =>
                  (kind === undefined || (resource.kind ?? 'other') === kind) &&
                  (labels === undefined || slotlockResourceHasLabels(resource.labels, labels)) &&
                  (places === null || (resource.location !== undefined && places.has(resource.location))) &&
                  (group === undefined || resource.groups?.includes(group) === true),
              )
              .map(output),
            next_cursor: null,
          };
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
          const rules =
            resource.availabilityRules ?? (await options.availabilityRules(context, resource));
          const windows = expandRules(rules, search.window, resource.timezone);
          windowsLeft -= windows.length;
          if (windowsLeft < 0) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
          const candidate = findNextAvailable({
            busy: bookingSearchBlocked(freeBusy.busy, search),
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
      if (!moved.replayed) await offerFreedTime(store, context.principal.tenantRef);
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
      if (!deleted.replayed) await offerFreedTime(store, context.principal.tenantRef);
      return deleted;
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
  /**
   * The partner API (RFC 0003 P3): the partner store (partners.ts) its operations run through, for
   * the partner a partner key names. Unset: they answer 404 partner_api_not_served.
   */
  partners?: SlotlockPartnerStore;
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
    code === 'composite_busy'
  ) {
    return new SlotlockAgentOperationError(code, 409);
  }
  if (code.startsWith('invalid_') && code !== 'invalid_transaction_isolation') {
    return new SlotlockAgentOperationError(code, 400);
  }
  return error;
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
    created_at: entry.createdAt.toISOString(),
  };
}

/**
 * Offer what a cancel or release just freed to the waitlist now. Best effort, after commit:
 * maintenance offers whatever this misses.
 */
async function offerFreedTime(store: SlotlockStore, tenantRef: string): Promise<void> {
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
  };
}

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
        };
        const result =
          command.revision === 1
            ? await tenant.createExternalReservation(command)
            : await tenant.rescheduleExternalReservation(command);
        if (!result.ok) throw applicationRefusal(result.code);
        return { reservation: reservationOutput(result.reservation), replayed: result.idempotent };
      }, WRITE);
      if ((input.revision as number) > 1 && !put.replayed) {
        await offerFreedTime(store, tenantOf(context));
      }
      return put;
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

    async runMaintenance(context) {
      assertActive(context);
      try {
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
