import { expandRules } from './rules.js';
import { zonedOffsetMinutes } from './timezone.js';
import type { Interval, WeeklyAvailabilityRule } from './types.js';

/**
 * A resource's booking rules: what a booking made through Slotlock (a hold, a reservation, an
 * agent's event) must satisfy, and what a search offers. Each is optional; none set is no rule.
 * Imported calendar events are what happened elsewhere and are not checked.
 */
export interface SlotlockBookingRules {
  /** A booking starts at least this many minutes after it is made: 0-525,600 (a year). */
  minNoticeMinutes?: number;
  /** A booking starts at most this many days after it is made: 1-3,660. */
  maxAdvanceDays?: number;
  /**
   * Bookings start on a step of this many minutes from local midnight, in the resource's time zone
   * (15: on the quarter hour): 1-1,440.
   */
  slotStepMinutes?: number;
  /**
   * Minutes kept free after each booking made under the rule (cleaning, handover, travel), as its
   * trailing buffer, so the database refuses a booking that would start inside it: 0-1,440. A
   * booking made before the rule, or imported, keeps the buffer it has.
   */
  turnaroundMinutes?: number;
  /** A booking lies inside the resource's bookable hours. */
  enforceHours?: boolean;
}

/** Which rule a write broke, as its refusal names it. */
export type SlotlockBookingRule = 'min_notice' | 'max_advance' | 'slot_step' | 'outside_hours';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

const LIMITS = {
  minNoticeMinutes: [0, 525_600],
  maxAdvanceDays: [1, 3_660],
  slotStepMinutes: [1, DAY_MINUTES],
  turnaroundMinutes: [0, DAY_MINUTES],
} as const;

/** Booking rules from untrusted input, or a TypeError naming the field that is wrong. */
export function parseBookingRules(value: unknown): SlotlockBookingRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Slotlock booking rules must be an object');
  }
  const input = value as Record<string, unknown>;
  const rules: SlotlockBookingRules = {};
  for (const key of Object.keys(input)) {
    if (!(key in LIMITS) && key !== 'enforceHours') {
      throw new TypeError(`Slotlock booking rules have no ${key}`);
    }
  }
  for (const [key, [min, max]] of Object.entries(LIMITS) as [keyof typeof LIMITS, readonly [number, number]][]) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < min || field > max) {
      throw new TypeError(`Slotlock booking rule ${key} must be a whole ${min}-${max}`);
    }
    rules[key] = field;
  }
  if (input.enforceHours !== undefined) {
    if (typeof input.enforceHours !== 'boolean') {
      throw new TypeError('Slotlock booking rule enforceHours must be true or false');
    }
    rules.enforceHours = input.enforceHours;
  }
  return rules;
}

/** The trailing buffer a booking made under the rules keeps: the larger of its own and the rule's. */
export function bookingBufferAfterMs(rules: SlotlockBookingRules | undefined, ownMs = 0): number {
  return Math.max(ownMs, (rules?.turnaroundMinutes ?? 0) * MINUTE_MS);
}

/** Minutes past local midnight in `timezone`, with the fraction. */
function localMinutes(instant: Date, timezone: string): number {
  const local = instant.getTime() + zonedOffsetMinutes(instant, timezone) * MINUTE_MS;
  return (((local / MINUTE_MS) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

function onStep(instant: Date, stepMinutes: number, timezone: string): boolean {
  const minutes = localMinutes(instant, timezone);
  return Number.isInteger(minutes) && minutes % stepMinutes === 0;
}

/**
 * The first instant at or after `from` that starts on a step in `timezone`. A step that does not
 * divide the day starts again at local midnight. Across a clock change it moves forward until the
 * local time is on a step.
 */
export function nextStepStart(from: Date, stepMinutes: number, timezone: string): Date {
  let candidate = from;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (onStep(candidate, stepMinutes, timezone)) return candidate;
    const minutes = localMinutes(candidate, timezone);
    const next = Math.min(Math.ceil(minutes / stepMinutes + 1e-9) * stepMinutes, DAY_MINUTES);
    const ahead = Math.max(next - minutes, 1 / 60_000);
    candidate = new Date(Math.ceil(candidate.getTime() + ahead * MINUTE_MS));
  }
  return candidate;
}

/**
 * The rule a booking of `interval` made at `now` breaks, or null. `hours` are the resource's
 * bookable hours (its own, or the default), read only when the rules enforce them.
 */
export function bookingRuleBroken(params: {
  rules: SlotlockBookingRules | undefined;
  timezone: string;
  hours: readonly WeeklyAvailabilityRule[];
  interval: Interval;
  now: Date;
}): SlotlockBookingRule | null {
  const { rules, interval, now } = params;
  if (!rules) return null;
  const start = interval.start.getTime();
  if (rules.minNoticeMinutes !== undefined && start < now.getTime() + rules.minNoticeMinutes * MINUTE_MS) {
    return 'min_notice';
  }
  if (
    rules.maxAdvanceDays !== undefined &&
    start > now.getTime() + rules.maxAdvanceDays * DAY_MINUTES * MINUTE_MS
  ) {
    return 'max_advance';
  }
  if (rules.slotStepMinutes !== undefined && !onStep(interval.start, rules.slotStepMinutes, params.timezone)) {
    return 'slot_step';
  }
  if (rules.enforceHours === true) {
    const open = expandRules([...params.hours], interval, params.timezone);
    let covered = interval.start.getTime();
    for (const window of open.sort((a, b) => a.start.getTime() - b.start.getTime())) {
      if (window.start.getTime() > covered) break;
      covered = Math.max(covered, window.end.getTime());
      if (covered >= interval.end.getTime()) break;
    }
    if (covered < interval.end.getTime()) return 'outside_hours';
  }
  return null;
}

/**
 * How a search honours the rules: the part of `window` a booking made at `now` may start in, the
 * trailing buffer each slot keeps, and how a candidate start moves to a step. `null` when no start
 * in the window is allowed.
 */
export function bookingSearch(params: {
  rules: SlotlockBookingRules | undefined;
  timezone: string;
  window: Interval;
  now: Date;
  bufferAfterMs?: number;
}): { window: Interval; bufferAfterMs: number; align?: (start: Date) => Date } | null {
  const { rules, window, now } = params;
  let start = window.start.getTime();
  let end = window.end.getTime();
  if (rules?.minNoticeMinutes !== undefined) {
    start = Math.max(start, now.getTime() + rules.minNoticeMinutes * MINUTE_MS);
  }
  const bufferAfterMs = bookingBufferAfterMs(rules, params.bufferAfterMs ?? 0);
  const step = rules?.slotStepMinutes;
  const searched = { start: new Date(start), end: new Date(end) };
  if (rules?.maxAdvanceDays !== undefined) {
    // The latest allowed start bounds where a slot may start; it may still end after it.
    const latestStart = now.getTime() + rules.maxAdvanceDays * DAY_MINUTES * MINUTE_MS;
    if (latestStart < start || end <= start) return null;
    const align =
      step === undefined ? undefined : (from: Date) => nextStepStart(from, step, params.timezone);
    return {
      window: searched,
      bufferAfterMs,
      align: (from: Date) => {
        const aligned = align ? align(from) : from;
        // Past the latest start, no slot: move it beyond the window so it cannot fit.
        return aligned.getTime() > latestStart ? new Date(end + 1) : aligned;
      },
    };
  }
  if (end <= start) return null;
  return step === undefined
    ? { window: searched, bufferAfterMs }
    : { window: searched, bufferAfterMs, align: (from) => nextStepStart(from, step, params.timezone) };
}
