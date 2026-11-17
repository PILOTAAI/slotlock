// Hires across days (RFC 0004 B3): the earliest range on one resource that starts in a pick-up
// window and ends a number of local days later, or in a return window, free throughout with its
// buffers and allowed by the resource's booking rules. Pure: the caller reads the busy time, the
// hours and the exceptions; the booking rules' own judge decides each candidate.
import {
  type SlotlockBookingRules,
  bookingBufferAfterMs,
  bookingBufferBeforeMs,
  bookingRuleBroken,
  hoursApplyOf,
  isMultiDay,
  nextStepStart,
  withinDayWindows,
} from './booking-rules.js';
import { mergeIntervals } from './engine.js';
import { type SlotlockRankedException, openWindows } from './hours.js';
import { createTimeZoneConverter, zonedOffsetMinutes } from './timezone.js';
import type { Interval, WeeklyAvailabilityRule } from './types.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Candidates one resource's search judges before it gives up. */
export const SLOTLOCK_MAX_RANGE_CANDIDATES = 5_000;

export interface SlotlockRangeSearch {
  /** Occupied time on the resource (other bookings with their buffers). */
  busy: readonly Interval[];
  rules: SlotlockBookingRules | undefined;
  timezone: string;
  hours: readonly WeeklyAvailabilityRule[];
  exceptions?: readonly SlotlockRankedException[];
  now: Date;
  /** The start lies from `pickup.start` to `pickup.end`, both included. */
  pickup: Interval;
  /** The end lies from `return.start` to `return.end`, both included (or give `days`). */
  return?: Interval;
  /** The end is the start's local time this many days later. */
  days?: number;
}

/** The instant `days` local days after `instant`, at the same wall time (a clock change moves it). */
export function sameTimeDaysLater(instant: Date, days: number, timezone: string): Date {
  const offset = zonedOffsetMinutes(instant, timezone) * MINUTE_MS;
  return createTimeZoneConverter(timezone).wallFrameToUtc(instant.getTime() + offset + days * DAY_MS);
}

/**
 * The earliest range the search allows, or null. Search honours hours always, as slot search does:
 * a range from one local day to another starts and ends inside the hours, one within a day lies
 * inside them. Bounded by SLOTLOCK_MAX_RANGE_CANDIDATES judged candidates.
 */
