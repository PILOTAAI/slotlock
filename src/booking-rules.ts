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
   * Where the steps fall: this many minutes past each step from local midnight (with a 30-minute
   * step, 15 starts bookings on :15 and :45): 0 to one less than the step. Without a step it is
   * kept and does nothing.
   */
  stepOffsetMinutes?: number;
  /**
   * Minutes kept free before each booking made under the rule (preparation, travel), as its
   * leading buffer: the database refuses a booking whose time, or trailing buffer, reaches into
   * it. 0-1,440. A booking made before the rule, or imported, keeps none.
   */
  bufferBeforeMinutes?: number;
  /**
   * Minutes kept free after each booking made under the rule (cleaning, handover, travel), as its
   * trailing buffer, so the database refuses a booking that would start inside it: 0-1,440. A
   * booking made before the rule, or imported, keeps the buffer it has.
   */
  turnaroundMinutes?: number;
  /** A booking lies inside the resource's bookable hours. */
  enforceHours?: boolean;
  /**
   * A booking is claimed (checked in) within this many minutes of its start, or maintenance
   * releases it for others (and offers it to the waitlist): 1-1,440. Only bookings made once the
   * rule is set are released.
   */
  checkInMinutes?: number;
  /**
   * A booking lies in time every calendar sync recording coverage for the resource has read within
   * the last day (`recordCalendarCoverage`): time a stale or failing sync leaves unproven is
   * refused (`uncertain`), not booked over what it may hide. A resource no sync covers is certain.
   */
  requireCertain?: boolean;
}

/** Which rule a write broke, as its refusal names it. */
export type SlotlockBookingRule =
  | 'min_notice'
  | 'max_advance'
  | 'slot_step'
  | 'outside_hours'
  | 'uncertain';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/** Each numeric rule's least and greatest value. */
export const SLOTLOCK_BOOKING_RULE_LIMITS = Object.freeze({
  minNoticeMinutes: [0, 525_600],
  maxAdvanceDays: [1, 3_660],
  slotStepMinutes: [1, DAY_MINUTES],
  stepOffsetMinutes: [0, DAY_MINUTES - 1],
  bufferBeforeMinutes: [0, DAY_MINUTES],
  turnaroundMinutes: [0, DAY_MINUTES],
  checkInMinutes: [1, DAY_MINUTES],
} as const);
const LIMITS = SLOTLOCK_BOOKING_RULE_LIMITS;

