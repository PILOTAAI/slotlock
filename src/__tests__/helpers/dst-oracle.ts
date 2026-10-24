// An independent statement of the occupation rule for timed recurring events, for the tests to hold
// the engine to. It reads offsets from Intl only and shares no code with src/: a bug in the engine's
// own time-zone converter cannot hide here.
//
// The rule (SPEC.md, "Daylight-saving time"): an occurrence starts at its wall time read per RFC
// 5545 §3.3.5 (a time in a gap moves forward by the gap, a time in a fold is its first instant), and
// ends at the later of its exact end (start + DTEND − DTSTART as instants, §3.8.5.3) and its
// wall-clock end (DTEND's wall time carried to the occurrence's date, a time in a fold being its
// later instant). The first instance starts at DTSTART's own instant.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Wall-clock fields of `utcMs` in `zone`, as milliseconds of a UTC frame. */
export function wallOf(utcMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const frame = new Date(0);
  frame.setUTCFullYear(parts.year as number, (parts.month as number) - 1, parts.day as number);
  frame.setUTCHours(parts.hour as number, parts.minute as number, parts.second as number, 0);
  return frame.getTime();
}

/** How far `zone` is ahead of UTC at `utcMs`, in ms. */
export function offsetOf(utcMs: number, zone: string): number {
  return wallOf(Math.floor(utcMs / 1000) * 1000, zone) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Every instant whose wall time in `zone` is `wall`, ascending (two in a fold, none in a gap),
 * found by trying every offset the zone uses within a day and a half of it.
 */
export function instantsOf(wall: number, zone: string): number[] {
  const offsets = new Set<number>();
  for (let probe = wall - 36 * HOUR; probe <= wall + 36 * HOUR; probe += HOUR) {
    offsets.add(offsetOf(probe, zone));
  }
  const found = new Set<number>();
  for (const offset of offsets) {
    if (wallOf(wall - offset, zone) === wall) found.add(wall - offset);
  }
  return [...found].sort((a, b) => a - b);
}

/** The instant a wall time names, RFC 5545 §3.3.5: in a fold `which` one, in a gap moved forward. */
export function resolve(
  wall: number,
  zone: string,
  which: 'earlier' | 'later' = 'earlier',
): number {
  const found = instantsOf(wall, zone);
  if (found.length > 0) return (which === 'earlier' ? found[0] : found.at(-1)) as number;
  // In a gap: the offset in force before it, read just before the gap opens. The gap is at most a
  // day (Samoa skipped one), so walk back to the last instant whose wall time precedes `wall`.
  let before = wall - 2 * DAY;
  for (let step = DAY; step >= 1000; step /= 2) {
    while (wallOf(before + step, zone) < wall && before + step < wall + DAY) before += step;
  }
  return wall - offsetOf(before, zone);
}

/** `yyyymmddThhmmss` as a UTC frame. */
export function wallFrame(text: string): number {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(text) ?? [];
  const frame = new Date(0);
  frame.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  frame.setUTCHours(Number(h), Number(mi), Number(s), 0);
  return frame.getTime();
}

/** A UTC frame as `yyyymmddThhmmss`. */
export function wallText(frame: number): string {
  return new Date(frame).toISOString().replace(/[-:]/g, '').slice(0, 15);
}

export interface SimpleSeries {
  zone: string;
  /** DTSTART and DTEND as written, `yyyymmddThhmmss` in `zone`. */
  start: string;
  end: string;
  /** Days between occurrences: 1 daily, 7 weekly. */
  everyDays: number;
  count: number;
}

/** Each occurrence of a DAILY or WEEKLY COUNT series under the rule, as [start, end) ms. */
export function occupation(series: SimpleSeries): [number, number][] {
  const n0 = wallFrame(series.start);
  const s0 = resolve(n0, series.zone);
  const e0 = resolve(wallFrame(series.end), series.zone);
  const exact = e0 - s0;
  // DTEND's wall time as its instant reads it (a time written in a gap reads moved forward).
  const wallLength = wallOf(e0, series.zone) - n0;
  const out: [number, number][] = [];
  for (let k = 0; k < series.count; k++) {
    const n = n0 + k * series.everyDays * DAY;
    const start = k === 0 ? s0 : resolve(n, series.zone);
    const end = Math.max(start + exact, resolve(n + wallLength, series.zone, 'later'));
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** The DST transitions of `zone` between two instants, as the instant each takes effect. */
export function transitions(zone: string, from: number, to: number): number[] {
  const found: number[] = [];
  let previous = offsetOf(from, zone);
  for (let t = from + HOUR; t <= to; t += HOUR) {
    const offset = offsetOf(t, zone);
    if (offset === previous) continue;
    // Narrow it to the second within the hour.
    let low = t - HOUR;
    let high = t;
    while (high - low > 1000) {
      const mid = Math.floor((low + high) / 2000) * 1000;
      if (offsetOf(mid, zone) === previous) low = mid;
      else high = mid;
    }
    found.push(high);
    previous = offset;
  }
  return found;
}
