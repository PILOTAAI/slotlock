// VAVAILABILITY-style rule expansion (RFC 7953 semantics, weekly subset), recurrence by rrule
// (pinned). Rules are evaluated in an optional IANA timezone (SlotlockResource.timezone): BYDAY is
// the local weekday and windows are wall-clock (09:00-18:00 stays so on DST days). rrule's own
// `tzid` is deliberately not used (buggy): each rrule day stamp is read as a local date and
// converted by Intl offsets. A window edge in a spring-forward gap stands where the gap ends; an
// ambiguous fall-back time is its first occurrence.
//
// ESM interop (load-bearing): rrule 2.8.1 ships no `exports` map. Bundlers and vitest resolve its
// ESM build, but Node picks the CJS UMD `main`, which has no detectable named exports, so a named
// import throws at module instantiation. The namespace import below works under both resolvers.
import type { RRule as RRuleClass, Options as RRuleOptions } from 'rrule';
import * as rruleNs from 'rrule';
const { RRule } = (
  (rruleNs as { RRule?: unknown }).RRule !== undefined
    ? rruleNs
    : (rruleNs as unknown as { default: typeof import('rrule') }).default
) as typeof import('rrule');
import { mergeIntervals } from './engine.js';
import { createTimeZoneConverter } from './timezone.js';
import type { Interval, WeeklyAvailabilityRule } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The longest window Slotlock reads or searches at once, in days: free/busy, the rolling event
 * horizon, a recurring event's materialization and a search for the next slot all stop here.
 */
export const SLOTLOCK_CALENDAR_HORIZON_DAYS = 367;
const MAX_SEARCH_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * DAY_MS;
/**
 * The longest window one availability rule may open, in minutes: a week. Expansion scans back as
 * many days as a rule lasts, so a longer one is skipped, as the hours validator refuses it.
 */
export const SLOTLOCK_MAX_RULE_DURATION_MINUTES = 10_080;

export function invalidWindowError(
  message = 'Slotlock window must contain two finite dates with end > start',
): Error & { code: 'invalid_window' } {
  return Object.assign(new Error(message), { code: 'invalid_window' as const });
}

/**
 * Refuse (`invalid_window`) a search window longer than SLOTLOCK_CALENDAR_HORIZON_DAYS: expansion
 * is synchronous and grows with the window.
 */
export function assertBoundedSearchWindow(window: Interval): void {
  if (window.end.getTime() - window.start.getTime() > MAX_SEARCH_WINDOW_MS) {
    throw invalidWindowError(
      `Slotlock searches a window of at most ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days at once`,
    );
  }
}

function utcDayFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

const RRULE_PART = /^([A-Z]+)=([0-9A-Z,]+)$/;
const WEEKDAY = /^(?:MO|TU|WE|TH|FR|SA|SU)$/;
const ABSOLUTE_UNTIL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Whether `until` is an absolute UNTIL naming a real instant. rrule reads it with Date.UTC, which
 * carries overflow into the next unit (31 February becomes 3 March). A leap second (60) is real
 * (RFC 5545 3.3.12).
 */
function isRealUntil(until: string): boolean {
  const match = ABSOLUTE_UNTIL.exec(until);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  // Set without overflow checks: the date reads back differently when any part overflowed.
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    date.toISOString().startsWith(`${year}-${month}-${day}T`) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 60
  );
}

/**
 * Whether `rrule` is in SPEC.md's subset: `FREQ=WEEKLY`, a `BYDAY` of plain weekdays, optionally
 * `INTERVAL=1` and an absolute `UNTIL`, each once, in any order. Checked before rrule parses it:
 * rrule honours a DTSTART's TZID, takes the first of two BYDAYs, and lets BYHOUR/BYMINUTE/BYSECOND
 * multiply occurrences.
 */
function isWeeklySubset(rrule: string): boolean {
  const parts = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const match = RRULE_PART.exec(part);
    if (!match || parts.has(match[1] as string)) return false;
    parts.set(match[1] as string, match[2] as string);
  }
  const until = parts.get('UNTIL');
  return (
    [...parts.keys()].every((key) => ['FREQ', 'BYDAY', 'INTERVAL', 'UNTIL'].includes(key)) &&
    parts.get('FREQ') === 'WEEKLY' &&
    (parts.get('BYDAY')?.split(',') ?? ['']).every((day) => WEEKDAY.test(day)) &&
    (parts.get('INTERVAL') ?? '1') === '1' &&
    (until === undefined || isRealUntil(until))
  );
}

