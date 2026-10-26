// Properties of the pure engine, checked on generated input against brute-force oracles: interval
// arithmetic, the next free slot, weekly-rule expansion (UTC and zoned), and bookable hours. Each
// oracle answers "is this instant inside?" the slow, obvious way, at every instant that matters.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findNextAvailable, mergeIntervals, subtractBusy } from '../engine.js';
import { expandRules } from '../rules.js';
import { createTimeZoneConverter, zonedCalendarDate } from '../timezone.js';
import type { Interval } from '../types.js';
import {
  WEEKDAYS,
  type WeeklyHours,
  availabilityRuleProblem,
  parseAvailabilityRules,
  rulesToWeeklyHours,
  weeklyHoursToRules,
} from '../weekly-hours.js';

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;
const BASE = Date.UTC(2027, 0, 4); // a Monday

/** A half-open interval of whole minutes within ~ten days of BASE. */
const interval = fc
  .tuple(fc.integer({ min: 0, max: 14_400 }), fc.integer({ min: 1, max: 2_000 }))
  .map(([from, length]): Interval => ({
    start: new Date(BASE + from * MINUTE),
    end: new Date(BASE + (from + length) * MINUTE),
  }));
const intervals = fc.array(interval, { maxLength: 12 });

const inside = (set: readonly Interval[], t: number) =>
  set.some(({ start, end }) => start.getTime() <= t && t < end.getTime());

/** Every instant where membership can change, and the minute after each. */
function probes(...sets: (readonly Interval[])[]): number[] {
  const points = new Set<number>();
  for (const set of sets) {
    for (const { start, end } of set) {
      for (const t of [start.getTime(), end.getTime()]) {
        points.add(t - MINUTE);
        points.add(t);
        points.add(t + MINUTE);
      }
    }
  }
  return [...points];
}

function expectCanonical(set: readonly Interval[]) {
  for (const { start, end } of set) expect(start.getTime()).toBeLessThan(end.getTime());
  for (let i = 1; i < set.length; i++) {
    // Sorted, and separated: touching intervals would have merged.
    expect((set[i - 1] as Interval).end.getTime()).toBeLessThan((set[i] as Interval).start.getTime());
  }
}

