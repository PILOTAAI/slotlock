// Slotlock core types. Every interval is half-open `[start, end)`: back-to-back reservations do not
// conflict, matching RFC 5545 interval semantics and PostgreSQL range boundaries.

/** Half-open time interval `[start, end)`. */
export interface Interval {
  start: Date;
  end: Date;
}

/** A schedulable resource (vehicle, room, worker, machine, or any other reservable asset). */
export interface SlotlockResource {
  id: string;
  externalRef: string | null;
  /** Null only for legacy/parity-shadow resources created before authority primitives existed. */
  tenantRef: string | null;
  /**
   * IANA timezone the resource's availability rules are authored in. expandRules evaluates
   * BYDAY/startMinutes as LOCAL wall-clock in this zone (DST-correct, wall-clock ends);
   * findNextAvailableFor reads it from the stored resource. Formerly the documented
   * Rules remain stable across daylight-saving changes because wall time is resolved in this zone.
   */
  timezone: string;
  /**
   * The resource's own weekly bookable hours, in `timezone`; `[]` is never bookable. Absent when it
   * uses the default (`SLOTLOCK_AVAILABILITY`, or the backend's `availabilityRules`).
   */
  availabilityRules?: WeeklyAvailabilityRule[];
  /**
   * `shared` resources are listed to agents and booked through them; `private` ones are invisible
   * to agents and reached only by the tenant's own code. Fixed when the resource is created. The
   * store always says which; a resource built elsewhere without it is shared.
   */
  visibility?: 'shared' | 'private';
  /** When the tenant archived it: no longer listed or booked, its history kept. Absent in use. */
  archivedAt?: Date;
}

/** A confirmed occupation of a resource. The DB EXCLUDE constraint is the overlap arbiter. */
export interface SlotlockReservation {
  id: string;
  resourceId: string;
  /**
   * Null only for live holds, rows on a resource that has no tenant (legacy), and parity-shadow rows.
   * A booking made by confirming a hold, or by createReservation, on a tenant's resource has one.
   */
  tenantRef: string | null;
  /**
   * Stable booking identity inside tenantRef; null exactly when tenantRef is. A confirmed hold, and
   * a createReservation booking, use their own id.
   */
  externalRef: string | null;
  start: Date;
  end: Date;
  /** Trailing occupied time after end. The customer-visible rental end remains unchanged. */
  bufferAfterMs: number;
  /** Monotonic command revision; legacy, hold, and shadow rows start at 1. */
  revision: number;
  source: string | null;
}

export interface ExternalReservationCommand {
  tenantRef: string;
  externalRef: string;
  resourceId: string;
  start: Date;
  end: Date;
  bufferAfterMs: number;
  revision: number;
  source?: string;
}

export type ExternalReservationResult =
  | { ok: true; reservation: SlotlockReservation; idempotent: boolean }
  | { ok: false; code: 'invalid_window' }
  | { ok: false; code: 'invalid_buffer' }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'resource_tenant_mismatch' }
  | { ok: false; code: 'reservation_not_found' }
  | { ok: false; code: 'reservation_cancelled' }
  | { ok: false; code: 'stale_revision' }
  | { ok: false; code: 'revision_conflict' }
  | { ok: false; code: 'idempotency_conflict' }
  /** The resource is archived: it takes no new booking (cancel and release still work). */
  | { ok: false; code: 'resource_archived' }
  /**
   * A recurring event on the resource is not stored as far as this write reaches, and cannot be
   * extended that far (past the rolling horizon, or blocked): the time cannot be proven free.
   */
  | { ok: false; code: 'recurrence_not_materialized' }
  /** The tenant's bookings and retired references are at its `reservations` limit. */
  | { ok: false; code: 'reservation_limit_reached'; limit: number }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type CancelExternalReservationResult =
  | { ok: true; cancelled: boolean; revision: number }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'reservation_cancelled' }
  | { ok: false; code: 'stale_revision' }
  | { ok: false; code: 'revision_conflict' }
  /**
   * Retiring a reference no booking holds would add a row past the tenant's `reservations` limit
   * (cancelling a booking it has never does).
   */
  | { ok: false; code: 'reservation_limit_reached'; limit: number };