/**
 * Only the weekly subset that can be answered deterministically; anything else fails closed to not
 * bookable:
 * - freq must be WEEKLY: a freq-less string otherwise becomes a YEARLY rule anchored at the query
 *   date;
 * - COUNT needs an authored DTSTART: re-anchoring restarts it on every query;
 * - INTERVAL>1 parity depends on the anchor. UNTIL is absolute and stays allowed.
 */
function isSupportedRule(parsed: Partial<RRuleOptions>): boolean {
  if (parsed.freq !== RRule.WEEKLY) return false;
  if (parsed.count !== undefined && parsed.count !== null) return false;
  if (parsed.interval !== undefined && parsed.interval !== 1) return false;
  // BYDAY-less WEEKLY would take its weekday from the re-anchored DTSTART, varying with the query
  // date.
  const byweekday = parsed.byweekday;
  if (byweekday === undefined || byweekday === null) return false;
  if (Array.isArray(byweekday) && byweekday.length === 0) return false;
  return true;
}

/**
 * Expand availability rules to merged, sorted UTC windows clipped to `searchWindow`. Unsupported or
 * unparseable rules contribute nothing rather than throwing: one bad rule must neither blank the
 * calendar nor manufacture availability. Validate at write time; this is the fail-closed backstop.
 * A window over SLOTLOCK_CALENDAR_HORIZON_DAYS is refused (`invalid_window`).
 */
export function expandRules(
  rules: WeeklyAvailabilityRule[],
  searchWindow: Interval,
  timezone?: string,
): Interval[] {
  assertBoundedSearchWindow(searchWindow);
  // Validate once: a typo'd zone must never silently fall back to UTC and shift availability.
  const converter = timezone !== undefined ? createTimeZoneConverter(timezone) : null;
  const windows: Interval[] = [];
  for (const rule of rules) {
    if (
      !Number.isInteger(rule.startMinutes) ||
      rule.startMinutes < 0 ||
      rule.startMinutes > 1439 ||
      !Number.isInteger(rule.durationMinutes) ||
      rule.durationMinutes <= 0 ||
      rule.durationMinutes > SLOTLOCK_MAX_RULE_DURATION_MINUTES
    ) {
      continue;
    }
    let rrule: RRuleClass;
    let absoluteUntil: Date | null = null;
    // A window can start days before the search window and still reach into it: scan back as far as
    // the longest window this rule can produce.
    const backScanDays = Math.ceil((rule.startMinutes + rule.durationMinutes) / (24 * 60));
    const scanStart = utcDayFloor(new Date(searchWindow.start.getTime() - backScanDays * DAY_MS));
    if (typeof rule.rrule !== 'string' || !isWeeklySubset(rule.rrule)) continue;
    try {
      const parsed = RRule.parseString(rule.rrule);
      if (!isSupportedRule(parsed)) continue;
      // rrule's stamps are days, not window starts, so its UNTIL handling is wrong at both ends;
      // each window's real start is compared with UNTIL below instead.
      if (parsed.until) {
        absoluteUntil = parsed.until;
        parsed.until = null;
      }
      parsed.dtstart = scanStart;
      rrule = new RRule(parsed);
    } catch {
      continue;
    }
    // Under a zone a local day whose UTC stamp is past the window end can still start before it
    // (east zones are up to 14h ahead): scan one day over and let clipping discard the overshoot.
    const scanEnd = converter ? new Date(searchWindow.end.getTime() + DAY_MS) : searchWindow.end;
    const days = rrule.between(scanStart, scanEnd, true);
    for (const day of days) {
      let start: Date;
      let end: Date;
      if (converter) {
        // The stamp's Y/M/D is the local date; start and end are wall-clock. An edge the clocks
        // skip stands where the skipped hour ends, so the window holds only wall times that exist.
        const wallDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
        start = converter.wallFrameToUtc(wallDay + rule.startMinutes * MINUTE_MS, { gap: 'end' });
        end = converter.wallFrameToUtc(
          wallDay + (rule.startMinutes + rule.durationMinutes) * MINUTE_MS,
          { gap: 'end' },
        );
        if (end.getTime() <= start.getTime()) continue;
      } else {
        const dayFloor = utcDayFloor(day);
        start = new Date(dayFloor.getTime() + rule.startMinutes * MINUTE_MS);
        end = new Date(start.getTime() + rule.durationMinutes * MINUTE_MS);
      }
      if (absoluteUntil && start.getTime() > absoluteUntil.getTime()) continue;
      const clippedStart =
        start.getTime() < searchWindow.start.getTime() ? searchWindow.start : start;
      const clippedEnd = end.getTime() > searchWindow.end.getTime() ? searchWindow.end : end;
      if (clippedStart.getTime() < clippedEnd.getTime()) {
        windows.push({ start: clippedStart, end: clippedEnd });
      }
    }
  }
  return mergeIntervals(windows);
}