describe('the next free slot, walked once', () => {
  it('finds what carving each window out of the busy list found', () => {
    // The search before it filtered the whole busy list for every window.
    const carved = (busy: Interval[], windows: Interval[], durationMs: number) => {
      for (const window of mergeIntervals(windows)) {
        for (const free of subtractBusy(window, busy)) {
          if (free.end.getTime() - free.start.getTime() >= durationMs) {
            return { start: free.start, end: new Date(free.start.getTime() + durationMs) };
          }
        }
      }
      return null;
    };
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 40 }),
        fc.array(interval, { maxLength: 40 }),
        fc.integer({ min: 1, max: 600 }),
        (busy, windows, minutes) => {
          const durationMs = minutes * MINUTE;
          expect(findNextAvailable({ busy, windows, durationMs })).toEqual(
            carved(busy, windows, durationMs),
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('interval arithmetic', () => {
  it('mergeIntervals covers exactly the union, sorted and separated, and leaves its input alone', () => {
    fc.assert(
      fc.property(intervals, (input) => {
        const before = JSON.stringify(input);
        const merged = mergeIntervals(input);
        expect(JSON.stringify(input)).toBe(before);
        expectCanonical(merged);
        for (const t of probes(input)) expect(inside(merged, t)).toBe(inside(input, t));
        expect(mergeIntervals(merged)).toEqual(merged);
      }),
      { numRuns: 500 },
    );
  });

  it('subtractBusy leaves exactly the window minus the busy time', () => {
    fc.assert(
      fc.property(interval, intervals, (window, busy) => {
        const free = subtractBusy(window, busy);
        expectCanonical(free);
        for (const t of probes([window], busy, free)) {
          expect(inside(free, t)).toBe(inside([window], t) && !inside(busy, t));
        }
      }),
      { numRuns: 500 },
    );
  });

  it('findNextAvailable returns the earliest slot that fits a window and misses every busy interval', () => {
    fc.assert(
      fc.property(
        intervals,
        intervals,
        fc.integer({ min: 1, max: 3_000 }),
        fc.option(fc.nat(), { nil: undefined }),
        (windows, busy, minutes, gap) => {
          // Half the time, exactly as long as one of the free gaps: the boundary a slot must fit.
          const gaps = mergeIntervals(windows).flatMap((window) => subtractBusy(window, busy));
          const exact = gap === undefined || gaps.length === 0 ? undefined : gaps[gap % gaps.length];
          const durationMs = exact ? exact.end.getTime() - exact.start.getTime() : minutes * MINUTE;
          const fits = (start: number) => {
            const end = start + durationMs;
            const free = subtractBusy({ start: new Date(start), end: new Date(end) }, busy);
            const covered = mergeIntervals(windows).some(
              (w) => w.start.getTime() <= start && end <= w.end.getTime(),
            );
            return covered && free.length === 1 && (free[0] as Interval).start.getTime() === start &&
              (free[0] as Interval).end.getTime() === end;
          };
          // The earliest fitting start is a window's start or a busy interval's end.
          const candidates = [...windows.map((w) => w.start.getTime()), ...busy.map((b) => b.end.getTime())]
            .filter(fits)
            .sort((a, b) => a - b);
          const slot = findNextAvailable({ busy, windows, durationMs });
          if (candidates.length === 0) {
            expect(slot).toBeNull();
          } else {
            expect(slot).toEqual({
              start: new Date(candidates[0] as number),
              end: new Date((candidates[0] as number) + durationMs),
            });
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('findNextAvailable answers null for a duration that is not positive and finite', () => {
    fc.assert(
      fc.property(
        intervals,
        fc.oneof(fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY), fc.integer({ max: 0 })),
        (windows, durationMs) => {
          expect(findNextAvailable({ busy: [], windows, durationMs })).toBeNull();
        },
      ),
    );
  });
});

/** A weekly rule as people write them: some weekdays, a start minute, up to three days long. */
const weeklyRule = fc
  .tuple(
    fc.subarray([...WEEKDAYS], { minLength: 1 }),
    fc.integer({ min: 0, max: 1_439 }),
    fc.integer({ min: 1, max: 4_320 }),
  )
  .map(([days, startMinutes, durationMinutes]) => ({
    rrule: `FREQ=WEEKLY;BYDAY=${days.join(',')}`,
    startMinutes,
    durationMinutes,
    days,
  }));
const searchWindow = fc
  .tuple(fc.integer({ min: 0, max: 60 * 24 * 21 }), fc.integer({ min: 1, max: 60 * 24 * 10 }))
  .map(([from, length]): Interval => ({
    start: new Date(BASE + from * MINUTE),
    end: new Date(BASE + (from + length) * MINUTE),
  }));
const ZONES = [
  'UTC',
  'Europe/London',
  'America/New_York',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'America/St_Johns',
  'Africa/Casablanca',
];

/** Instants where a window of these rules can begin or end, near the search window. */
function ruleProbes(
  rules: readonly { startMinutes: number; durationMinutes: number }[],
  window: Interval,
  toUtc: (localDay: number, minutes: number) => number,
): number[] {
  const points = new Set<number>([window.start.getTime(), window.end.getTime() - MINUTE]);
  const firstDay = Math.floor(window.start.getTime() / DAY) * DAY - 4 * DAY;
  for (let day = firstDay; day <= window.end.getTime() + DAY; day += DAY) {
    for (const { startMinutes, durationMinutes } of rules) {
      for (const minutes of [startMinutes, startMinutes + durationMinutes]) {
        const t = toUtc(day, minutes);
        points.add(t - MINUTE);
        points.add(t);
      }
    }
  }
  return [...points].filter((t) => t >= window.start.getTime() && t < window.end.getTime());
}

describe('weekly rule expansion', () => {
  it('matches the definition in UTC: on each listed weekday, from the start minute for the duration', () => {
    fc.assert(
      fc.property(fc.array(weeklyRule, { minLength: 1, maxLength: 4 }), searchWindow, (rules, window) => {
        const expanded = expandRules(rules, window);
        expectCanonical(expanded);
        const toUtc = (day: number, minutes: number) => day + minutes * MINUTE;
        const oracle = (t: number) =>
          rules.some(({ days, startMinutes, durationMinutes }) => {
            for (let back = 0; back <= 3; back++) {
              const day = Math.floor(t / DAY) * DAY - back * DAY;
              const weekday = WEEKDAYS[(new Date(day).getUTCDay() + 6) % 7] as string;
              const start = toUtc(day, startMinutes);
              if (days.includes(weekday as never) && start <= t && t < start + durationMinutes * MINUTE) {
                return true;
              }
            }
            return false;
          });
        for (const t of ruleProbes(rules, window, toUtc)) expect(inside(expanded, t)).toBe(oracle(t));
      }),
      { numRuns: 300 },
    );
  });

  it("matches the definition in a zone: on each listed local weekday, wall time to wall time", () => {
    fc.assert(
      fc.property(
        fc.array(weeklyRule, { minLength: 1, maxLength: 3 }),
        searchWindow,
        fc.constantFrom(...ZONES),
        fc.integer({ min: -400, max: 400 }),
        (rules, window, timezone, shiftDays) => {
          // Move the window over a year either way so it meets daylight-saving changes.
          const shifted: Interval = {
            start: new Date(window.start.getTime() + shiftDays * DAY),
            end: new Date(window.end.getTime() + shiftDays * DAY),
          };
          const expanded = expandRules(rules, shifted, timezone);
          expectCanonical(expanded);
          const converter = createTimeZoneConverter(timezone);
          // A window's edge the clocks skip stands where the skipped hour ends (SPEC.md, "Time
          // and intervals"), so a window wholly inside one holds no time.
          const toUtc = (localDay: number, minutes: number) =>
            converter.wallFrameToUtc(localDay + minutes * MINUTE, { gap: 'end' }).getTime();
          const oracle = (t: number) => {
            const { date } = zonedCalendarDate(new Date(t), timezone);
            const today = Date.parse(`${date}T00:00:00Z`);
            return rules.some(({ days, startMinutes, durationMinutes }) => {
              for (let back = 0; back <= 4; back++) {
                const localDay = today - back * DAY;
                const weekday = WEEKDAYS[(new Date(localDay).getUTCDay() + 6) % 7] as string;
                if (!days.includes(weekday as never)) continue;
                const start = toUtc(localDay, startMinutes);
                const end = toUtc(localDay, startMinutes + durationMinutes);
                if (start <= t && t < end) return true;
              }
              return false;
            });
          };
          for (const t of ruleProbes(rules, shifted, toUtc)) expect(inside(expanded, t)).toBe(oracle(t));
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** A day's windows as the dashboard edits them: at most two, not overlapping. */
const dayWindows = fc
  .array(
    fc.tuple(fc.integer({ min: 0, max: 1_439 }), fc.integer({ min: 1, max: 1_440 })).map(([from, length]) => ({
      from,
      to: (from + length) % 1_440,
    })),
    { maxLength: 2 },
  )
  .filter((windows) => {
    if (windows.length < 2) return true;
    const [a, b] = windows as [{ from: number; to: number }, { from: number; to: number }];
    const lengthOf = ({ from, to }: { from: number; to: number }) => (to > from ? to - from : to + 1_440 - from);
    return !(a.from < b.from + lengthOf(b) && b.from < a.from + lengthOf(a));
  });
const week = fc.record(
  Object.fromEntries(WEEKDAYS.map((day) => [day, dayWindows])) as Record<
    (typeof WEEKDAYS)[number],
    typeof dayWindows
  >,
) as fc.Arbitrary<WeeklyHours>;

describe('bookable hours', () => {
  it('turn a week of windows into rules and back without change', () => {
    fc.assert(
      fc.property(week, (hours) => {
        const rules = weeklyHoursToRules(hours);
        for (const rule of rules) expect(availabilityRuleProblem(rule)).toBeNull();
        const sorted = Object.fromEntries(
          WEEKDAYS.map((day) => [day, [...hours[day]].sort((a, b) => a.from - b.from)]),
        );
        expect(rulesToWeeklyHours(rules)).toEqual(sorted);
        expect(parseAvailabilityRules(rules)).toEqual(rules);
      }),
      { numRuns: 500 },
    );
  });

  it('parse anything into valid rules or refuse it as invalid_availability, never otherwise', () => {
    const number = fc.oneof(
      fc.integer({ min: -2, max: 10_082 }),
      fc.constantFrom(1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 2 ** 53),
    );
    const rrule = fc.oneof(
      fc.constantFrom(
        'FREQ=WEEKLY;BYDAY=MO',
        'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20280101T000000Z',
        'freq=weekly;byday=mo',
        'FREQ=WEEKLY',
        'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
        'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
        'FREQ=DAILY',
        'FREQ=WEEKLY;BYDAY=XX',
        '',
        'RRULE:FREQ=WEEKLY;BYDAY=SU',
      ),
      fc.string({ maxLength: 40 }),
      fc.string({ minLength: 500, maxLength: 520 }),
    );
    const candidate = fc.oneof(
      fc.record({ rrule, startMinutes: number, durationMinutes: number }),
      fc.record({ rrule, startMinutes: number, durationMinutes: number, extra: fc.anything() }),
      fc.anything(),
    );
    fc.assert(
      fc.property(fc.oneof(fc.array(candidate, { maxLength: 52 }), fc.anything()), (value) => {
        let rules: unknown;
        try {
          rules = parseAvailabilityRules(value);
        } catch (error) {
          expect((error as { code?: unknown }).code).toBe('invalid_availability');
          return;
        }
        expect(Array.isArray(rules)).toBe(true);
        for (const rule of rules as unknown[]) expect(availabilityRuleProblem(rule)).toBeNull();
        expect(rules).not.toBe(value);
      }),
      { numRuns: 1_000 },
    );
  });
});
