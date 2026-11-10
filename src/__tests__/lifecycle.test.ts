// The written booking lifecycle (RFC 0004 B4): every status and action has a move or a refusal,
// the ends move nowhere but to erasure, and every change named is one the feed knows.
import { describe, expect, it } from 'vitest';
import { SLOTLOCK_CHANGE_TYPES } from '../event-feed.js';
import {
  SLOTLOCK_BOOKING_ACTIONS,
  SLOTLOCK_BOOKING_ENDS,
  SLOTLOCK_BOOKING_STATUSES,
  SLOTLOCK_BOOKING_TRANSITIONS,
  slotlockBookingNext,
} from '../lifecycle.js';

describe('the booking lifecycle', () => {
  it('answers every status and action with a move or a refusal', () => {
    for (const from of SLOTLOCK_BOOKING_STATUSES) {
      for (const action of SLOTLOCK_BOOKING_ACTIONS) {
        const next = slotlockBookingNext(from, action);
        if (next.ok) {
          expect(SLOTLOCK_BOOKING_STATUSES).toContain(next.to);
          for (const change of next.changes) expect(SLOTLOCK_CHANGE_TYPES).toContain(change);
        } else {
          expect(next.code).toMatch(/^[a-z_]+$/);
          expect(SLOTLOCK_BOOKING_TRANSITIONS[from][action]).toBeUndefined();
        }
      }
    }
  });

  it.each([
    ['held', 'confirm', 'confirmed', ['hold.confirmed']],
    ['held', 'release', 'released', ['hold.released']],
    ['held', 'expire', 'expired', ['hold.expired']],
    ['held', 'reschedule', 'held', ['hold.updated']],
    ['confirmed', 'reschedule', 'confirmed', ['reservation.updated', 'reservation.rescheduled']],
    ['confirmed', 'check_in', 'checked_in', ['reservation.checked_in']],
    ['confirmed', 'cancel', 'cancelled', ['reservation.cancelled']],
    ['confirmed', 'no_show', 'no_show', ['reservation.no_show']],
    ['confirmed', 'complete', 'completed', ['reservation.completed']],
    ['checked_in', 'check_in', 'checked_in', []],
    ['checked_in', 'complete', 'completed', ['reservation.completed']],
    ['completed', 'cancel', 'cancelled', ['reservation.cancelled']],
    ['cancelled', 'erase', 'erased', []],
  ] as const)('moves %s by %s to %s', (from, action, to, changes) => {
    expect(slotlockBookingNext(from, action)).toEqual({ ok: true, to, changes });
  });

  it.each([
    ['held', 'cancel', 'reservation_not_found'],
    ['held', 'check_in', 'reservation_not_found'],
    ['confirmed', 'confirm', 'hold_not_found'],
    ['checked_in', 'no_show', 'reservation_checked_in'],
    ['completed', 'check_in', 'reservation_ended'],
    ['completed', 'no_show', 'reservation_ended'],
    ['cancelled', 'reschedule', 'reservation_cancelled'],
    ['cancelled', 'check_in', 'reservation_not_found'],
    ['no_show', 'cancel', 'reservation_cancelled'],
    ['released', 'confirm', 'hold_not_found'],
    ['expired', 'confirm', 'hold_expired'],
    ['erased', 'reschedule', 'not_found'],
  ] as const)('refuses %s by %s with %s', (from, action, code) => {
    expect(slotlockBookingNext(from, action)).toEqual({ ok: false, code });
  });

  it('lets an end move only to erasure', () => {
    for (const end of SLOTLOCK_BOOKING_ENDS) {
      const allowed = Object.keys(SLOTLOCK_BOOKING_TRANSITIONS[end]);
      expect(allowed.every((action) => action === 'erase')).toBe(true);
    }
  });
});
