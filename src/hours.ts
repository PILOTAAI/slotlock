// Bookable hours with their exceptions (RFC 0004 B1, B2): the one evaluator search and enforced
// writes share. A resource's hours are its own, else its location's (nearest up the chain), else its
// tenant's, else the server's. Exceptions then replace whole local days: a closure empties them, an
// opening gives them hours of their own. Each applies in the resource's time zone, the tenant's
// first, then each location's from the outermost in, then the resource's own, so the nearer wins.
import { mergeIntervals } from './engine.js';
import { expandRules } from './rules.js';
import { createTimeZoneConverter } from './timezone.js';
import type { Interval, SlotlockInheritedAvailability, WeeklyAvailabilityRule } from './types.js';

export type { SlotlockInheritedAvailability };

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;

/** Where a resource's hours come from. */
export type SlotlockHoursSource = 'resource' | 'location' | 'tenant' | 'server';

/** One window of an exception's day, in minutes after local midnight. */
export interface SlotlockExceptionWindow {
  startMinutes: number;
  /** 1 to 1,440; a window may run past midnight into the next day. */
  durationMinutes: number;
}

export type SlotlockExceptionOutcome = 'closed' | 'open';
export type SlotlockExceptionSource = 'manual' | 'ics' | 'vavailability';

/** Exceptions a tenant may keep, at all its scopes together. */
export const SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS = 5_000;
/** The longest one exception may last, in days (both ends counted). */
export const SLOTLOCK_MAX_EXCEPTION_DAYS = 367;
/** Windows one open exception may give each day. */
export const SLOTLOCK_MAX_EXCEPTION_WINDOWS = 4;

/** A closure or a day of special hours, for the tenant, a location or one resource. */
export interface SlotlockAvailabilityException {
  id: string;
  tenantRef: string;
  /** The location it applies to (and every resource inside it), or none. */
  location?: string;
  /** The resource it applies to, or none. Neither: the whole tenant. */
  resourceId?: string;
  /** The first local day, `YYYY-MM-DD`. */
  startsOn: string;
  /** The last local day, `YYYY-MM-DD` (inclusive). */
  endsOn: string;
  outcome: SlotlockExceptionOutcome;
  /** For `open`: the hours each of its days has instead of its usual ones. */
  hours?: SlotlockExceptionWindow[];
  label: string;
  source: SlotlockExceptionSource;
  /** For imports: the source's own id, so importing again updates rather than adds. */
  sourceUid?: string;
  createdAt: Date;
}

/** An exception as the evaluator applies it, ranked from widest scope (0) to the resource's own. */
export interface SlotlockRankedException {
  startsOn: string;
  endsOn: string;
  outcome: SlotlockExceptionOutcome;
  hours?: readonly SlotlockExceptionWindow[];
  rank: number;
}

export function invalidException(message: string): Error & { code: 'invalid_availability_exception' } {
  return Object.assign(new Error(message), { code: 'invalid_availability_exception' as const });
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 for a real `YYYY-MM-DD`, or null. */
export function epochDay(date: string): number | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (year < 1 || back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return Math.round(ms / DAY_MS);
}

/** `YYYY-MM-DD` for a day since 1970-01-01. */
export function dayToDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** An exception's windows from untrusted input, or `invalid_availability_exception`. */
export function parseExceptionWindows(value: unknown): SlotlockExceptionWindow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SLOTLOCK_MAX_EXCEPTION_WINDOWS) {
    throw invalidException(`Open hours must be 1 to ${SLOTLOCK_MAX_EXCEPTION_WINDOWS} windows`);
  }
  return value.map((window: unknown, index) => {
    const candidate = window as Record<string, unknown> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => key !== 'startMinutes' && key !== 'durationMinutes') ||
      !Number.isInteger(candidate.startMinutes) ||
      (candidate.startMinutes as number) < 0 ||
      (candidate.startMinutes as number) >= DAY_MINUTES ||
      !Number.isInteger(candidate.durationMinutes) ||
      (candidate.durationMinutes as number) < 1 ||
      (candidate.durationMinutes as number) > DAY_MINUTES
    ) {
      throw invalidException(`Window ${index} needs startMinutes (0-1439) and durationMinutes (1-1440)`);
    }
    return { startMinutes: candidate.startMinutes as number, durationMinutes: candidate.durationMinutes as number };
  });
}