/**
 * VAVAILABILITY-style bookable window (RFC 7953 semantics, weekly subset): a weekly-cadence RRULE
 * picks the days; the window on each matching day runs `[startMinutes, startMinutes+durationMinutes)`
 * after that day's local midnight in the evaluation timezone (`expandRules`' `timezone`, the
 * resource's stored zone for `findNextAvailableFor`, UTC when none is given).
 */
export interface WeeklyAvailabilityRule {
  /** RRULE content line without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`. */
  rrule: string;
  /** Window start, minutes after midnight in the evaluation timezone (UTC when none is given) of each matching day (0..1439). */
  startMinutes: number;
  /** Window length in minutes (> 0). */
  durationMinutes: number;
}

export type CreateReservationResult =
  | { ok: true; reservation: SlotlockReservation }
  | { ok: false; code: 'invalid_window' }
  /** No resource with that id, or (under tenant RLS or with `tenantRef`) not one of the tenant's. */
  | { ok: false; code: 'resource_not_found' }
  /** The resource is archived: it takes no new booking (cancel and release still work). */
  | { ok: false; code: 'resource_archived' }
  /**
   * A recurring event on the resource is not stored as far as this write reaches, and cannot be
   * extended that far (past the rolling horizon, or blocked): the time cannot be proven free.
   */
  | { ok: false; code: 'recurrence_not_materialized' }
  /** The booking's tenant is at its `reservations` limit. */
  | { ok: false; code: 'reservation_limit_reached'; limit: number }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

/** A hold: occupies exactly like a reservation until its DB-clock expiry, then lazily reaped. */
export interface SlotlockHold {
  id: string;
  resourceId: string;
  start: Date;
  end: Date;
  /** Turnaround kept busy after `end`; the booking the hold is confirmed into keeps it. */
  bufferAfterMs: number;
  expiresAt: Date;
  source: string | null;
}

export type AcquireHoldResult =
  /** `idempotent`: a retry of a keyed hold, answered with the hold the first request made. */
  | { ok: true; hold: SlotlockHold; idempotent: boolean }
  | { ok: false; code: 'invalid_window' }
  | { ok: false; code: 'invalid_ttl' }
  | { ok: false; code: 'invalid_buffer' }
  /** A tenant, principal or idempotency key that is malformed, or a key without both of the others. */
  | { ok: false; code: 'invalid_identity' }
  /** No resource with that id, or (under tenant RLS or with `tenantRef`) not one of the tenant's. */
  | { ok: false; code: 'resource_not_found' }
  /** The resource is archived: it takes no new booking (cancel and release still work). */
  | { ok: false; code: 'resource_archived' }
  /** The idempotency key already made a hold with another resource, window, ttl, buffer or source. */
  | { ok: false; code: 'idempotency_conflict' }
  /**
   * A recurring event on the resource is not stored as far as this write reaches, and cannot be
   * extended that far (past the rolling horizon, or blocked): the time cannot be proven free.
   */
  | { ok: false; code: 'recurrence_not_materialized' }
  /** The resource's tenant has as many live holds as its `holds` limit. */
  | { ok: false; code: 'hold_limit_reached'; limit: number }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type ConfirmHoldResult =
  | { ok: true; reservation: SlotlockReservation }
  | { ok: false; code: 'hold_not_found' }
  | { ok: false; code: 'hold_expired' }
  /** A cancellation of the hold's reference (its id) arrived first and retired it. */
  | { ok: false; code: 'reservation_cancelled' }
  /** Another booking of the tenant already uses the hold's id as its reference. */
  | { ok: false; code: 'idempotency_conflict' }
  /** The hold's resource was archived since: it takes no new booking. */
  | { ok: false; code: 'resource_archived' }
  /** The tenant is at its `reservations` limit: the hold stays a hold. */
  | { ok: false; code: 'reservation_limit_reached'; limit: number };

export type ReleaseHoldResult = { ok: true; released: boolean };

/** RFC 5545 TRANSP projection. Transparent events remain visible but never occupy a resource. */
export type CalendarTransparency = 'opaque' | 'transparent';
export type CalendarEventStatus = 'confirmed' | 'tentative';
export type CalendarAttendeeRole = 'chair' | 'required' | 'optional' | 'non_participant';
export type CalendarParticipationStatus =
  | 'needs_action'
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'delegated';

