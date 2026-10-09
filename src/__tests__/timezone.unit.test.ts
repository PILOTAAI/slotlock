import { describe, expect, it } from 'vitest';
import { zonedCalendarDate, zonedDateTimeToUtc, zonedWallTime } from '../timezone.js';

describe('zonedWallTime', () => {
  // The hire agreement states each hire's start and expected end as a date and a time (OLR 2000
  // Sch 2 Part B), read on the operator's own clock, not the server's and not UTC.
  it('reads the civil date and the 24-hour clock time in the zone', () => {
    expect(zonedWallTime(new Date('2027-07-08T23:30:00.000Z'), 'Europe/London')).toEqual({
      date: '2027-07-09',
      time: '00:30',
    });
    expect(zonedWallTime(new Date('2027-01-08T23:30:00.000Z'), 'Europe/London')).toEqual({
      date: '2027-01-08',
      time: '23:30',
    });
    expect(zonedWallTime(new Date('2027-07-10T02:05:00.000Z'), 'America/New_York')).toEqual({
      date: '2027-07-09',
      time: '22:05',
    });
  });

  it('agrees with zonedCalendarDate on the civil date', () => {
    const instant = new Date('2027-03-28T00:59:59.000Z');
    expect(zonedWallTime(instant, 'Europe/London').date).toBe(
      zonedCalendarDate(instant, 'Europe/London').date,
    );
  });

  it('rejects unknown zones and invalid instants', () => {
    expect(() => zonedWallTime(new Date(), 'Europe/Narnia')).toThrowError(
      expect.objectContaining({ code: 'invalid_timezone' }),
    );
    expect(() => zonedWallTime(new Date(Number.NaN), 'UTC')).toThrowError(
      expect.objectContaining({ code: 'invalid_instant' }),
    );
  });
});

describe('zonedCalendarDate', () => {
  it('reads the civil date and ISO weekday in the zone, not in UTC', () => {
    // 23:30Z on Thursday 8 July 2027 is already 00:30 BST on Friday 9 July in London.
    const instant = new Date('2027-07-08T23:30:00.000Z');
    expect(zonedCalendarDate(instant, 'Europe/London')).toEqual({
      date: '2027-07-09',
      isoWeekday: 5,
    });
    expect(zonedCalendarDate(instant, 'UTC')).toEqual({ date: '2027-07-08', isoWeekday: 4 });
  });

  it('numbers Sunday 7 and Monday 1 (ISO 8601), never 0', () => {
    expect(zonedCalendarDate(new Date('2027-07-11T12:00:00.000Z'), 'Europe/London')).toEqual({
      date: '2027-07-11',
      isoWeekday: 7,
    });
    expect(zonedCalendarDate(new Date('2027-07-12T12:00:00.000Z'), 'Europe/London')).toEqual({
      date: '2027-07-12',
      isoWeekday: 1,
    });
  });

  it('reads a zone west of UTC on the earlier civil day', () => {
    // 02:00Z on Saturday 10 July is still 22:00 EDT on Friday 9 July in New York.
    expect(zonedCalendarDate(new Date('2027-07-10T02:00:00.000Z'), 'America/New_York')).toEqual({
      date: '2027-07-09',
      isoWeekday: 5,
    });
  });

  it('rejects unknown zones and invalid instants', () => {
    expect(() => zonedCalendarDate(new Date(), 'Europe/Narnia')).toThrowError(
      expect.objectContaining({ code: 'invalid_timezone' }),
    );
    expect(() => zonedCalendarDate(new Date(Number.NaN), 'UTC')).toThrowError(
      expect.objectContaining({ code: 'invalid_instant' }),
    );
  });
});

describe('zonedDateTimeToUtc', () => {
  it('maps local midnight through a DST transition with compatible semantics', () => {
    expect(
      zonedDateTimeToUtc({ year: 2027, month: 3, day: 28 }, 'Europe/London').toISOString(),
    ).toBe('2027-03-28T00:00:00.000Z');
    expect(
      zonedDateTimeToUtc({ year: 2027, month: 3, day: 30 }, 'Europe/London').toISOString(),
    ).toBe('2027-03-29T23:00:00.000Z');
  });

  it('preserves sub-second precision in non-UTC zones', () => {
    const instant = zonedDateTimeToUtc(
      { year: 2027, month: 7, day: 5, hour: 12, minute: 34, second: 56, millisecond: 500 },
      'Europe/London',
    );

    expect(instant.toISOString()).toBe('2027-07-05T11:34:56.500Z');
  });

  it('does not remap ISO years 1..99 through the legacy Date.UTC 1900 offset', () => {
    expect(zonedDateTimeToUtc({ year: 99, month: 7, day: 5 }, 'UTC').toISOString()).toBe(
      '0099-07-05T00:00:00.000Z',
    );
  });

  it('rejects calendar rollover and unknown time zones', () => {
    expect(() => zonedDateTimeToUtc({ year: 2027, month: 2, day: 30 }, 'UTC')).toThrowError(
      expect.objectContaining({ code: 'invalid_local_datetime' }),
    );
    expect(() =>
      zonedDateTimeToUtc({ year: 2027, month: 2, day: 28 }, 'Europe/Narnia'),
    ).toThrowError(expect.objectContaining({ code: 'invalid_timezone' }));
  });
});