export function findEarliestRange(search: SlotlockRangeSearch): Interval | null {
  const { timezone, now } = search;
  // Judged as a write is, inside the hours always: as the write is held to them where it is
  // (enforceHours), else at a hire's start and end, what a hire needs.
  const rules: SlotlockBookingRules = {
    ...(search.rules ?? {}),
    enforceHours: true,
    hoursApply: search.rules?.hoursApply ?? (search.rules?.enforceHours === true ? hoursApplyOf(search.rules) : 'ends'),
  };
  const before = bookingBufferBeforeMs(rules);
  const after = bookingBufferAfterMs(rules);
  const busy = mergeIntervals([...search.busy]);
  const lastEnd = search.return
    ? search.return.end.getTime()
    : sameTimeDaysLater(search.pickup.end, search.days ?? 1, timezone).getTime() + DAY_MS;
  const open = openWindows({
    hours: search.hours,
    ...(search.exceptions ? { exceptions: search.exceptions } : {}),
    timezone,
    window: { start: new Date(search.pickup.start.getTime() - DAY_MS), end: new Date(lastEnd + DAY_MS) },
  });
  const isOpen = (instant: number, closed = false) =>
    open.some((part) => part.start.getTime() <= instant && (closed ? instant <= part.end.getTime() : instant < part.end.getTime()));
  const nextOpen = (instant: number) => open.find((part) => part.end.getTime() > instant)?.start.getTime() ?? null;
  const step = rules.slotStepMinutes;
  const offset = step === undefined ? 0 : (rules.stepOffsetMinutes ?? 0) % step;
  const align = (instant: number) =>
    step === undefined
      ? Math.ceil(instant / MINUTE_MS) * MINUTE_MS
      : nextStepStart(new Date(instant), step, timezone, offset).getTime();
  const earliest = Math.max(search.pickup.start.getTime(), now.getTime() + (rules.minNoticeMinutes ?? 0) * MINUTE_MS);
  const latest = Math.min(
    search.pickup.end.getTime(),
    rules.maxAdvanceDays === undefined ? Number.POSITIVE_INFINITY : now.getTime() + rules.maxAdvanceDays * DAY_MS,
  );
  const blocker = (start: number, end: number) =>
    busy.find((taken) => taken.start.getTime() < end + after && taken.end.getTime() > start - before);

  /** The earliest end in the return window a range from `start` may have, or null. */
  const endFor = (start: number): number | null => {
    if (search.days !== undefined) return sameTimeDaysLater(new Date(start), search.days, timezone).getTime();
    const window = search.return as Interval;
    const lengths = rules.allowedDurations;
    if (lengths) {
      for (const minutes of lengths) {
        const end = start + minutes * MINUTE_MS;
        if (end >= window.start.getTime() && end <= window.end.getTime() && returnable(start, end)) return end;
      }
      return null;
    }
    let end = Math.max(
      window.start.getTime(),
      start + Math.max(1, rules.minDurationMinutes ?? 1) * MINUTE_MS,
    );
    end = Math.ceil(end / MINUTE_MS) * MINUTE_MS;
    for (let tries = 0; end <= window.end.getTime() && tries < 3 * 1_440; tries++) {
      if (rules.maxDurationMinutes !== undefined && end - start > rules.maxDurationMinutes * MINUTE_MS) return null;
      if (returnable(start, end)) return end;
      // On to the next return time or opening, else the next minute.
      const reopening = isOpen(end, true) ? null : nextOpen(end);
      end = reopening !== null && reopening > end ? reopening : end + MINUTE_MS;
    }
    return null;
  };
  /** Whether a range may end at `end`: inside the hours at its end, and in a return time for a hire. */
  const returnable = (start: number, end: number) =>
    isOpen(end, true) &&
    (!rules.returnTimes ||
      !isMultiDay({ start: new Date(start), end: new Date(end) }, timezone) ||
      withinDayWindows(new Date(end), rules.returnTimes, timezone, true));
  /** The next start of a pick-up time at or after `instant`, by the local clock. */
  const nextPickup = (instant: number): number => {
    const windows = rules.pickupTimes ?? [];
    const local = ((((instant + zonedOffsetMinutes(new Date(instant), timezone) * MINUTE_MS) / MINUTE_MS) % 1_440) + 1_440) % 1_440;
    const ahead = Math.min(...windows.map((window) => (((window.startMinutes - local) % 1_440) + 1_440) % 1_440));
    return instant + Math.max(1, Math.round(ahead)) * MINUTE_MS;
  };

  let candidate = align(earliest);
  for (let judged = 0; candidate <= latest && judged < SLOTLOCK_MAX_RANGE_CANDIDATES; judged++) {
    // Start inside the hours, and inside a pick-up time.
    if (!isOpen(candidate)) {
      const reopening = nextOpen(candidate);
      if (reopening === null) return null;
      candidate = align(Math.max(reopening, candidate + 1));
      continue;
    }
    const end = endFor(candidate);
    if (
      end !== null &&
      rules.pickupTimes &&
      isMultiDay({ start: new Date(candidate), end: new Date(end) }, timezone) &&
      !withinDayWindows(new Date(candidate), rules.pickupTimes, timezone)
    ) {
      candidate = align(nextPickup(candidate));
      continue;
    }
    if (end !== null && end > candidate) {
      const taken = blocker(candidate, end);
      if (taken) {
        candidate = align(Math.max(taken.end.getTime() + before, candidate + 1));
        continue;
      }
      const range = { start: new Date(candidate), end: new Date(end) };
      if (
        bookingRuleBroken({
          rules,
          timezone,
          hours: search.hours,
          ...(search.exceptions ? { exceptions: search.exceptions } : {}),
          interval: range,
          now,
        }) === null
      ) {
        return range;
      }
    } else if (search.return && candidate + (rules.minDurationMinutes ?? 0) * MINUTE_MS > search.return.end.getTime()) {
      return null;
    }
    candidate = align(candidate + MINUTE_MS);
  }
  return null;
}
