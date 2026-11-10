// Durations and hires across days (RFC 0004 B3): the booking rules for lengths, pick-up and return
// times, longer turnarounds, and the range search for hires.
import { describe, expect, it } from 'vitest';
import {
  bookingRuleBroken,
  bookingSearch,
  isMultiDay,
  parseBookingRules,
  parseEffectiveBookingRules,
} from '../booking-rules.js';
import { findEarliestRange, sameTimeDaysLater } from '../ranges.js';

const EVERY_DAY = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';
const OPEN_8_TO_18 = [{ rrule: EVERY_DAY, startMinutes: 8 * 60, durationMinutes: 10 * 60 }];
const ALL_DAY = [{ rrule: EVERY_DAY, startMinutes: 0, durationMinutes: 1_440 }];
const NOW = new Date('2027-03-01T00:00:00Z');
const at = (iso: string) => new Date(iso);
const judge = (rules: Parameters<typeof parseBookingRules>[0], start: string, end: string, hours = ALL_DAY) =>
  bookingRuleBroken({
    rules: parseBookingRules(rules),
    timezone: 'UTC',
    hours,
    interval: { start: at(start), end: at(end) },
    now: NOW,
  });

describe('duration rules', () => {
  it('parse, and refuse lengths none can have', () => {
    expect(
      parseBookingRules({ minDurationMinutes: 60, maxDurationMinutes: 240, allowedDurations: [120, 60], defaultDurationMinutes: 60 }),
    ).toEqual({ minDurationMinutes: 60, maxDurationMinutes: 240, allowedDurations: [60, 120], defaultDurationMinutes: 60 });
    expect(() => parseBookingRules({ minDurationMinutes: 120, maxDurationMinutes: 60 })).toThrow(/must not exceed/);
    expect(() => parseBookingRules({ minDurationMinutes: 120, allowedDurations: [60] })).toThrow(/no length/);
    expect(() => parseBookingRules({ allowedDurations: [60], defaultDurationMinutes: 90 })).toThrow(/defaultDurationMinutes/);
    expect(() => parseBookingRules({ allowedDurations: [60, 60] })).toThrow(/different/);
    expect(() => parseBookingRules({ pickupTimes: [] })).toThrow(/pickupTimes/);
    expect(() => parseBookingRules({ returnTimes: [{ startMinutes: 1_440, durationMinutes: 60 }] })).toThrow(/returnTimes/);
    // A turnaround of up to a week.
    expect(parseBookingRules({ turnaroundMinutes: 2_880 })).toEqual({ turnaroundMinutes: 2_880 });
    expect(() => parseBookingRules({ turnaroundMinutes: 10_081 })).toThrow(/0-10080/);
  });

  it('refuse a merge of levels that leaves no length', () => {
    expect(parseEffectiveBookingRules({ minDurationMinutes: 120, maxDurationMinutes: 60 }).dropped).toEqual(['durations']);
  });

  it('judge a booking by its length', () => {
    const rules = { minDurationMinutes: 60, maxDurationMinutes: 180, allowedDurations: [60, 120, 180] };
    expect(judge(rules, '2027-03-02T10:00:00Z', '2027-03-02T10:30:00Z')).toBe('min_duration');
    expect(judge(rules, '2027-03-02T10:00:00Z', '2027-03-02T14:00:00Z')).toBe('max_duration');
    expect(judge(rules, '2027-03-02T10:00:00Z', '2027-03-02T11:30:00Z')).toBe('duration_not_allowed');
    expect(judge(rules, '2027-03-02T10:00:00Z', '2027-03-02T12:00:00Z')).toBeNull();
  });

  it('let a search find nothing of a length the rules refuse', () => {
    const window = { start: at('2027-03-02T00:00:00Z'), end: at('2027-03-03T00:00:00Z') };
    const rules = parseBookingRules({ allowedDurations: [60] });
    expect(bookingSearch({ rules, timezone: 'UTC', window, now: NOW, durationMs: 90 * 60_000 })).toBeNull();
    expect(bookingSearch({ rules, timezone: 'UTC', window, now: NOW, durationMs: 60 * 60_000 })).not.toBeNull();
  });
});