export interface CalendarOrganizer {
  email: string;
  name?: string;
}

export interface CalendarAttendee extends CalendarOrganizer {
  role?: CalendarAttendeeRole;
  participationStatus?: CalendarParticipationStatus;
  /** RFC 5545 RSVP request, independent from the current participation status. */
  rsvp?: boolean;
}

export interface CalendarReminder {
  action: 'display' | 'email';
  /** A non-negative relative trigger before DTSTART. Capped to one year. */
  minutesBeforeStart: number;
}

/** A RECURRENCE-ID exception. A cancellation may omit its replacement interval. */
export interface CalendarRecurrenceException {
  recurrenceId: Date;
  cancelled?: boolean;
  start?: Date;
  end?: Date;
}

export interface CalendarRecurrence {
  /** RFC 5545 RRULE value without the `RRULE:` prefix. */
  rrule: string;
  exceptions?: CalendarRecurrenceException[];
}

/** Trusted calendar content. Do not use this type for untrusted busy-only provider ingestion. */
export interface CalendarEventContent {
  start: Date;
  end: Date;
  timezone: string;
  summary: string;
  description?: string;
  location?: string;
  status?: CalendarEventStatus;
  transparency?: CalendarTransparency;
  organizer?: CalendarOrganizer;
  attendees?: CalendarAttendee[];
  reminders?: CalendarReminder[];
  recurrence?: CalendarRecurrence;
}

export interface CalendarEventOccurrence {
  /** ISO instant identifying the original recurrence slot (RECURRENCE-ID). */
  recurrenceId: string;
  start: Date;
  end: Date;
}

export interface TrustedICalendarEvent extends Omit<CalendarEventContent, 'status'> {
  uid: string;
  sequence: number;
  status?: CalendarEventStatus | 'cancelled';
}

export interface SlotlockCalendarEvent extends CalendarEventContent {
  id: string;
  tenantRef: string;
  /** Privacy-minimized immutable ownership namespace; never a raw authenticated subject. */
  ownerRef: string;
  externalRef: string;
  resourceId: string;
  revision: number;
  source: string | null;
  materializationWindow: Interval;
  createdAt: Date;
  updatedAt: Date;
}

export interface PutCalendarEventCommand extends CalendarEventContent {
  /**
   * The resource the writer read the event on: a revision is refused (`resource_tenant_mismatch`)
   * when the stored event is on another, checked under the event's lock.
   */
  expectedResourceId?: string;
  tenantRef: string;
  /** Defaults to the trusted `internal` namespace. Agent callers must supply their owner digest. */
  ownerRef?: string;
  externalRef: string;
  resourceId: string;
  /** Zero creates; otherwise the exact currently-observed revision. */
  expectedRevision: number;
  /** A retry identity unique inside the tenant + owner namespace. */
  idempotencyKey: string;
  /** Mandatory for recurrence; bounded to 367 days. Defaults to the event interval otherwise. */
  materializationWindow?: Interval;
  source?: string;
}

export type PutCalendarEventResult =
  | {
      ok: true;
      eventId: string;
      externalRef: string;
      revision: number;
      occurrenceCount: number;
      idempotent: boolean;
    }
  | { ok: false; code: 'invalid_event' }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'idempotency_conflict' }
  | { ok: false; code: 'owner_event_quota_exceeded'; limit: number }
  | { ok: false; code: 'owner_command_quota_exceeded'; limit: number }
  /** A new event would pass the tenant's `events` limit (revising one it has never does). */
  | { ok: false; code: 'event_limit_reached'; limit: number }
  | { ok: false; code: 'resource_tenant_mismatch' }
  /** The resource is archived: it takes no new booking (cancel and release still work). */
  | { ok: false; code: 'resource_archived' }
  | { ok: false; code: 'event_cancelled'; currentRevision: number }
  | { ok: false; code: 'revision_conflict'; currentRevision: number }
  /**
   * A recurring event on the resource is not stored as far as this write reaches, and cannot be
   * extended that far (past the rolling horizon, or blocked): the time cannot be proven free.
   */
  | { ok: false; code: 'recurrence_not_materialized' }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type DeleteResourceResult =
  /** `deleted`: false when the tenant has no resource with that id (deleted already, say). */
  | { ok: true; deleted: boolean }
  /** A future booking, a live hold, or a calendar event is still on it. */
  | { ok: false; code: 'resource_in_use' };