/** Booking rules from untrusted input, or a TypeError naming the field that is wrong. */
export function parseBookingRules(value: unknown): SlotlockBookingRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Slotlock booking rules must be an object');
  }
  const input = value as Record<string, unknown>;
  const rules: SlotlockBookingRules = {};
  for (const key of Object.keys(input)) {
    if (!(key in LIMITS) && key !== 'enforceHours' && key !== 'requireCertain') {
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
  if (input.requireCertain !== undefined) {
    if (typeof input.requireCertain !== 'boolean') {
      throw new TypeError('Slotlock booking rule requireCertain must be true or false');
    }
    rules.requireCertain = input.requireCertain;
  }
  if (
    rules.stepOffsetMinutes !== undefined &&
    rules.slotStepMinutes !== undefined &&
    rules.stepOffsetMinutes >= rules.slotStepMinutes
  ) {
    throw new TypeError('Slotlock booking rule stepOffsetMinutes must be less than slotStepMinutes');
  }
  return rules;
}

/**
 * Default booking rules for a tenant or a pool from untrusted input: booking rules without
 * `checkInMinutes`, which only a resource's own rules set (it releases the bookings made after it
 * was set, and that moment is the resource's).
 */
export function parseBookingRuleDefaults(value: unknown): SlotlockBookingRules {
  const rules = parseBookingRules(value);
  if (rules.checkInMinutes !== undefined) {
    throw new TypeError('Slotlock default booking rules have no checkInMinutes: set it on the resource');
  }
  return rules;
}

/** The trailing buffer a booking made under the rules keeps: the larger of its own and the rule's. */
export function bookingBufferAfterMs(rules: SlotlockBookingRules | undefined, ownMs = 0): number {
  return Math.max(ownMs, (rules?.turnaroundMinutes ?? 0) * MINUTE_MS);
}

/** The leading buffer a booking made under the rules keeps. */
export function bookingBufferBeforeMs(rules: SlotlockBookingRules | undefined): number {
  return (rules?.bufferBeforeMinutes ?? 0) * MINUTE_MS;
}

/** The step's offset as it applies: none without a step, and always less than the step. */
function stepOffset(rules: SlotlockBookingRules | undefined): number {
  const step = rules?.slotStepMinutes;
  return step === undefined ? 0 : (rules?.stepOffsetMinutes ?? 0) % step;
}

/** Minutes past local midnight in `timezone`, with the fraction. */
function localMinutes(instant: Date, timezone: string): number {
  const local = instant.getTime() + zonedOffsetMinutes(instant, timezone) * MINUTE_MS;
  return (((local / MINUTE_MS) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/** Whether `instant` falls on a step: `offset` minutes past a multiple of the step, local time. */
function onStep(instant: Date, stepMinutes: number, timezone: string, offset = 0): boolean {
  const minutes = localMinutes(instant, timezone);
  return Number.isInteger(minutes) && minutes >= offset && (minutes - offset) % stepMinutes === 0;
}

/**
 * The first instant at or after `from` that starts on a step in `timezone`, `offsetMinutes` past
 * each multiple of the step from local midnight (0 to the step less one). A step that does not
 * divide the day starts again at local midnight. Across a clock change it moves forward until the
 * local time is on a step.
 */
export function nextStepStart(from: Date, stepMinutes: number, timezone: string, offsetMinutes = 0): Date {
  const offset = offsetMinutes % stepMinutes;
  let candidate = from;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (onStep(candidate, stepMinutes, timezone, offset)) return candidate;
    const minutes = localMinutes(candidate, timezone);
    const next = Math.min(
      offset + Math.max(0, Math.ceil((minutes - offset) / stepMinutes + 1e-9)) * stepMinutes,
      DAY_MINUTES,
    );
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
  if (
    rules.slotStepMinutes !== undefined &&
    !onStep(interval.start, rules.slotStepMinutes, params.timezone, stepOffset(rules))
  ) {
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

/** How a search honours the rules (`bookingSearch`). */
export interface SlotlockBookingSearch {
  /** The part of the asked window a booking made now may start in. */
  window: Interval;
  /** The trailing buffer each slot keeps. */
  bufferAfterMs: number;
  /** The leading buffer each slot keeps. */
  bufferBeforeMs: number;
  /** The first allowed start at or after a candidate. */
  align?: (start: Date) => Date;
}

/**
 * How a search honours the rules: the part of `window` a booking made at `now` may start in, the
 * buffers each slot keeps, and how a candidate start moves to a step. `null` when no start in the
 * window is allowed.
 */
export function bookingSearch(params: {
  rules: SlotlockBookingRules | undefined;
  timezone: string;
  window: Interval;
  now: Date;
  bufferAfterMs?: number;
}): SlotlockBookingSearch | null {
  const { rules, window, now } = params;
  let start = window.start.getTime();
  const end = window.end.getTime();
  if (rules?.minNoticeMinutes !== undefined) {
    start = Math.max(start, now.getTime() + rules.minNoticeMinutes * MINUTE_MS);
  }
  const bufferAfterMs = bookingBufferAfterMs(rules, params.bufferAfterMs ?? 0);
  const bufferBeforeMs = bookingBufferBeforeMs(rules);
  const step = rules?.slotStepMinutes;
  const offset = stepOffset(rules);
  const toStep =
    step === undefined ? undefined : (from: Date) => nextStepStart(from, step, params.timezone, offset);
  const searched = { start: new Date(start), end: new Date(end) };
  if (rules?.maxAdvanceDays !== undefined) {
    // The latest allowed start bounds where a slot may start; it may still end after it.
    const latestStart = now.getTime() + rules.maxAdvanceDays * DAY_MINUTES * MINUTE_MS;
    if (latestStart < start || end <= start) return null;
    return {
      window: searched,
      bufferAfterMs,
      bufferBeforeMs,
      align: (from: Date) => {
        const aligned = toStep ? toStep(from) : from;
        // Past the latest start, no slot: move it beyond the window so it cannot fit.
        return aligned.getTime() > latestStart ? new Date(end + 1) : aligned;
      },
    };
  }
  if (end <= start) return null;
  return toStep === undefined
    ? { window: searched, bufferAfterMs, bufferBeforeMs }
    : { window: searched, bufferAfterMs, bufferBeforeMs, align: toStep };
}

/**
 * The time a search must read as free or busy: its window, widened by the buffers a slot in it
 * keeps (before its first start and after its last end).
 */
export function bookingSearchReach(search: SlotlockBookingSearch): Interval {
  return {
    start: new Date(search.window.start.getTime() - search.bufferBeforeMs),
    end: new Date(search.window.end.getTime() + search.bufferAfterMs),
  };
}

/**
 * Busy time as the slot times it rules out. A slot [s, s + d) keeping buffers occupies
 * [s - before, s + d + after), so it meets busy [b, e) exactly when [s, s + d) meets
 * [b - after, e + before): the database refuses the same booking.
 */
export function bookingSearchBlocked(busy: readonly Interval[], search: SlotlockBookingSearch): Interval[] {
  return busy.map((interval) => ({
    start: new Date(interval.start.getTime() - search.bufferAfterMs),
    end: new Date(interval.end.getTime() + search.bufferBeforeMs),
  }));
}
