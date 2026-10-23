// Properties of the time-zone conversions, over zones with odd offsets and daylight-saving rules:
// an instant read as wall time converts back to an instant that reads the same (the earliest, in a
// fold), and a wall time no instant reads (a gap) moves forward by exactly the gap.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  zonedCalendarDate,
  zonedDateTimeToUtc,
  zonedOffsetMinutes,
  zonedWallTime,
} from '../timezone.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const ZONES = [
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Sao_Paulo',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'America/St_Johns',
  'Africa/Casablanca',
  'Pacific/Apia',
  'Asia/Tokyo',
];
const HOUR = 60 * MINUTE;

/**
 * The instants a zone's offset changes, in a few years from 1971 to 2099: found day by day, then
 * to the minute. Instants near them are where folds and gaps are, which uniform instants almost
 * never reach (an hour or two a year).
 */
function transitions(timezone: string): number[] {
  const found: number[] = [];
  for (const year of [1975, 1996, 2011, 2026, 2027, 2051, 2098]) {
    let previous = Date.UTC(year, 0, 1);
    for (let day = previous + DAY; day <= Date.UTC(year + 1, 0, 1); day += DAY) {
      if (zonedOffsetMinutes(new Date(day), timezone) !== zonedOffsetMinutes(new Date(previous), timezone)) {
        let low = previous;
        let high = day;
        while (high - low > MINUTE) {
          const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
          if (zonedOffsetMinutes(new Date(middle), timezone) === zonedOffsetMinutes(new Date(low), timezone)) {
            low = middle;
          } else {
            high = middle;
          }
        }
        found.push(high);
      }
      previous = day;
    }
  }
  return found;
}
const TRANSITIONS = ZONES.flatMap((timezone) => transitions(timezone).map((at) => ({ timezone, at })));

/** Whole minutes from 1971 to 2099: no local mean time, and inside every zone's tables. */
const uniform = fc
  .integer({ min: Date.UTC(1971, 0, 1) / MINUTE, max: Date.UTC(2099, 11, 31) / MINUTE })
  .map((minutes) => new Date(minutes * MINUTE));
/** A zone and an instant: anywhere, or within three hours of one of the zone's offset changes. */
const zonedInstant = fc.oneof(
  fc.tuple(uniform, fc.constantFrom(...ZONES)),
  fc
    .tuple(fc.constantFrom(...TRANSITIONS), fc.integer({ min: -3 * 60, max: 3 * 60 }))
    .map(([{ timezone, at }, minutes]) => [new Date(at + minutes * MINUTE), timezone] as [Date, string]),
);

function fieldsOf(wall: { date: string; time: string }) {
  const [year, month, day] = wall.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = wall.time.split(':').map(Number) as [number, number];
  return { year, month, day, hour, minute };
}
const wallMs = (wall: { date: string; time: string }) => Date.parse(`${wall.date}T${wall.time}:00Z`);

/**
 * A zone and wall-clock fields as a UTC frame: anywhere, or within three hours of the wall clock
 * just before one of the zone's offset changes. A gap is wall time no instant reads, so it has to
 * be generated as wall time, not read from instants.
 */
const zonedWall = fc.oneof(
  fc.tuple(uniform, fc.constantFrom(...ZONES)),
  fc
    .tuple(fc.constantFrom(...TRANSITIONS), fc.integer({ min: -3 * 60, max: 3 * 60 }))
    .map(([{ timezone, at }, minutes]) => {
      const before = zonedOffsetMinutes(new Date(at - MINUTE), timezone);
      return [new Date(at + (before + minutes) * MINUTE), timezone] as [Date, string];
    }),
);

describe('time zones', () => {
  it('finds the offset changes these properties lean on', () => {
    // Europe/London changes twice a year; Asia/Tokyo has not since 1951; Apia skipped a day in 2011.
    expect(TRANSITIONS.filter(({ timezone }) => timezone === 'Europe/London')).toHaveLength(14);
    expect(TRANSITIONS.filter(({ timezone }) => timezone === 'Asia/Tokyo')).toHaveLength(0);
    expect(TRANSITIONS.some(({ timezone, at }) => timezone === 'Pacific/Apia' && at === Date.UTC(2011, 11, 30, 10))).toBe(true);
  });

  it('read an instant as wall time and back: the instant, or an earlier one in a fold', () => {
    fc.assert(
      fc.property(zonedInstant, ([at, timezone]) => {
        const wall = zonedWallTime(at, timezone);
        const back = zonedDateTimeToUtc(fieldsOf(wall), timezone);
        expect(zonedWallTime(back, timezone)).toEqual(wall);
        expect(back.getTime()).toBeLessThanOrEqual(at.getTime());
        // Earlier only in a fold: then both instants read the same wall time.
        if (back.getTime() < at.getTime()) {
          expect(at.getTime() - back.getTime()).toBeLessThanOrEqual(3 * HOUR);
          expect(zonedOffsetMinutes(back, timezone)).toBeGreaterThan(zonedOffsetMinutes(at, timezone));
        }
        // The offset is what separates the wall clock from UTC, and the date the wall clock's.
        expect(wallMs(wall) - at.getTime()).toBe(zonedOffsetMinutes(at, timezone) * MINUTE);
        expect(zonedCalendarDate(at, timezone).date).toBe(wall.date);
      }),
      { numRuns: 2_000 },
    );
  });

  it('move a wall time that no instant reads forward by the gap, and keep every other one', () => {
    fc.assert(
      fc.property(zonedWall, ([frame, timezone]) => {
        const fields = {
          year: frame.getUTCFullYear(),
          month: frame.getUTCMonth() + 1,
          day: frame.getUTCDate(),
          hour: frame.getUTCHours(),
          minute: frame.getUTCMinutes(),
        };
        const converted = zonedDateTimeToUtc(fields, timezone);
        const read = wallMs(zonedWallTime(converted, timezone));
        if (read === frame.getTime()) return;
        // A gap: the instant reads later by exactly the change of offset around it.
        const before = zonedOffsetMinutes(new Date(converted.getTime() - DAY), timezone);
        const after = zonedOffsetMinutes(converted, timezone);
        expect(after).toBeGreaterThan(before);
        expect(read - frame.getTime()).toBe((after - before) * MINUTE);
      }),
      { numRuns: 2_000 },
    );
  });

  it('refuse a wall time that is not a calendar date and time', () => {
    fc.assert(
      fc.property(
        fc.record({
          year: fc.integer({ min: -5, max: 10_000 }),
          month: fc.integer({ min: -1, max: 14 }),
          day: fc.integer({ min: -1, max: 33 }),
          hour: fc.integer({ min: -1, max: 25 }),
          minute: fc.integer({ min: -1, max: 61 }),
        }),
        (fields) => {
          const valid =
            fields.year >= 1 &&
            fields.month >= 1 &&
            fields.month <= 12 &&
            fields.day >= 1 &&
            fields.day <= new Date(Date.UTC(2000, fields.month, 0)).getUTCDate() &&
            fields.hour >= 0 &&
            fields.hour <= 23 &&
            fields.minute >= 0 &&
            fields.minute <= 59;
          let result: Date | undefined;
          try {
            result = zonedDateTimeToUtc(fields, 'Europe/London');
          } catch (error) {
            expect((error as { code?: unknown }).code).toBe('invalid_local_datetime');
          }
          // February 29 exists only in leap years; the oracle above allows it in every year.
          const leapDay = fields.month === 2 && fields.day === 29;
          if (valid && !leapDay) expect(result).toBeInstanceOf(Date);
          if (!valid) expect(result).toBeUndefined();
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
