import type { SlotlockBookingRule, SlotlockBookingRules } from './booking-rules.js';
import type { SlotlockResourceAttributes, SlotlockResourceKind } from './resource-profile.js';
// Every interval is half-open `[start, end)`: back-to-back reservations do not conflict, matching
// RFC 5545 and PostgreSQL range semantics.

/** Half-open time interval `[start, end)`. */
export interface Interval {
  start: Date;
  end: Date;
}

/** Hours a resource without its own inherits, as the database resolves them (RFC 0004 B2). */
export interface SlotlockInheritedAvailability {
  source: 'location' | 'tenant';
  /** The location whose hours apply, when `source` is `location`. */
  location?: string;
  rules: WeeklyAvailabilityRule[];
}

/** A schedulable resource (vehicle, room, worker, machine, or any other reservable asset). */
export interface SlotlockResource {
  id: string;
  externalRef: string | null;
  /** Null only for legacy/parity-shadow resources created before authority primitives existed. */
  tenantRef: string | null;
  /**
   * IANA timezone the availability rules are authored in: expandRules evaluates BYDAY and
   * startMinutes as local wall-clock time in this zone, so rules stay stable across daylight-saving
   * changes.
   */
  timezone: string;
  /**
   * The resource's own weekly bookable hours, in `timezone`; `[]` is never bookable. Absent when it
   * uses the default (`SLOTLOCK_AVAILABILITY`, or the backend's `availabilityRules`).
   */
  availabilityRules?: WeeklyAvailabilityRule[];
  /**
   * The hours it inherits when it has none of its own (RFC 0004 B2): its location's, the nearest
   * up the chain, else its tenant's. Absent when it has its own, or inherits the server's.
   */
  inheritedAvailability?: SlotlockInheritedAvailability;
  /**
   * `shared` resources are listed to and booked by agents; `private` ones are invisible to agents.
   * Fixed at creation; absent means shared.
   */
  visibility?: 'shared' | 'private';
  /** When the tenant archived it: no longer listed or booked, its history kept. Absent in use. */
  archivedAt?: Date;
  /** Its own booking rules (`SlotlockBookingRules`). Absent when it has none. */
  bookingRules?: SlotlockBookingRules;
  /**
   * What a booking on it must satisfy: tenant defaults, overlaid by its pool's, overlaid by its own
   * (`setBookingRuleDefaults`). Absent when no rule applies.
   */
  effectiveBookingRules?: SlotlockBookingRules;
  /**
   * Its pool: interchangeable resources (a vehicle class, a room type) booked by the class
   * (`slotlock_book_pool`).
   */
  pool?: string;
  /**
   * The composite it is a part of (RFC 0003 G8), and its place there: a booking of the whole
   * conflicts with every part. Absent when it is no part.
   */
  parentId?: string;
  partIndex?: number;
  /** Its name, shown instead of `externalRef` (resource-profile.ts). Absent when it has none. */
  name?: string;
  /** What it is, in a sentence or a paragraph. Absent when it has none. */
  description?: string;
  /** What kind of thing it is, a hint for filtering that changes no booking. Absent: `other`. */
  kind?: SlotlockResourceKind;
  /** How many people or seats it holds, said for people to read; never enforced. Absent: not said. */
  capacity?: number;
  /** Labels to find it by, sorted. Absent when it has none. */
  labels?: string[];
  /** What the integrator keeps on it. Absent when it has none. */
  attributes?: SlotlockResourceAttributes;
  /** The reference of the location it is at (resource-profile.ts). Absent when not said. */
  location?: string;
  /** That location's name. */
  locationName?: string;
  /** The references of the groups it is in, sorted. Absent when it is in none. */
  groups?: string[];
}

/** Which writes an approval policy covers (RFC 0004 A4); none named is every write it applies to. */
export type SlotlockApprovalKind = 'single' | 'pool' | 'bundle' | 'move';

