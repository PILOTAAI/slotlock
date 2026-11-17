// The booking lifecycle, written down (RFC 0004 B4): every status a hold or booking can be in, the
// move each action makes from each, the feed change it writes, and the refusal every other move
// gets, as the store answers them. A table test holds the store to it.
//
// A hold is a `reservations` row with status `held`; a booking one with status `confirmed`, checked
// in when `checked_in_at` is set, and completed once its end has passed (no row changes then: the
// feed says `reservation.completed`). A booking that ends otherwise leaves the table, and its
// reference a tombstone that keeps why (`end_reason`): cancelled or no_show. A hold that ends
// leaves no tombstone: released or expired are on the feed. Erasure takes everything, and tells no
// one.
import type { SlotlockChangeType } from './event-feed.js';

export const SLOTLOCK_BOOKING_STATUSES = Object.freeze([
  'held',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
  'released',
  'expired',
  'erased',
] as const);
export type SlotlockBookingStatus = (typeof SLOTLOCK_BOOKING_STATUSES)[number];

/** What moves a hold or booking, and who does it. */
export const SLOTLOCK_BOOKING_ACTIONS = Object.freeze([
  /** The holder books the held time (confirmHold, slotlock_confirm_slot). */
  'confirm',
  /** The holder lets the hold go (releaseHold, slotlock_release_slots). */
  'release',
  /** Its time to live runs out; the next writer in its way reaps it. */
  'expire',
  /** A new time or resource, at the next revision (rescheduleExternalReservation). */
  'reschedule',
  /** Claimed in person (checkInReservation), from an hour before the start until the end. */
  'check_in',
  /** Cancelled at the next revision (cancelExternalReservation). */
  'cancel',
  /** Not checked in within the resource's checkInMinutes: maintenance releases it. */
  'no_show',
  /** Its end passes: maintenance says so on the feed. */
  'complete',
  /** The tenant is erased. */
  'erase',
] as const);
export type SlotlockBookingAction = (typeof SLOTLOCK_BOOKING_ACTIONS)[number];

/** Where an end leaves a hold or booking: nothing moves it again, but erasure. */
export const SLOTLOCK_BOOKING_ENDS: ReadonlySet<SlotlockBookingStatus> = new Set([
  'cancelled',
  'no_show',
  'released',
  'expired',
  'erased',
]);

/** Why a tombstoned reference ended, as `reservation_tombstones.end_reason` keeps it. */
export type SlotlockEndReason = 'cancelled' | 'no_show' | 'released' | 'expired' | 'erased';

type Move = { to: SlotlockBookingStatus; change: SlotlockChangeType | readonly SlotlockChangeType[] | null };

/**
 * Each allowed move: the status it leads to and the feed change it writes (null: none; a list: all
 * of them, in order). Anything not here is refused with `SLOTLOCK_BOOKING_REFUSALS`.
 */
export const SLOTLOCK_BOOKING_TRANSITIONS: Readonly<
  Record<SlotlockBookingStatus, Readonly<Partial<Record<SlotlockBookingAction, Move>>>>
> = Object.freeze({
  held: {
    confirm: { to: 'confirmed', change: 'hold.confirmed' },
    release: { to: 'released', change: 'hold.released' },
    expire: { to: 'expired', change: 'hold.expired' },
    reschedule: { to: 'held', change: 'hold.updated' },
    erase: { to: 'erased', change: null },
  },
  confirmed: {
    reschedule: { to: 'confirmed', change: ['reservation.updated', 'reservation.rescheduled'] },
    check_in: { to: 'checked_in', change: 'reservation.checked_in' },
    cancel: { to: 'cancelled', change: 'reservation.cancelled' },
    no_show: { to: 'no_show', change: 'reservation.no_show' },
    complete: { to: 'completed', change: 'reservation.completed' },
    erase: { to: 'erased', change: null },
  },
  checked_in: {
    reschedule: { to: 'checked_in', change: ['reservation.updated', 'reservation.rescheduled'] },
    // Checking in again answers the first check-in.
    check_in: { to: 'checked_in', change: null },
    cancel: { to: 'cancelled', change: 'reservation.cancelled' },
    complete: { to: 'completed', change: 'reservation.completed' },
    erase: { to: 'erased', change: null },
  },
  completed: {
    // A system of record may correct or void a booking after it ended.
    reschedule: { to: 'completed', change: ['reservation.updated', 'reservation.rescheduled'] },
    cancel: { to: 'cancelled', change: 'reservation.cancelled' },
    erase: { to: 'erased', change: null },
  },
  cancelled: { erase: { to: 'erased', change: null } },
  no_show: { erase: { to: 'erased', change: null } },
  released: {},
  expired: {},
  erased: {},
});

/** The refusal a move gets from a status it is not allowed from, as the store names it. */
export function slotlockBookingRefusal(from: SlotlockBookingStatus, action: SlotlockBookingAction): string {
  const holdAction = action === 'confirm' || action === 'release' || action === 'expire';
  switch (from) {
    case 'held':
      // A hold is not a booking: booking operations do not find it.
      return 'reservation_not_found';
    case 'confirmed':
    case 'checked_in':
      if (holdAction) return 'hold_not_found';
      // Only maintenance releases no-shows, and never one checked in.
      return 'reservation_checked_in';
    case 'completed':
      return holdAction ? 'hold_not_found' : 'reservation_ended';
    case 'cancelled':
    case 'no_show':
      // The reference is retired: writing it again is refused, checking it in finds nothing.
      return action === 'check_in' ? 'reservation_not_found' : holdAction ? 'hold_not_found' : 'reservation_cancelled';
    case 'released':
      return action === 'confirm' ? 'hold_not_found' : 'not_found';
    case 'expired':
      return action === 'confirm' ? 'hold_expired' : 'not_found';
    case 'erased':
      return 'not_found';
  }
}

/** What `action` does from `from`: the status it leads to and the change it writes, or its refusal. */
export function slotlockBookingNext(
  from: SlotlockBookingStatus,
  action: SlotlockBookingAction,
):
  | { ok: true; to: SlotlockBookingStatus; changes: readonly SlotlockChangeType[] }
  | { ok: false; code: string } {
  const move = SLOTLOCK_BOOKING_TRANSITIONS[from][action];
  if (!move) return { ok: false, code: slotlockBookingRefusal(from, action) };
  const changes = move.change === null ? [] : typeof move.change === 'string' ? [move.change] : move.change;
  return { ok: true, to: move.to, changes };
}