export type CancelCalendarEventResult =
  | {
      ok: true;
      eventId: string;
      externalRef: string;
      revision: number;
      idempotent: boolean;
    }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'idempotency_conflict' }
  | { ok: false; code: 'event_not_found' }
  | { ok: false; code: 'owner_command_quota_exceeded'; limit: number }
  | { ok: false; code: 'revision_conflict'; currentRevision: number };

/** A place in the roll's order of due masters: the last one a batch examined. */
export interface CalendarHorizonRollCursor {
  materializedEndsAt: Date;
  eventId: string;
}

/** Content-minimized outcome of one bounded recurring-event horizon maintenance batch. */
export interface CalendarHorizonRollResult {
  /** Due recurring masters examined in deterministic order. */
  examined: number;
  /**
   * Masters atomically rematerialized from the requested window's start through the later of their
   * stored end and the window's: a roll never moves a series' end back.
   */
  extended: number;
  /**
   * Masters whose new occurrence collided; their previous coverage remains intact, and they wait an
   * hour before a roll examines them again, behind the masters it can extend.
   */
  conflicts: number;
  /** The ids of those masters: what blocks each is a booking or hold on its new occurrences. */
  conflictEventIds: string[];
  /**
   * Masters whose rule takes more than the expansion budget to reach the window (one that never
   * occurs again, or almost never); their previous coverage remains intact, and they wait an hour
   * before a roll examines them again.
   */
  refused: number;
  /** The ids of those masters, to find and fix them. */
  refusedEventIds: string[];
  /** True when more due masters remain beyond this bounded batch. */
  hasMore: boolean;
  /**
   * Pass as `after` for the next batch of this pass, so the masters this batch left behind (in
   * conflict or refused, which keep their place at the front of the order) are not examined again
   * by every later batch. `null` when none remain.
   */
  next: CalendarHorizonRollCursor | null;
}

export interface CalendarEventRetentionResult {
  /** Idempotency commands older than the replay window, deleted for every owner. */
  commandsDeleted: number;
  /** Agent-owned cancellation tombstones older than the window whose commands are all gone. */
  tombstonesDeleted: number;
  /** True when either class filled its batch, so more rows may already be eligible. */
  hasMore: boolean;
}

/** What erasing a tenant deleted. */
export interface SlotlockTenantErasure {
  /** Rows deleted, by table (every table the tenant owns rows in is named, with 0 for none). */
  rows: Record<string, number>;
  /** Rows deleted in all; 0 when the tenant had already been erased. */
  total: number;
}

export interface BookingRetentionResult {
  /** Holds past their expiry: they occupy nothing, and only a rival's write would reap them. */
  expiredHoldsDeleted: number;
  /** Keyed hold answers older than the replay window: a retry with that key makes a new hold. */
  holdCommandsDeleted: number;
  /** Retired booking references older than the window: a create with one makes a new booking. */
  tombstonesDeleted: number;
  /** True when any class filled its batch, so more rows may already be eligible. */
  hasMore: boolean;
}

export interface CalendarCoverageCommand {
  tenantRef: string;
  resourceId: string;
  source: string;
  window: Interval;
  /** Provider/cursor revision, strictly increasing from one. */
  revision: number;
}

export type CalendarCoverageResult =
  | { ok: true; revision: number; idempotent: boolean }
  | { ok: false; code: 'invalid_identity' | 'invalid_window' | 'invalid_revision' }
  | { ok: false; code: 'resource_tenant_mismatch' }
  | { ok: false; code: 'stale_revision' | 'revision_conflict' | 'idempotency_conflict' }
  /** A new source would pass the tenant's `coverage` limit (advancing one it has never does). */
  | { ok: false; code: 'coverage_limit_reached'; limit: number };

export interface CalendarCoverageAssessment {
  state: 'complete' | 'partial' | 'unknown';
  /** Required sources that are absent, stale, or do not fully cover the requested window. */
  missingSources: string[];
}

export interface CalendarFreeBusy {
  busy: Interval[];
  coverage: CalendarCoverageAssessment;
}
