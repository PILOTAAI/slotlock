// Pure gap-search math: no DB, clock or I/O, so answers are deterministic. Intervals are half-open
// `[start, end)`.
import type { Interval } from './types.js';

/** Sort + coalesce intervals; touching intervals (a.end === b.start) merge into one. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const first = sorted[0] as Interval;
  const out: Interval[] = [{ start: first.start, end: first.end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as Interval;
    const last = out[out.length - 1] as Interval;
    if (cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** Free sub-intervals of `window` once `busy` is carved out (busy need not be sorted/merged). */
export function subtractBusy(window: Interval, busy: Interval[]): Interval[] {
  const relevant = mergeIntervals(
    busy.filter(
      (b) => b.start.getTime() < window.end.getTime() && b.end.getTime() > window.start.getTime(),
    ),
  );
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of relevant) {
    if (b.start.getTime() > cursor.getTime()) free.push({ start: cursor, end: b.start });
    if (b.end.getTime() > cursor.getTime()) cursor = b.end;
  }
  if (cursor.getTime() < window.end.getTime()) free.push({ start: cursor, end: window.end });
  return free;
}

/**
 * Earliest `[s, s + durationMs)` inside one of `windows` without touching `busy`, or null when
 * nothing fits (including a non-positive duration).
 *
 * Touching windows merge (RFC 7953 set-union), so a slot may span the seam of two abutting rules;
 * "no straddling" must be modelled as a gap.
 */
export function findNextAvailable(params: {
  busy: Interval[];
  windows: Interval[];
  durationMs: number;
  /**
   * The first allowed start at or after a candidate (a booking rule's step); must not move a start
   * backwards.
   */
  align?: (start: Date) => Date;
}): Interval | null {
  const { busy, windows, durationMs } = params;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const slotAt = (start: Date): Interval => ({ start, end: new Date(start.getTime() + durationMs) });
  const align = params.align ?? ((start: Date) => start);
  // One walk of merged busy alongside merged windows, both by start.
  const merged = mergeIntervals(busy);
  let next = 0;
  for (const window of mergeIntervals(windows)) {
    while (next < merged.length && (merged[next] as Interval).end.getTime() <= window.start.getTime()) {
      next += 1;
    }
    let cursor = window.start;
    for (let index = next; index < merged.length; index++) {
      const taken = merged[index] as Interval;
      if (taken.start.getTime() >= window.end.getTime()) break;
      const start = align(cursor);
      if (taken.start.getTime() - start.getTime() >= durationMs) return slotAt(start);
      if (taken.end.getTime() > cursor.getTime()) cursor = taken.end;
    }
    const start = align(cursor);
    if (window.end.getTime() - start.getTime() >= durationMs) return slotAt(start);
  }
  return null;
}
