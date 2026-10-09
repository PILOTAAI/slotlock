// Pure gap-search math. No DB, no clock, no I/O — everything arrives as explicit parameters and
// the answers are deterministic, which is what makes the engine testable to the boundary.
// All intervals are half-open `[start, end)`.
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
 * Earliest `[s, s + durationMs)` that fits entirely inside one of `windows` without touching
 * `busy`. Returns null when nothing fits (no windows, saturated, duration too long, or a
 * non-positive duration — a zero-width slot is never a useful answer).
 *
 * Adjacency is NOT a booking boundary: touching windows merge (half-open point-set semantics,
 * RFC 7953 set-union), so a slot may legitimately span the seam of two abutting rules. "Distinct
 * shifts, no straddling" is unexpressible via touching windows — model it as a gap or a future
 * constraint layer.
 */
export function findNextAvailable(params: {
  busy: Interval[];
  windows: Interval[];
  durationMs: number;
}): Interval | null {
  const { busy, windows, durationMs } = params;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const orderedWindows = mergeIntervals(windows);
  for (const window of orderedWindows) {
    for (const free of subtractBusy(window, busy)) {
      if (free.end.getTime() - free.start.getTime() >= durationMs) {
        return { start: free.start, end: new Date(free.start.getTime() + durationMs) };
      }
    }
  }
  return null;
}