/** A tenant's approval policy (RFC 0004 A4). */
export interface SlotlockApprovalPolicy {
  ref: string;
  name: string;
  /** The resources it applies to; every one when all are empty. */
  appliesTo: { resourceIds?: string[]; pools?: string[]; locations?: string[]; groups?: string[] };
  /** What makes a write need it; a write meets it when it meets every condition given. */
  conditions: { longerThanMinutes?: number; outsideHours?: boolean; kinds?: SlotlockApprovalKind[] };
  outcome: 'require_approval' | 'refuse';
  /** How long a person has to decide, before the booking's start less `leadMinutes`. */
  approvalTtlMinutes: number;
  leadMinutes: number;
  /**
   * It also holds the tenant's own bookings through the application API (bundles and pool
   * bookings); without it, it holds only agents' (RFC 0004 B7).
   */
  includeApplication: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A write waiting for a person, or decided (RFC 0004 A4). */
export interface SlotlockApproval {
  id: string;
  policyRef: string;
  status: 'pending' | 'granted' | 'declined' | 'expired';
  /** The agent operation it runs when granted, and its arguments. */
  operation: 'slotlock_create_event' | 'slotlock_book_together' | 'slotlock_update_event';
  request: Record<string, unknown>;
  /** Who asked, as the history names an actor (the principal's subject, at most 200 characters). */
  requestedBy: string | null;
  /** The resources and time it holds while it waits. */
  holdIds: string[];
  resourceIds: string[];
  start: Date;
  end: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * A booking, hold or event occurrence as a refusal can name it (`describeBooking`): the time it
 * occupies, buffers included, and whose it is, so a caller is told only what it may see.
 */
export interface SlotlockBookingDescription {
  id: string;
  resourceId: string;
  status: 'held' | 'confirmed';
  /** The holder of a hold, as the store was given it; null otherwise. */
  holderRef: string | null;
  /** The calendar event this is an occurrence of (its id and reference), and its owner; null for a booking. */
  eventId: string | null;
  eventRef: string | null;
  eventOwnerRef: string | null;
  start: Date;
  end: Date;
}

/** A confirmed occupation of a resource. The DB EXCLUDE constraint is the overlap arbiter. */
export interface SlotlockReservation {
  id: string;
  resourceId: string;
  /** Null only for live holds, rows on a tenantless (legacy) resource, and parity-shadow rows. */
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
  /** Whom to tell about it (RFC 0004 P3), when it names someone. */
  contactRef?: string;
  /** Present, and false, when no one should be notified about it. */
  notify?: false;
  /** Minutes before its start it is reminded, latest first, when it is. */
  reminderMinutes?: number[];
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
  /**
   * An admin's reason for moving the booking past its reschedule cutoff (RFC 0004 B5), kept on the
   * feed. Without it, a move past the cutoff is refused.
   */
  overrideReason?: string;
  /**
   * The wall time the booking starts at in its resource's zone, `YYYY-MM-DDTHH:MM[:SS]` (RFC 0004
   * B9): it must name `start` now, and if zone rules later move it, maintenance says so or follows
   * it (`followZoneRules`). Left out, the booking keeps its instant only.
   */
  localStart?: string;
  /**
   * Whom to tell about it (RFC 0004 P3): a contact's reference (`putContact`), never the person.
   * Put on the feed with each of its changes; a sender looks the person up by it.
   */
  contactRef?: string;
  /** False: no sender should notify anyone about it (default true). On the feed only when false. */
  notify?: boolean;
  /**
   * Minutes before its start to remind whom it names (RFC 0004 P3): up to five, each 0 to a year,
   * said on the feed once each as `reminder.due` by maintenance, and again if the booking moves.
   */
  reminderMinutes?: number[];
}

/** What a cancellation records for the integrator to charge (RFC 0004 B5). Slotlock moves no money. */
export interface SlotlockRecordedFee {
  amountMinor: number;
  currency: string;
}

export type ExternalReservationResult =
  | { ok: true; reservation: SlotlockReservation; idempotent: boolean }
  | { ok: false; code: 'invalid_window' }
  /** `localStart` is not a wall time, or does not name `start` in the resource's zone. */
  | { ok: false; code: 'invalid_local_start' }
  | { ok: false; code: 'invalid_contact_ref' | 'invalid_notify' | 'invalid_reminders' }
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
  /** The booking breaks one of the resource's booking rules (`SlotlockResource.bookingRules`). */
  | { ok: false; code: 'booking_rule_violated'; rule: SlotlockBookingRule }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type CancelExternalReservationResult =
  | { ok: true; cancelled: boolean; revision: number; cancellationFee?: SlotlockRecordedFee }
  /** The booking's cancel cutoff has passed (RFC 0004 B5): an admin may override with a reason. */
  | { ok: false; code: 'booking_rule_violated'; rule: 'cancel_cutoff' }
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
 * VAVAILABILITY-style bookable window (RFC 7953, weekly subset): a weekly RRULE picks the days, and
 * each day's window is `[startMinutes, startMinutes+durationMinutes)` after local midnight in the
 * evaluation timezone (UTC when none is given).
 */
export interface WeeklyAvailabilityRule {
  /** RRULE content line without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`. */
  rrule: string;
  /** Window start, minutes after local midnight (0..1439). */
  startMinutes: number;
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
  /** The booking breaks one of the resource's booking rules (`SlotlockResource.bookingRules`). */
  | { ok: false; code: 'booking_rule_violated'; rule: SlotlockBookingRule }
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
  /** The alternatives it was held with (`groupId` when acquired); absent when held alone. */
  groupId?: string;
  /** Present when it waits for payment (RFC 0004 C3): it is confirmed only once paid. */
  paymentRequired?: true;
  /** The payment's reference at the integrator's processor, once paid. */
  paymentRef?: string | null;
  paidAt?: Date | null;
  /** What the payment must be, when the hold names it. */
  paymentAmount?: { amountMinor: number; currency: string } | null;
  /** What was received, once paid and when the payer said. */
  paidAmount?: { amountMinor: number; currency: string } | null;
}

/** One entry of a tenant's agenda (`listAgenda`): what occupies a resource, and from when. */
export interface SlotlockAgendaEntry {
  id: string;
  resourceId: string;
  start: Date;
  end: Date;
  kind: 'booking' | 'event' | 'hold';
  /** The booking's reference; null for an event's occurrence and a hold. */
  reference: string | null;
  /** The calendar event's summary; null for a booking and a hold. */
  summary: string | null;
  /** When the hold lapses; null for a booking and an event. */
  expiresAt: Date | null;
  source: string | null;
}

export type AcquireHoldResult =
  /** `idempotent`: a retry of a keyed hold, answered with the hold the first request made. */
  | { ok: true; hold: SlotlockHold; idempotent: boolean }
  | { ok: false; code: 'invalid_window' }
  | { ok: false; code: 'invalid_ttl' }
  /** `payment` without `paymentRequired`, or not an amount and an ISO 4217 currency. */
  | { ok: false; code: 'invalid_payment' }
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
  /** The resource's tenant has as many holds as its `holds` limit, expired ones deleted. */
  | { ok: false; code: 'hold_limit_reached'; limit: number }
  /**
   * The holder's live holds would together hold more hours than `maxHeldHoursPerHolder` allows
   * (`limit`, in hours): one agent cannot keep a resource's month from everyone, a hold at a time.
   */
  | { ok: false; code: 'held_time_limit_reached'; limit: number }
  /** The booking breaks one of the resource's booking rules (`SlotlockResource.bookingRules`). */
  | { ok: false; code: 'booking_rule_violated'; rule: SlotlockBookingRule }
  | { ok: false; code: 'overlap'; conflictingReservationId: string | null };

export type ConfirmHoldResult =
  | { ok: true; reservation: SlotlockReservation }
  | { ok: false; code: 'hold_not_found' }
  | { ok: false; code: 'hold_expired' }
  /** The hold waits for payment (RFC 0004 C3) and none is recorded yet (markHoldPaid). */
  | { ok: false; code: 'payment_required' }
  /** A cancellation of the hold's reference (its id) arrived first and retired it. */
  | { ok: false; code: 'reservation_cancelled' }
  /** Another booking of the tenant already uses the hold's id as its reference. */
  | { ok: false; code: 'idempotency_conflict' }
  /** The hold's resource was archived since: it takes no new booking. */
  | { ok: false; code: 'resource_archived' }
  /** The tenant is at its `reservations` limit: the hold stays a hold. */
  | { ok: false; code: 'reservation_limit_reached'; limit: number };

export type ReleaseHoldResult = { ok: true; released: boolean };

/**
 * A person a booking may name to be told about it (RFC 0004 P3), by the tenant's own reference: how
 * to reach them, and which channels they agreed to. A sender reads it; Slotlock sends nothing.
 */
export interface SlotlockContact {
  ref: string;
  name: string | null;
  email: string | null;
  /** E.164, for SMS. */
  phone: string | null;
  /** E.164, for WhatsApp. */
  whatsapp: string | null;
  /** Each channel the person said yes or no to; a channel left out has no answer recorded. */
  consent: SlotlockContactConsent;
  /** When each answer in `consent` was given (kept while it stands): the proof of it. */
  consentAt: Partial<Record<keyof SlotlockContactConsent, Date>>;
  /** BCP 47, for the language of what is sent. */
  locale: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlotlockContactConsent {
  email?: boolean;
  sms?: boolean;
  whatsapp?: boolean;
}

export type PutContactResult =
  | { ok: true; contact: SlotlockContact; created: boolean }
  | { ok: false; code: 'invalid_contact_ref' | 'invalid_contact' }
  | { ok: false; code: 'contact_limit_reached'; limit: number };

/** Recording a hold's payment (RFC 0004 C3); `idempotent` when it was recorded already. */
export type MarkHoldPaidResult =
  | { ok: true; hold: SlotlockHold; idempotent: boolean }
  | { ok: false; code: 'invalid_identity' | 'invalid_payment_ref' | 'invalid_payment' }
  /** Less than the hold's payment, in another currency, or not said when the hold names one. */
  | { ok: false; code: 'payment_amount_mismatch' }
  | { ok: false; code: 'hold_not_found' | 'hold_expired' }
  /** The hold does not wait for payment. */
  | { ok: false; code: 'payment_not_required' }
  /** It was already paid by another payment. */
  | { ok: false; code: 'payment_conflict' };

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
  /**
   * Judge the event as a booking made now against the resource's booking rules (first occurrence
   * for notice and advance, every occurrence for step and hours), and keep the resource's
   * turnaround. Off by default, since an imported event already happened elsewhere; the agent tools
   * set it.
   */
  enforceBookingRules?: boolean;
  /**
   * Book the time a live hold keeps: the hold must be `holderRef`'s, on this resource, and cover
   * the event (a single occurrence). The hold's group is released and the event takes the time in
   * one transaction, so no rival can come between. Notice and advance were judged at hold time;
   * step and hours are judged again.
   */
  fromHold?: { holdId: string; holderRef: string };
  /**
   * False: no sender should notify anyone about it (RFC 0004 P3), and its reminders are not put on
   * the feed. Default true; as sent with each revision.
   */
  notify?: boolean;
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
  /** `fromHold` names no hold of that holder's: released, booked, reaped, or another's. */
  | { ok: false; code: 'hold_not_found' }
  /** `fromHold`'s hold is the holder's, but it lapsed before it was booked. */
  | { ok: false; code: 'hold_expired' }
  /** `fromHold`'s hold waits for payment (RFC 0004 C3) and none is recorded yet. */
  | { ok: false; code: 'payment_required' }
  /** `fromHold`'s hold is on another resource, or does not cover the event. */
  | { ok: false; code: 'hold_mismatch' }
  /**
   * A recurring event on the resource is not stored as far as this write reaches, and cannot be
   * extended that far (past the rolling horizon, or blocked): the time cannot be proven free.
   */
  | { ok: false; code: 'recurrence_not_materialized' }
  /** The booking breaks one of the resource's booking rules (`SlotlockResource.bookingRules`). */
  | { ok: false; code: 'booking_rule_violated'; rule: SlotlockBookingRule }
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
      /** What a late cancellation costs, recorded for the integrator to charge (RFC 0004 B5). */
      cancellationFee?: SlotlockRecordedFee;
    }
  | { ok: false; code: 'invalid_identity' }
  | { ok: false; code: 'invalid_revision' }
  | { ok: false; code: 'idempotency_conflict' }
  | { ok: false; code: 'event_not_found' }
  | { ok: false; code: 'owner_command_quota_exceeded'; limit: number }
  | { ok: false; code: 'revision_conflict'; currentRevision: number }
  /** The event's cancel cutoff has passed (RFC 0004 B5). */
  | { ok: false; code: 'booking_rule_violated'; rule: 'cancel_cutoff' };

/** A place in the roll's order of due masters: the last one a batch examined. */
export interface CalendarHorizonRollCursor {
  /**
   * When the master was due again, if the roll had deferred it; null (or missing, from an older
   * cursor) when not.
   */
  rollRetryAt?: Date | null;
  materializedEndsAt: Date;
  eventId: string;
}

/** Content-minimized outcome of one bounded recurring-event horizon maintenance batch. */
export interface CalendarHorizonRollResult {
  examined: number;
  /**
   * Masters rematerialized through the later of their stored end and the window's: a roll never
   * moves a series' end back.
   */
  extended: number;
  /** Masters whose new occurrence collided: their coverage stays, and they are deferred an hour. */
  conflicts: number;
  /** The ids of those masters: what blocks each is a booking or hold on its new occurrences. */
  conflictEventIds: string[];
  /**
   * Masters over the expansion budget, or whose roll failed otherwise: their coverage stays, and
   * they are deferred an hour.
   */
  refused: number;
  refusedEventIds: string[];
  /** True when more due masters remain beyond this bounded batch. */
  hasMore: boolean;
  /**
   * Pass as `after` for the next batch, so this batch's masters are not examined again. `null` when
   * none remain.
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

/** A tenant's default booking rules (`SlotlockStore.getBookingRuleDefaults`). */
export interface SlotlockBookingRuleDefaults {
  /** The tenant's own defaults, under every pool's; null when it has none. */
  tenant: SlotlockBookingRules | null;
  /** Each pool's defaults, by pool name, for the pools that have them. */
  pools: Record<string, SlotlockBookingRules>;
}

export interface SlotlockTenantErasure {
  /** Rows deleted, by table (every table the tenant owns rows in is named, with 0 for none). */
  rows: Record<string, number>;
  /** Rows deleted in all; 0 when the tenant had already been erased. */
  total: number;
}

export interface BookingRetentionResult {
  /** Holds past their expiry: they occupy nothing, but only a rival's write would reap them. */
  expiredHoldsDeleted: number;
  /** Keyed hold answers whose hold has expired: a retry with that key makes a new hold. */
  holdCommandsDeleted: number;
  /**
   * References a cancel retired with no booking, older than the window. A cancelled booking's
   * reference stays retired.
   */
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

/**
 * What a calendar that gives busy time but not its events says (Google freeBusy, Microsoft
 * getSchedule; RFC 0004 C1): its coverage of the window, and the busy time in it, which replaces
 * what the source said of that window before.
 */
export interface SourceBusyCommand extends CalendarCoverageCommand {
  /** At most SLOTLOCK_SOURCE_BUSY_MAX intervals; clipped to the window and merged. */
  busy: Interval[];
}

export type SourceBusyResult =
  | {
      ok: true;
      revision: number;
      /** A revision already recorded: nothing changed. */
      idempotent: boolean;
      /** How many intervals are kept, merged and clipped. */
      busy: number;
      /** Bookings the source newly reports in the way of, each put on the feed as coverage.conflict. */
      conflicts: number;
    }
  | Exclude<CalendarCoverageResult, { ok: true }>
  | { ok: false; code: 'invalid_busy' };

export interface CalendarCoverageAssessment {
  state: 'complete' | 'partial' | 'unknown';
  /** Required sources that are absent, stale, or do not fully cover the requested window. */
  missingSources: string[];
}

export interface CalendarFreeBusy {
  busy: Interval[];
  coverage: CalendarCoverageAssessment;
}
