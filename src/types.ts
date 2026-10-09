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
}

/** A confirmed occupation of a resource. The DB EXCLUDE constraint is the overlap arbiter. */
export interface SlotlockReservation {
  id: string;
  resourceId: string;
  /** Null only for legacy, hold, and parity-shadow rows. */
  tenantRef: string | null;
  /** Stable booking identity inside tenantRef; null for legacy, hold, and shadow rows. */
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
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type CancelExternalReservationResult =
  | { ok: true; cancelled: boolean; revision: number }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'reservation_cancelled' }
  | { ok: false; code: 'stale_revision' }
  | { ok: false; code: 'revision_conflict' };

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
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

/** A hold: occupies exactly like a reservation until its DB-clock expiry, then lazily reaped. */
export interface SlotlockHold {
  id: string;
  resourceId: string;
  start: Date;
  end: Date;
  expiresAt: Date;
  source: string | null;
}

export type AcquireHoldResult =
  | { ok: true; hold: SlotlockHold }
  | { ok: false; code: 'invalid_window' }
  | { ok: false; code: 'invalid_ttl' }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type ConfirmHoldResult =
  | { ok: true; reservation: SlotlockReservation }
  | { ok: false; code: 'hold_not_found' }
  | { ok: false; code: 'hold_expired' };

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
  | { ok: false; code: 'resource_tenant_mismatch' }
  | { ok: false; code: 'event_cancelled'; currentRevision: number }
  | { ok: false; code: 'revision_conflict'; currentRevision: number }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

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

/** Content-minimized outcome of one bounded recurring-event horizon maintenance batch. */
export interface CalendarHorizonRollResult {
  /** Due recurring masters examined in deterministic order. */
  examined: number;
  /** Masters atomically rematerialized to the requested window. */
  extended: number;
  /** Masters whose new occurrence collided; their previous coverage remains intact. */
  conflicts: number;
  /** True when more due masters remain beyond this bounded batch. */
  hasMore: boolean;
}

export interface CalendarEventRetentionResult {
  /** Idempotency commands older than the replay window, deleted for every owner. */
  commandsDeleted: number;
  /** Agent-owned cancellation tombstones older than the window whose commands are all gone. */
  tombstonesDeleted: number;
  /** True when either class filled its batch, so more rows may already be eligible. */
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
  | { ok: false; code: 'stale_revision' | 'revision_conflict' | 'idempotency_conflict' };

export interface CalendarCoverageAssessment {
  state: 'complete' | 'partial' | 'unknown';
  /** Required sources that are absent, stale, or do not fully cover the requested window. */
  missingSources: string[];
}

export interface CalendarFreeBusy {
  busy: Interval[];
  coverage: CalendarCoverageAssessment;
}