/**
 * An exception's dates and outcome from untrusted input: real dates, the end not before the start,
 * at most SLOTLOCK_MAX_EXCEPTION_DAYS, and hours exactly when it opens.
 */
export function parseExceptionDays(input: {
  startsOn: unknown;
  endsOn?: unknown;
  outcome: unknown;
  hours?: unknown;
}): { startsOn: string; endsOn: string; outcome: SlotlockExceptionOutcome; hours?: SlotlockExceptionWindow[] } {
  const startsOn = typeof input.startsOn === 'string' ? input.startsOn : '';
  const endsOn = input.endsOn === undefined || input.endsOn === null ? startsOn : String(input.endsOn);
  const first = epochDay(startsOn);
  const last = epochDay(endsOn);
  if (first === null || last === null) throw invalidException('Dates must be real days, YYYY-MM-DD');
  if (last < first) throw invalidException('The last day must not be before the first');
  if (last - first + 1 > SLOTLOCK_MAX_EXCEPTION_DAYS) {
    throw invalidException(`An exception lasts at most ${SLOTLOCK_MAX_EXCEPTION_DAYS} days`);
  }
  if (input.outcome === 'closed') {
    if (input.hours !== undefined && input.hours !== null) throw invalidException('A closure has no hours');
    return { startsOn, endsOn, outcome: 'closed' };
  }
  if (input.outcome === 'open') {
    return { startsOn, endsOn, outcome: 'open', hours: parseExceptionWindows(input.hours) };
  }
  throw invalidException('The outcome must be closed or open');
}

/** Stored hours that do not read as windows read as none: the day stays closed. */
export function storedExceptionWindows(value: unknown): SlotlockExceptionWindow[] {
  try {
    return parseExceptionWindows(value);
  } catch {
    return [];
  }
}

/**
 * The open windows of a resource within `window`: its weekly `hours`, with `exceptions` (in rank
 * order) replacing the local days they name in `timezone`. Merged and sorted.
 */
export function openWindows(params: {
  hours: readonly WeeklyAvailabilityRule[];
  exceptions?: readonly SlotlockRankedException[];
  timezone: string;
  window: Interval;
}): Interval[] {
  const { window, timezone } = params;
  const weekly = expandRules([...params.hours], window, timezone);
  const exceptions = [...(params.exceptions ?? [])].sort((a, b) => a.rank - b.rank);
  if (exceptions.length === 0) return weekly;
  const converter = createTimeZoneConverter(timezone);
  const at = (day: number, minutes: number) =>
    converter.wallFrameToUtc(day * DAY_MS + minutes * MINUTE_MS, { gap: 'end' }).getTime();
  // The local days the window can touch: a zone is at most fourteen hours from UTC.
  const firstDay = Math.floor(window.start.getTime() / DAY_MS) - 1;
  const lastDay = Math.floor(window.end.getTime() / DAY_MS) + 1;
  let open = weekly;
  for (const exception of exceptions) {
    const from = Math.max(epochDay(exception.startsOn) ?? Number.POSITIVE_INFINITY, firstDay);
    const to = Math.min(epochDay(exception.endsOn) ?? Number.NEGATIVE_INFINITY, lastDay);
    if (from > to) continue;
    const removed = { start: at(from, 0), end: at(to + 1, 0) };
    open = open.flatMap((part) => {
      const start = part.start.getTime();
      const end = part.end.getTime();
      if (end <= removed.start || start >= removed.end) return [part];
      const kept: Interval[] = [];
      if (start < removed.start) kept.push({ start: part.start, end: new Date(removed.start) });
      if (end > removed.end) kept.push({ start: new Date(removed.end), end: part.end });
      return kept;
    });
    if (exception.outcome === 'open') {
      for (let day = from; day <= to; day++) {
        for (const hours of exception.hours ?? []) {
          const start = Math.max(at(day, hours.startMinutes), window.start.getTime());
          const end = Math.min(at(day, hours.startMinutes + hours.durationMinutes), window.end.getTime());
          if (end > start) open.push({ start: new Date(start), end: new Date(end) });
        }
      }
    }
  }
  return mergeIntervals(open.filter((part) => part.end.getTime() > part.start.getTime()));
}