describe('hires across days', () => {
  const hire = {
    pickupTimes: [{ startMinutes: 9 * 60, durationMinutes: 3 * 60 }],
    returnTimes: [{ startMinutes: 9 * 60, durationMinutes: 3 * 60 }],
  };

  it('know a booking from one local day to another', () => {
    expect(isMultiDay({ start: at('2027-03-02T18:00:00Z'), end: at('2027-03-03T00:00:00Z') }, 'UTC')).toBe(false);
    expect(isMultiDay({ start: at('2027-03-02T18:00:00Z'), end: at('2027-03-03T00:01:00Z') }, 'UTC')).toBe(true);
    // 23:00 UTC is already the next day in Paris.
    expect(isMultiDay({ start: at('2027-03-02T20:00:00Z'), end: at('2027-03-02T23:30:00Z') }, 'Europe/Paris')).toBe(true);
  });

  it('start in a pick-up time and end in a return time, a return at the window end included', () => {
    expect(judge(hire, '2027-03-05T10:00:00Z', '2027-03-08T12:00:00Z')).toBeNull();
    expect(judge(hire, '2027-03-05T13:00:00Z', '2027-03-08T10:00:00Z')).toBe('pickup_time');
    expect(judge(hire, '2027-03-05T10:00:00Z', '2027-03-08T12:01:00Z')).toBe('return_time');
    // Within one day the times do not apply.
    expect(judge(hire, '2027-03-05T14:00:00Z', '2027-03-05T16:00:00Z')).toBeNull();
  });

  it('need only the start and end inside the hours under enforceHours', () => {
    const rules = { ...hire, enforceHours: true };
    expect(judge(rules, '2027-03-05T10:00:00Z', '2027-03-08T11:00:00Z', OPEN_8_TO_18)).toBeNull();
    // Without hire times a booking across nights is outside the hours.
    expect(judge({ enforceHours: true }, '2027-03-05T10:00:00Z', '2027-03-08T11:00:00Z', OPEN_8_TO_18)).toBe('outside_hours');
  });
});

describe('the range search', () => {
  const base = {
    rules: parseBookingRules({
      pickupTimes: [{ startMinutes: 9 * 60, durationMinutes: 3 * 60 }],
      returnTimes: [{ startMinutes: 9 * 60, durationMinutes: 3 * 60 }],
      turnaroundMinutes: 120,
    }),
    timezone: 'UTC',
    hours: OPEN_8_TO_18,
    now: NOW,
  };

  it('finds the earliest hire of N days from the pick-up window', () => {
    expect(
      findEarliestRange({
        ...base,
        busy: [],
        pickup: { start: at('2027-03-05T07:00:00Z'), end: at('2027-03-05T17:00:00Z') },
        days: 3,
      }),
    ).toEqual({ start: at('2027-03-05T09:00:00Z'), end: at('2027-03-08T09:00:00Z') });
  });

  it('moves past what is busy, keeping the turnaround', () => {
    // Busy until 09:30 on the 5th: with no buffer before, the hire starts at 09:30.
    const found = findEarliestRange({
      ...base,
      busy: [{ start: at('2027-03-04T09:00:00Z'), end: at('2027-03-05T09:30:00Z') }],
      pickup: { start: at('2027-03-05T07:00:00Z'), end: at('2027-03-05T17:00:00Z') },
      days: 3,
    });
    expect(found).toEqual({ start: at('2027-03-05T09:30:00Z'), end: at('2027-03-08T09:30:00Z') });
    // A booking starting within the turnaround after the hire's end blocks it.
    expect(
      findEarliestRange({
        ...base,
        busy: [{ start: at('2027-03-08T10:00:00Z'), end: at('2027-03-09T10:00:00Z') }],
        pickup: { start: at('2027-03-05T09:00:00Z'), end: at('2027-03-05T12:00:00Z') },
        days: 3,
      }),
    ).toBeNull();
  });

  it('ends at the earliest return the return window and rules allow', () => {
    expect(
      findEarliestRange({
        ...base,
        busy: [],
        pickup: { start: at('2027-03-05T09:00:00Z'), end: at('2027-03-05T12:00:00Z') },
        return: { start: at('2027-03-08T06:00:00Z'), end: at('2027-03-08T18:00:00Z') },
      }),
    ).toEqual({ start: at('2027-03-05T09:00:00Z'), end: at('2027-03-08T09:00:00Z') });
    // Nothing when the return window has no return time.
    expect(
      findEarliestRange({
        ...base,
        busy: [],
        pickup: { start: at('2027-03-05T09:00:00Z'), end: at('2027-03-05T12:00:00Z') },
        return: { start: at('2027-03-08T13:00:00Z'), end: at('2027-03-08T18:00:00Z') },
      }),
    ).toBeNull();
  });

  it('keeps the wall time across a clock change', () => {
    // London moves to summer time on 28 March 2027.
    expect(sameTimeDaysLater(at('2027-03-26T09:00:00Z'), 3, 'Europe/London')).toEqual(at('2027-03-29T08:00:00Z'));
  });
});
