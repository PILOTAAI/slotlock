// VAVAILABILITY-style rule expansion (RFC 7953 semantics, spike subset): recurrence handled by
// rrule (BSD-3, pinned), window math local. Rules are evaluated in an optional IANA timezone
// (per-resource — SlotlockResource.timezone): BYDAY means the LOCAL weekday, startMinutes are
// local wall-clock minutes, and the window END is wall-clock too (a 09:00–18:00 rule stays
// 09:00–18:00 local on DST days; the real UTC span shrinks/grows by the transition). rrule's
// own `tzid` is deliberately NOT used (known-buggy): rrule does pure date arithmetic on UTC
// stamps and each stamp's Y/M/D is re-interpreted as a LOCAL calendar date, converted to UTC
// instants by Intl offset probing (dependency-free, deterministic, RFC 5545 policy: a wall
// time inside a spring-forward gap shifts FORWARD by the gap; a fall-back-ambiguous wall time
// is its FIRST occurrence — chosen explicitly, identical in every zone sign).
//
// ESM interop (LOAD-BEARING — a plain named import took the whole API down in review):
// rrule 2.8.1 ships no `exports` map; under bundlers/vitest the `module` ESM build resolves and
// RRule is a top-level named export, but under Node+tsx (the API's production loader) Node picks
// the CJS `main` (a webpack UMD with zero detectable named exports) and a named import THROWS AT
// MODULE INSTANTIATION — before any flag check or error handler exists. The namespace dance
// below is verified under BOTH resolvers; apps/api carries a tsx-resolution smoke as the gate.
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

/** UTC midnight of the day containing `d`. */
function utcDayFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

const RRULE_PART = /^([A-Z]+)=([0-9A-Z,]+)$/;
const WEEKDAY = /^(?:MO|TU|WE|TH|FR|SA|SU)$/;
const ABSOLUTE_UNTIL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Whether `until` is an absolute UNTIL naming a real instant. rrule reads it with Date.UTC, which
 * carries an overflowing field into the next unit: 31 February became 3 March, and the rule stayed
 * bookable after the day it was written to end. A leap second (60) is real (RFC 5545 3.3.12).
 */
function isRealUntil(until: string): boolean {
  const match = ABSOLUTE_UNTIL.exec(until);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  // Set without overflow checks, the date reads back differently when any part overflowed.
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
 * Whether `rrule` is written in SPEC.md's subset: `FREQ=WEEKLY`, a `BYDAY` of plain weekdays,
 * optionally `INTERVAL=1` and an absolute `UNTIL`, each once, in any order, and nothing else.
 * Checked before rrule parses it: rrule honours a DTSTART's TZID (Monday came out as Sunday) and
 * the first BYDAY of two, and BYHOUR/BYMINUTE/BYSECOND multiply occurrences (one rule took 0.7 s).
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
 * The spike honours exactly the weekly-cadence subset it can answer DETERMINISTICALLY. Anything
 * else is refused (skipped = fails closed to "not bookable"), never guessed:
 * - freq must be WEEKLY — a freq-less-but-parseable string ('', 'COUNT=5') otherwise becomes a
 *   default-YEARLY rule anchored at the query date: phantom availability at every search start.
 * - COUNT is unanswerable without an authored DTSTART — re-anchoring makes "first N occurrences"
 *   restart on every query.
 * - INTERVAL>1 parity depends on the anchor — re-anchoring makes biweekly availability flip with
 *   the query date. (UNTIL is absolute and expands correctly, so it stays allowed.)
 */
function isSupportedRule(parsed: Partial<RRuleOptions>): boolean {
  if (parsed.freq !== RRule.WEEKLY) return false;
  if (parsed.count !== undefined && parsed.count !== null) return false;
  if (parsed.interval !== undefined && parsed.interval !== 1) return false;
  // BYDAY-less WEEKLY inherits its weekday from the re-anchored DTSTART — the answer wobbles
  // with the query date (and, before this gate, flipped between the UTC and zoned paths).
  const byweekday = parsed.byweekday;
  if (byweekday === undefined || byweekday === null) return false;
  if (Array.isArray(byweekday) && byweekday.length === 0) return false;
  return true;
}

/**
 * Expand availability rules to concrete, merged, sorted UTC windows clipped to `searchWindow`.
 * Unsupported or unparseable rules contribute nothing rather than throwing: one bad rule must not
 * blank the whole calendar — and must never manufacture availability the rule doesn't mean.
 * Callers should validate rules at write time; this read-path skip remains the fail-closed backstop.
 */
export function expandRules(
  rules: WeeklyAvailabilityRule[],
  searchWindow: Interval,
  timezone?: string,
): Interval[] {
  // Validate ONCE, loudly: a typo'd zone must never silently fall back to UTC math — that
  // would manufacture availability shifted by the zone offset. 'UTC'/omitted = spike path.
  const converter = timezone !== undefined ? createTimeZoneConverter(timezone) : null;
  const windows: Interval[] = [];
  for (const rule of rules) {
    if (
      !Number.isInteger(rule.startMinutes) ||
      rule.startMinutes < 0 ||
      rule.startMinutes > 1439 ||
      !Number.isInteger(rule.durationMinutes) ||
      rule.durationMinutes <= 0
    ) {
      continue;
    }
    let rrule: RRuleClass;
    let absoluteUntil: Date | null = null;
    // A window can START days before the search window and still reach into it — scan the
    // recurrence back far enough for the longest window this rule can produce (multi-day
    // windows like "Mon 00:00 + 3 days" are legal; a fixed one-day margin silently lost them).
    const backScanDays = Math.ceil((rule.startMinutes + rule.durationMinutes) / (24 * 60));
    const scanStart = utcDayFloor(new Date(searchWindow.start.getTime() - backScanDays * DAY_MS));
    if (typeof rule.rrule !== 'string' || !isWeeklySubset(rule.rrule)) continue;
    try {
      const parsed = RRule.parseString(rule.rrule);
      if (!isSupportedRule(parsed)) continue;
      // rrule operates on pseudo-UTC local-date stamps. In zoned mode its UNTIL comparison must
      // happen after wall time becomes a real instant or east-of-UTC occurrences disappear early.
      if (converter && parsed.until) {
        absoluteUntil = parsed.until;
        parsed.until = null;
      }
      parsed.dtstart = scanStart;
      rrule = new RRule(parsed);
    } catch {
      continue;
    }
    // Under a zone, a LOCAL day whose UTC stamp lies past the window end can still start
    // before it (east zones read a stamp's wall date up to 14h earlier) — scan one day over
    // and let clipping discard the overshoot.
    const scanEnd = converter ? new Date(searchWindow.end.getTime() + DAY_MS) : searchWindow.end;
    const days = rrule.between(scanStart, scanEnd, true);
    for (const day of days) {
      let start: Date;
      let end: Date;
      if (converter) {
        // The stamp's Y/M/D is the LOCAL calendar date; start and end are both wall-clock.
        const wallDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
        start = converter.wallFrameToUtc(wallDay + rule.startMinutes * MINUTE_MS);
        end = converter.wallFrameToUtc(
          wallDay + (rule.startMinutes + rule.durationMinutes) * MINUTE_MS,
        );
        if (end.getTime() <= start.getTime()) continue;
      } else {
        const dayFloor = utcDayFloor(day);
        start = new Date(dayFloor.getTime() + rule.startMinutes * MINUTE_MS);
        end = new Date(start.getTime() + rule.durationMinutes * MINUTE_MS);
      }
      if (absoluteUntil && start.getTime() > absoluteUntil.getTime()) continue;
      // Clip to the search window; drop windows that miss it entirely.
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
