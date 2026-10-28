// Booking rules: what a write must satisfy, and the same rules applied to a search, so a slot a
// search offers is one a write accepts.
import { describe, expect, it } from 'vitest';
import {
  bookingBufferAfterMs,
  bookingRuleBroken,
  bookingSearch,
  nextStepStart,
  parseBookingRules,
} from '../booking-rules.js';
import { findNextAvailable } from '../engine.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const d = (iso: string) => new Date(iso);
const WEEKDAYS: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 8 * 60 },
];
// Monday 1 March 2027, 08:00 UTC.
const now = d('2027-03-01T08:00:00Z');
const broken = (rules: Parameters<typeof parseBookingRules>[0], start: string, end: string, timezone = 'UTC') =>
  bookingRuleBroken({
    rules: parseBookingRules(rules),
    timezone,
    hours: WEEKDAYS,
    interval: { start: d(start), end: d(end) },
    now,
  });

describe('booking rules', () => {
  it('reads only known rules within their bounds', () => {
    expect(parseBookingRules({ minNoticeMinutes: 120, slotStepMinutes: 15, enforceHours: true })).toEqual({
      minNoticeMinutes: 120,
      slotStepMinutes: 15,
      enforceHours: true,
    });
    expect(parseBookingRules({})).toEqual({});
    for (const bad of [
      null,
      [],
      { minNoticeMinutes: -1 },
      { maxAdvanceDays: 0 },
      { slotStepMinutes: 1.5 },
      { turnaroundMinutes: 1_441 },
      { enforceHours: 'yes' },
      { requireCertain: 1 },
      { bufferBeforeMinutes: 10 },
    ]) {
      expect(() => parseBookingRules(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('names the rule a booking breaks', () => {
    expect(broken({ minNoticeMinutes: 120 }, '2027-03-01T09:00:00Z', '2027-03-01T10:00:00Z')).toBe('min_notice');
    expect(broken({ minNoticeMinutes: 120 }, '2027-03-01T10:00:00Z', '2027-03-01T11:00:00Z')).toBeNull();
    expect(broken({ maxAdvanceDays: 7 }, '2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z')).toBe('max_advance');
    expect(broken({ maxAdvanceDays: 7 }, '2027-03-08T08:00:00Z', '2027-03-08T09:00:00Z')).toBeNull();
    expect(broken({ slotStepMinutes: 15 }, '2027-03-01T09:10:00Z', '2027-03-01T10:10:00Z')).toBe('slot_step');
    expect(broken({ slotStepMinutes: 15 }, '2027-03-01T09:45:00Z', '2027-03-01T10:45:00Z')).toBeNull();
    expect(broken({ enforceHours: true }, '2027-03-01T16:30:00Z', '2027-03-01T17:30:00Z')).toBe('outside_hours');
    expect(broken({ enforceHours: true }, '2027-03-06T10:00:00Z', '2027-03-06T11:00:00Z')).toBe('outside_hours');
    expect(broken({ enforceHours: true }, '2027-03-01T16:00:00Z', '2027-03-01T17:00:00Z')).toBeNull();
    expect(bookingRuleBroken({ rules: undefined, timezone: 'UTC', hours: [], interval: { start: now, end: now }, now })).toBeNull();
  });

  it('accepts a booking that spans adjoining bookable windows', () => {
    const split: WeeklyAvailabilityRule[] = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 3 * 60 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 12 * 60, durationMinutes: 3 * 60 },
    ];
    const interval = { start: d('2027-03-01T11:00:00Z'), end: d('2027-03-01T13:00:00Z') };
    expect(bookingRuleBroken({ rules: { enforceHours: true }, timezone: 'UTC', hours: split, interval, now })).toBeNull();
  });

  it('steps from local midnight in the resource’s zone, across a clock change too', () => {
    // Kolkata is UTC+05:30: 09:00 local is 03:30 UTC, on the hour there.
    expect(broken({ slotStepMinutes: 60 }, '2027-03-02T03:30:00Z', '2027-03-02T04:30:00Z', 'Asia/Kolkata')).toBeNull();
    expect(broken({ slotStepMinutes: 60 }, '2027-03-02T04:00:00Z', '2027-03-02T05:00:00Z', 'Asia/Kolkata')).toBe('slot_step');
    expect(nextStepStart(d('2027-03-02T03:31:00Z'), 30, 'Asia/Kolkata')).toEqual(d('2027-03-02T04:00:00Z'));
    // London springs forward at 01:00 UTC on 28 March 2027: 00:59 GMT is followed by 02:00 BST.
    const after = nextStepStart(d('2027-03-28T00:59:00Z'), 60, 'Europe/London');
    expect(after).toEqual(d('2027-03-28T01:00:00Z'));
    expect(nextStepStart(d('2027-03-01T10:00:00Z'), 15, 'UTC')).toEqual(d('2027-03-01T10:00:00Z'));
  });

  it('keeps the larger trailing buffer of the booking’s own and the turnaround', () => {
    expect(bookingBufferAfterMs({ turnaroundMinutes: 30 }, 0)).toBe(30 * 60_000);
    expect(bookingBufferAfterMs({ turnaroundMinutes: 30 }, 3_600_000)).toBe(3_600_000);
    expect(bookingBufferAfterMs(undefined, 5)).toBe(5);
  });

  it('makes a search offer only what a write accepts', () => {
    const rules = parseBookingRules({ minNoticeMinutes: 90, slotStepMinutes: 30, turnaroundMinutes: 30 });
    const window = { start: d('2027-03-01T00:00:00Z'), end: d('2027-03-02T00:00:00Z') };
    const search = bookingSearch({ rules, timezone: 'UTC', window, now });
    if (!search) throw new Error('no search');
    // Notice moves the start to 09:30; busy 09:40-10:00 then needs 30 minutes after a slot, so a
    // 30-minute slot at 09:30 (ending 10:00 + 30) runs into it. The next step after it is 10:00.
    const busy = [{ start: d('2027-03-01T09:40:00Z'), end: d('2027-03-01T10:00:00Z') }];
    const slot = findNextAvailable({
      busy: busy.map((b) => ({ start: new Date(b.start.getTime() - search.bufferAfterMs), end: b.end })),
      windows: [search.window],
      durationMs: 30 * 60_000,
      ...(search.align ? { align: search.align } : {}),
    });
    expect(slot).toEqual({ start: d('2027-03-01T10:00:00Z'), end: d('2027-03-01T10:30:00Z') });
    if (!slot) throw new Error('no slot');
    expect(bookingRuleBroken({ rules, timezone: 'UTC', hours: [], interval: slot, now })).toBeNull();
  });

  it('offers nothing past the latest start a booking may have', () => {
    const rules = parseBookingRules({ maxAdvanceDays: 1 });
    const window = { start: d('2027-03-05T00:00:00Z'), end: d('2027-03-06T00:00:00Z') };
    expect(bookingSearch({ rules, timezone: 'UTC', window, now })).toBeNull();
    const near = bookingSearch({ rules, timezone: 'UTC', window: { start: now, end: d('2027-03-03T00:00:00Z') }, now });
    if (!near?.align) throw new Error('no search');
    const slot = findNextAvailable({
      busy: [{ start: now, end: d('2027-03-02T08:30:00Z') }],
      windows: [near.window],
      durationMs: 60 * 60_000,
      align: near.align,
    });
    // The only free time starts after the latest allowed start (08:00 on the 2nd).
    expect(slot).toBeNull();
  });
});