/**
 * The weekly hours that apply to a resource and where they come from: its own, else what it
 * inherits, else the server's `fallback`.
 */
export function applicableHours(
  resource: { availabilityRules?: readonly WeeklyAvailabilityRule[]; inheritedAvailability?: SlotlockInheritedAvailability },
  fallback: readonly WeeklyAvailabilityRule[],
): { rules: readonly WeeklyAvailabilityRule[]; source: SlotlockHoursSource; location?: string } {
  if (resource.availabilityRules !== undefined) return { rules: resource.availabilityRules, source: 'resource' };
  const inherited = resource.inheritedAvailability;
  if (inherited !== undefined) {
    return inherited.location !== undefined
      ? { rules: inherited.rules, source: inherited.source, location: inherited.location }
      : { rules: inherited.rules, source: inherited.source };
  }
  return { rules: fallback, source: 'server' };
}

/** Whether `interval` lies wholly inside the open windows. */
export function coveredByOpenWindows(open: readonly Interval[], interval: Interval): boolean {
  let covered = interval.start.getTime();
  for (const part of [...open].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    if (part.start.getTime() > covered) break;
    covered = Math.max(covered, part.end.getTime());
    if (covered >= interval.end.getTime()) return true;
  }
  return covered >= interval.end.getTime();
}

/** The first and last UTC day an exception query for `window` must reach (zones span ±14 hours). */
export function exceptionQueryDays(window: Interval): { from: string; to: string } {
  return {
    from: dayToDate(Math.floor(window.start.getTime() / DAY_MS) - 1),
    to: dayToDate(Math.floor(window.end.getTime() / DAY_MS) + 1),
  };
}

/** One local day as exceptions leave it: no windows is closed. */
export interface SlotlockExceptionDay {
  /** `YYYY-MM-DD`. */
  date: string;
  windows: SlotlockExceptionWindow[];
}

/**
 * The days from `from` to `to` (`YYYY-MM-DD`, inclusive) that exceptions replace, each as the
 * nearest exception leaves it, by date.
 */
export function exceptionDays(
  exceptions: readonly SlotlockRankedException[],
  from: string,
  to: string,
): SlotlockExceptionDay[] {
  const first = epochDay(from);
  const last = epochDay(to);
  if (first === null || last === null) return [];
  const days = new Map<number, SlotlockExceptionWindow[]>();
  for (const exception of [...exceptions].sort((a, b) => a.rank - b.rank)) {
    const start = Math.max(epochDay(exception.startsOn) ?? Number.POSITIVE_INFINITY, first);
    const end = Math.min(epochDay(exception.endsOn) ?? Number.NEGATIVE_INFINITY, last);
    for (let day = start; day <= end; day++) {
      days.set(day, exception.outcome === 'open' ? [...(exception.hours ?? [])] : []);
    }
  }
  return [...days.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, windows]) => ({ date: dayToDate(day), windows }));
}

/**
 * Consecutive days that read alike as exception ranges: no windows a closure, else hours of their
 * own. The inverse of `exceptionDays` for one scope.
 */
export function exceptionRanges(
  days: readonly SlotlockExceptionDay[],
): { startsOn: string; endsOn: string; outcome: SlotlockExceptionOutcome; hours?: SlotlockExceptionWindow[] }[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const ranges: { startsOn: string; endsOn: string; outcome: SlotlockExceptionOutcome; hours?: SlotlockExceptionWindow[] }[] = [];
  const key = (windows: readonly SlotlockExceptionWindow[]) =>
    JSON.stringify([...windows].sort((a, b) => a.startMinutes - b.startMinutes || a.durationMinutes - b.durationMinutes));
  let previous: { day: number; key: string } | null = null;
  for (const day of sorted) {
    const at = epochDay(day.date);
    if (at === null) continue;
    const same = key(day.windows);
    const last = ranges.at(-1);
    if (last && previous && previous.day === at - 1 && previous.key === same) {
      last.endsOn = day.date;
    } else {
      ranges.push(
        day.windows.length === 0
          ? { startsOn: day.date, endsOn: day.date, outcome: 'closed' }
          : { startsOn: day.date, endsOn: day.date, outcome: 'open', hours: JSON.parse(same) as SlotlockExceptionWindow[] },
      );
    }
    previous = { day: at, key: same };
  }
  return ranges;
}
