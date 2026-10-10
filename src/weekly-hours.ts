// Bookable hours: the one validator for weekly availability rules, and the conversion between rules
// and a week of windows, the form people edit them in (two windows a day at most).
import { expandRules } from './rules.js';
import type { WeeklyAvailabilityRule } from './types.js';

/** Rules one schedule may hold: the server default, or one resource's own hours. */
export const SLOTLOCK_MAX_AVAILABILITY_RULES = 50;
const RULE_KEYS = new Set(['rrule', 'startMinutes', 'durationMinutes']);
const MAX_RRULE_CHARACTERS = 500;
const MAX_DURATION_MINUTES = 10_080;
const DAY_MINUTES = 1_440;
/** Two weeks every supported weekly rule produces a window in. */
const SAMPLE = { start: new Date('2026-01-05T00:00:00Z'), end: new Date('2026-01-19T00:00:00Z') };

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = Object.freeze({
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
});

/**
 * One window of a day, in minutes after midnight (0-1439) in the resource's time zone. An end at
 * or before the start ends the next day; 00:00 to 00:00 is the whole day.
 */
export interface HoursWindow {
  from: number;
  to: number;
}
export type WeeklyHours = Record<Weekday, HoursWindow[]>;

const MAX_WINDOWS_A_DAY = 2;
const CANONICAL_RRULE =
  /^FREQ=WEEKLY;BYDAY=((?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMinuteOfDay = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < DAY_MINUTES;

function invalidAvailability(message: string): Error & { code: 'invalid_availability' } {
  return Object.assign(new Error(message), { code: 'invalid_availability' as const });
}

/**
 * Why `candidate` cannot be an availability rule: `'shape'` (not exactly rrule, startMinutes 0-1439
 * and durationMinutes 1-10080), `'unsupported'` (a rule `expandRules` would skip: anything but
 * FREQ=WEEKLY, BYDAY, INTERVAL=1 and an absolute UNTIL, or no window at all), or null when it can.
 */
export function availabilityRuleProblem(candidate: unknown): 'shape' | 'unsupported' | null {
  if (
    !isRecord(candidate) ||
    Object.keys(candidate).some((key) => !RULE_KEYS.has(key)) ||
    typeof candidate.rrule !== 'string' ||
    candidate.rrule.length === 0 ||
    candidate.rrule.length > MAX_RRULE_CHARACTERS ||
    !isMinuteOfDay(candidate.startMinutes) ||
    !Number.isInteger(candidate.durationMinutes) ||
    (candidate.durationMinutes as number) < 1 ||
    (candidate.durationMinutes as number) > MAX_DURATION_MINUTES
  ) {
    return 'shape';
  }
  const rule = {
    rrule: candidate.rrule,
    startMinutes: candidate.startMinutes,
    durationMinutes: candidate.durationMinutes as number,
  };
  return expandRules([rule], SAMPLE).length === 0 ? 'unsupported' : null;
}

/**
 * A copy of `value` as availability rules, or an error with `code: 'invalid_availability'` naming
 * the first problem. `[]` is valid: never bookable.
 */
export function parseAvailabilityRules(value: unknown): WeeklyAvailabilityRule[] {
  if (!Array.isArray(value) || value.length > SLOTLOCK_MAX_AVAILABILITY_RULES) {
    throw invalidAvailability(
      `Bookable hours must be a list of at most ${SLOTLOCK_MAX_AVAILABILITY_RULES} weekly rules`,
    );
  }
  return value.map((candidate: unknown, index) => {
    const problem = availabilityRuleProblem(candidate);
    if (problem === 'shape') {
      throw invalidAvailability(
        `Rule ${index} needs rrule (string), startMinutes (0-1439) and durationMinutes (1-10080)`,
      );
    }
    if (problem === 'unsupported') {
      throw invalidAvailability(
        `Rule ${index} is not a weekly rule with BYDAY that Slotlock can evaluate`,
      );
    }
    const rule = candidate as WeeklyAvailabilityRule;
    return {
      rrule: rule.rrule,
      startMinutes: rule.startMinutes,
      durationMinutes: rule.durationMinutes,
    };
  });
}

const lengthOf = ({ from, to }: HoursWindow) => (to > from ? to - from : to + DAY_MINUTES - from);

/** Whether two windows of one day share a minute. */
function overlap(a: HoursWindow, b: HoursWindow): boolean {
  const aEnd = a.from + lengthOf(a);
  const bEnd = b.from + lengthOf(b);
  return a.from < bEnd && b.from < aEnd;
}

/**
 * Rules for a week of windows: days with the same window share one rule. Refuses
 * (`invalid_availability`) more than two windows a day, windows that overlap on one day, and times
 * that are not whole minutes of a day.
 */
export function weeklyHoursToRules(week: WeeklyHours): WeeklyAvailabilityRule[] {
  const days = new Map<string, Weekday[]>();
  for (const day of WEEKDAYS) {
    const windows = week[day] ?? [];
    const name = WEEKDAY_NAMES[day];
    if (windows.length > MAX_WINDOWS_A_DAY) {
      throw invalidAvailability(`${name} has more than ${MAX_WINDOWS_A_DAY} windows`);
    }
    for (const window of windows) {
      if (!isMinuteOfDay(window.from) || !isMinuteOfDay(window.to)) {
        throw invalidAvailability(`${name} has a time that is not between 00:00 and 23:59`);
      }
    }
    if (windows.length === 2 && overlap(windows[0] as HoursWindow, windows[1] as HoursWindow)) {
      throw invalidAvailability(`${name}'s two windows overlap`);
    }
    for (const window of windows) {
      const key = `${window.from}:${lengthOf(window)}`;
      days.set(key, [...(days.get(key) ?? []), day]);
    }
  }
  return [...days.entries()]
    .map(([key, byDay]) => {
      const [start, length] = key.split(':').map(Number) as [number, number];
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${byDay.join(',')}`,
        startMinutes: start,
        durationMinutes: length,
      };
    })
    .sort(
      (a, b) =>
        a.startMinutes - b.startMinutes ||
        a.durationMinutes - b.durationMinutes ||
        WEEKDAYS.indexOf(a.rrule.slice(18, 20) as Weekday) -
          WEEKDAYS.indexOf(b.rrule.slice(18, 20) as Weekday),
    );
}

/**
 * The week `rules` describe, or null when they say something a week of windows cannot: another
 * rrule form (UNTIL, a different order), a window longer than a day, more than two windows on a
 * day, or windows that overlap.
 */
export function rulesToWeeklyHours(rules: readonly WeeklyAvailabilityRule[]): WeeklyHours | null {
  const week: WeeklyHours = { MO: [], TU: [], WE: [], TH: [], FR: [], SA: [], SU: [] };
  for (const rule of rules) {
    const days = CANONICAL_RRULE.exec(rule.rrule)?.[1];
    if (
      days === undefined ||
      !isMinuteOfDay(rule.startMinutes) ||
      !Number.isInteger(rule.durationMinutes) ||
      rule.durationMinutes < 1 ||
      rule.durationMinutes > DAY_MINUTES
    ) {
      return null;
    }
    const window = {
      from: rule.startMinutes,
      to: (rule.startMinutes + rule.durationMinutes) % DAY_MINUTES,
    };
    for (const day of new Set(days.split(',') as Weekday[])) week[day].push(window);
  }
  for (const day of WEEKDAYS) {
    const windows = week[day].sort((a, b) => a.from - b.from);
    if (windows.length > MAX_WINDOWS_A_DAY) return null;
    if (windows.length === 2 && overlap(windows[0] as HoursWindow, windows[1] as HoursWindow)) {
      return null;
    }
  }
  return week;
}
