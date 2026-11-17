export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

/**
 * Which instant a wall time names where the clocks change. RFC 5545 §3.3.5 defaults: a fold
 * (repeated hour) reads as its first instant, a gap (skipped hour) is moved forward by the gap.
 */
export interface WallTimeChoice {
  /** In a fold: the earlier instant (default), or the later one. */
  fold?: 'earlier' | 'later';
  /** In a gap: moved forward by the gap (default), or the instant the gap ends. */
  gap?: 'shift' | 'end';
}

export interface TimeZoneConverter {
  /**
   * UTC-framed wall-clock fields to the instant that reads as them in this zone (WallTimeChoice
   * defaults).
   */
  wallFrameToUtc(wallFrameMs: number, choice?: WallTimeChoice): Date;
}

const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;

/**
 * The instant (ms) that reads as `wallFrameMs` (wall-clock fields framed as UTC) in a zone with
 * offsets from `offsetAt`. Candidates are the offsets within fourteen hours either side (no zone is
 * further from UTC); one that maps back names it. Two do in a fold, none in a gap.
 */
export function wallFrameToInstant(
  wallFrameMs: number,
  offsetAt: (utcMs: number) => number,
  choice: WallTimeChoice = {},
): number {
  const offsets = new Set([
    offsetAt(wallFrameMs - FOURTEEN_HOURS_MS),
    offsetAt(wallFrameMs),
    offsetAt(wallFrameMs + FOURTEEN_HOURS_MS),
  ]);
  const valid: number[] = [];
  for (const offset of offsets) {
    if (offsetAt(wallFrameMs - offset) === offset) valid.push(offset);
  }
  if (valid.length === 1) return wallFrameMs - (valid[0] as number);
  if (valid.length > 1) {
    return wallFrameMs - (choice.fold === 'later' ? Math.min(...valid) : Math.max(...valid));
  }
  const shifted = wallFrameMs - Math.min(...offsets);
  if (choice.gap !== 'end') return shifted;
  // The gap ends at the change: the first whole second after the instant read with the after-gap
  // offset whose offset differs from it.
  let before = wallFrameMs - Math.max(...offsets);
  const offsetBefore = offsetAt(before);
  let after = shifted;
  while (after - before > 1000) {
    const middle = before + Math.floor((after - before) / 2000) * 1000;
    if (offsetAt(middle) === offsetBefore) before = middle;
    else after = middle;
  }
  return after;
}

/**
 * Date.UTC remaps years 0..99 to 1900..1999 and Slotlock accepts years down to 1, so frames are
 * built with setUTCFullYear.
 */
export function utcFrame(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): Date {
  const frame = new Date(0);
  frame.setUTCFullYear(year, month - 1, day);
  frame.setUTCHours(hour, minute, second, millisecond);
  return frame;
}

/**
 * Formatters by zone name: building one costs far more than using it. Intl accepts any
 * capitalisation of a name, so the map is emptied when full rather than growing.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_FORMATTERS = 256;

function createFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  const formatter = buildFormatter(timezone);
  if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear();
  formatters.set(timezone, formatter);
  return formatter;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The furthest from 1970 a Date may be, in ms (ECMA-262 §21.4.1.22, "Time Values and Time Range"). */
const MAX_TIME_MS = 8.64e15;

/** The UTC day an instant falls in, as ZoneOffsets reads a zone's offsets: days since 1970. */
export function zoneOffsetDay(utcMs: number): number {
  return Math.floor(utcMs / DAY_MS);
}

/**
 * How far either side of a wall time its conversion reads offsets: no zone is further than this
 * from UTC.
 */
export const ZONE_OFFSET_REACH_MS = FOURTEEN_HOURS_MS;

/** How many midnights one block of a zone's offsets holds. */
const BLOCK_DAYS = 512;
const NO_CHANGES: readonly ZoneTransition[] = [];

/**
 * A zone's offsets, read from Intl a UTC day at a time and kept: formatToParts costs about two
 * microseconds and a conversion needs four to six offsets. Each midnight is read once; a day whose
 * midnights agree has that offset throughout, and a day whose midnights differ has each change
 * narrowed to the second (scanTransitions). A change and its reversal within one day would be
 * missed; tests check the most volatile zones against an hourly search.
 */
class ZoneOffsets {
  /** The offset at each UTC midnight read (NaN where none is), BLOCK_DAYS days to a block. */
  readonly midnights = new Map<number, Float64Array>();
  /** The changes of each day whose midnights differ. */
  readonly changes = new Map<number, readonly ZoneTransition[]>();
  private readonly formatter: Intl.DateTimeFormat;

  constructor(formatter: Intl.DateTimeFormat) {
    this.formatter = formatter;
  }

  offsetAt(utcMs: number): number {
    const day = zoneOffsetDay(utcMs);
    // Not a time value: let Intl refuse it.
    if (!Number.isFinite(day)) return offsetAt(utcMs, this.formatter);
    let offset = this.midnight(day);
    for (const change of this.changesOn(day)) {
      if (utcMs < change.at) break;
      offset = change.after;
    }
    return offset;
  }

  /** The changes on UTC day `day`, in order. */
  changesOn(day: number): readonly ZoneTransition[] {
    const offset = this.midnight(day);
    if (offset === this.midnight(day + 1)) return NO_CHANGES;
    let found = this.changes.get(day);
    if (!found) {
      found = scanTransitions(
        (utcMs) => offsetAt(utcMs, this.formatter),
        dayStart(day),
        dayStart(day + 1),
        DAY_MS,
      );
      if (cachedChangeDays >= MAX_CACHED_CHANGE_DAYS) {
        for (const zone of zoneOffsetTables.values()) zone.changes.clear();
        cachedChangeDays = 0;
      }
      this.changes.set(day, found);
      cachedChangeDays += 1;
    }
    return found;
  }

  /** The changes from `fromMs` (exclusive) to `toMs` (inclusive), day by day. */
  transitions(fromMs: number, toMs: number): ZoneTransition[] {
    const found: ZoneTransition[] = [];
    const last = zoneOffsetDay(toMs);
    for (let day = zoneOffsetDay(fromMs); day <= last; day++) {
      for (const change of this.changesOn(day)) {
        if (change.at > fromMs && change.at <= toMs) found.push(change);
      }
    }
    return found;
  }

  private midnight(day: number): number {
    const block = Math.floor(day / BLOCK_DAYS);
    let offsets = this.midnights.get(block);
    if (!offsets) {
      if (cachedBlocks >= MAX_CACHED_BLOCKS) {
        for (const zone of zoneOffsetTables.values()) zone.midnights.clear();
        cachedBlocks = 0;
      }
      offsets = new Float64Array(BLOCK_DAYS).fill(Number.NaN);
      this.midnights.set(block, offsets);
      cachedBlocks += 1;
    }
    const index = day - block * BLOCK_DAYS;
    let offset = offsets[index] as number;
    if (Number.isNaN(offset)) {
      offset = offsetAt(dayStart(day), this.formatter);
      offsets[index] = offset;
    }
    return offset;
  }
}

/** A UTC day's first instant, as far as a Date reaches. */
function dayStart(day: number): number {
  return Math.min(Math.max(day * DAY_MS, -MAX_TIME_MS), MAX_TIME_MS);
}

/**
 * Each zone's offsets by name. A block of midnights is 4 KB; past this many blocks (16 MB) every
 * zone's are emptied, and likewise for days with changes.
 */
const zoneOffsetTables = new Map<string, ZoneOffsets>();
const MAX_CACHED_BLOCKS = 4_096;
const MAX_CACHED_CHANGE_DAYS = 20_000;
let cachedBlocks = 0;
let cachedChangeDays = 0;

function zoneOffsets(timezone: string): ZoneOffsets {
  const cached = zoneOffsetTables.get(timezone);
  if (cached) return cached;
  const offsets = new ZoneOffsets(createFormatter(timezone));
  if (zoneOffsetTables.size >= MAX_CACHED_FORMATTERS) {
    zoneOffsetTables.clear();
    cachedBlocks = 0;
    cachedChangeDays = 0;
  }
  zoneOffsetTables.set(timezone, offsets);
  return offsets;
}

/**
 * How many Intl reads finding the changes on UTC day `day` takes beyond its two midnights (about
 * twenty per change). Callers that must charge the same whatever the process has cached charge this
 * on first read.
 */
export function zoneOffsetChangeReads(timezone: string, day: number): number {
  if (timezone === 'UTC') return 0;
  return 20 * zoneOffsets(timezone).changesOn(day).length;
}

function buildFormatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw Object.assign(new Error(`Invalid timezone: ${timezone}`), { code: 'invalid_timezone' });
  }
}

function offsetAt(utcMs: number, formatter: Intl.DateTimeFormat): number {
  // Intl parts expose seconds, not milliseconds: compute the offset at the whole second so
  // sub-second input is not rounded into it.
  const wholeSecondMs = Math.floor(utcMs / 1000) * 1000;
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(wholeSecondMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const wallFrame = utcFrame(
    values.year ?? 0,
    values.month ?? 1,
    values.day ?? 1,
    (values.hour ?? 0) % 24,
    values.minute ?? 0,
    values.second ?? 0,
    0,
  ).getTime();
  return wallFrame - wholeSecondMs;
}

export function createTimeZoneConverter(timezone: string): TimeZoneConverter {
  if (timezone === 'UTC') {
    return { wallFrameToUtc: (wallFrameMs) => new Date(wallFrameMs) };
  }
  const offsets = zoneOffsets(timezone);
  const offsetIn = (utcMs: number) => offsets.offsetAt(utcMs);
  return {
    wallFrameToUtc(wallFrameMs, choice) {
      return new Date(wallFrameToInstant(wallFrameMs, offsetIn, choice));
    },
  };
}

/**
 * The spelling Slotlock keeps of an IANA zone: Intl's when it reads the name as itself in another
 * case (`europe/london` is `Europe/London`), else the name as given (`US/Eastern` stays, so a
 * stored name never depends on the ICU version). A UTC offset such as `+05:00` and unknown names
 * are refused with `code: 'invalid_timezone'`.
 */
export function canonicalTimeZoneName(timezone: string): string {
  const name = timezone.trim();
  const invalid = () =>
    Object.assign(new Error(`Invalid timezone: ${timezone}`), { code: 'invalid_timezone' });
  if (!name || /^[+-]/.test(name)) throw invalid();
  // Each name resolves the same for the process's life (its time zone data does not change under
  // it), and building a formatter to ask is the costly part: remembered, valid names only.
  const known = canonicalNames.get(name);
  if (known !== undefined) return known;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw invalid();
  }
  if (/^[+-]/.test(resolved)) throw invalid();
  const canonical = resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
  if (canonicalNames.size >= MAX_CANONICAL_NAMES) canonicalNames.clear();
  canonicalNames.set(name, canonical);
  return canonical;
}

/** Names canonicalTimeZoneName resolved; a few hundred zones exist, so this rarely fills. */
const canonicalNames = new Map<string, string>();
const MAX_CANONICAL_NAMES = 2_000;

export interface ZonedCalendarDate {
  /** Civil date of the instant in the zone, `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 weekday of that civil date: Monday = 1 … Sunday = 7. */
  isoWeekday: number;
}

/**
 * The civil date and ISO weekday an instant falls on in `timezone` (the inverse of {@link
 * zonedDateTimeToUtc}): a pickup at 00:30 BST on a Friday is a Friday, whatever UTC says.
 */
export function zonedCalendarDate(instant: Date, timezone: string): ZonedCalendarDate {
  const wall = wallFrame(instant, timezone);
  const weekday = wall.getUTCDay();
  return { date: civilDate(wall), isoWeekday: weekday === 0 ? 7 : weekday };
}

export interface ZonedWallTime {
  /** Civil date of the instant in the zone, `YYYY-MM-DD`. */
  date: string;
  /** Wall-clock time of the instant in the zone, 24-hour `HH:MM`. */
  time: string;
}

/**
 * The civil date and wall-clock time an instant reads as in `timezone`, as agreements and receipts
 * state a booking: on the resource's own clock.
 */
export function zonedWallTime(instant: Date, timezone: string): ZonedWallTime {
  const wall = wallFrame(instant, timezone);
  const hour = String(wall.getUTCHours()).padStart(2, '0');
  const minute = String(wall.getUTCMinutes()).padStart(2, '0');
  return { date: civilDate(wall), time: `${hour}:${minute}` };
}

/** How far `timezone` is ahead of UTC at `instant`, in whole minutes (negative west of UTC). */
export function zonedOffsetMinutes(instant: Date, timezone: string): number {
  return Math.round((wallFrame(instant, timezone).getTime() - instant.getTime()) / 60_000);
}

/** A wall clock's fields, to the second. */
export interface ZonedDateTimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The wall-clock fields an instant reads as in `timezone`, to the second: what a calendar writes
 * beside a TZID.
 */
export function zonedDateTimeFields(instant: Date, timezone: string): ZonedDateTimeFields {
  const wall = wallFrame(instant, timezone);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

/** The instant shifted so its UTC fields read as the wall clock in `timezone`. */
function wallFrame(instant: Date, timezone: string): Date {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error('Invalid instant'), { code: 'invalid_instant' });
  }
  const offset = timezone === 'UTC' ? 0 : zoneOffsets(timezone).offsetAt(ms);
  return new Date(ms + offset);
}

function civilDate(wall: Date): string {
  const year = String(wall.getUTCFullYear()).padStart(4, '0');
  const month = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const day = String(wall.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertLocalDateTime(value: LocalDateTime): void {
  const hour = value.hour ?? 0;
  const minute = value.minute ?? 0;
  const second = value.second ?? 0;
  const millisecond = value.millisecond ?? 0;
  const integers = [value.year, value.month, value.day, hour, minute, second, millisecond];
  if (!integers.every(Number.isInteger)) {
    throw Object.assign(new Error('Local date-time fields must be finite integers'), {
      code: 'invalid_local_datetime',
    });
  }
  const frame = utcFrame(value.year, value.month, value.day, hour, minute, second, millisecond);
  if (
    value.year < 1 ||
    frame.getUTCFullYear() !== value.year ||
    frame.getUTCMonth() !== value.month - 1 ||
    frame.getUTCDate() !== value.day ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999
  ) {
    throw Object.assign(new Error('Invalid local date-time'), { code: 'invalid_local_datetime' });
  }
}

export function zonedDateTimeToUtc(
  value: LocalDateTime,
  timezone: string,
  choice?: WallTimeChoice,
): Date {
  assertLocalDateTime(value);
  const wallFrame = utcFrame(
    value.year,
    value.month,
    value.day,
    value.hour ?? 0,
    value.minute ?? 0,
    value.second ?? 0,
    value.millisecond ?? 0,
  ).getTime();
  return createTimeZoneConverter(timezone).wallFrameToUtc(wallFrame, choice);
}

/** A change of a zone's offset: the instant it takes effect, and the offsets before and after. */
export interface ZoneTransition {
  /** The first whole second at the new offset, in ms. */
  at: number;
  /** How far the zone is ahead of UTC before and after it, in ms. */
  before: number;
  after: number;
}

/**
 * Every change of `timezone`'s offset from `fromMs` to `toMs`, read a day at a time (ZoneOffsets):
 * a weekly search misses short-lived changes such as Gaza's six-day one in October 2040.
 */
export function zoneTransitions(timezone: string, fromMs: number, toMs: number): ZoneTransition[] {
  if (timezone === 'UTC') return [];
  return zoneOffsets(timezone).transitions(
    Math.floor(fromMs / 1000) * 1000,
    Math.ceil(toMs / 1000) * 1000,
  );
}

/**
 * Offset changes found by comparing `offsetIn` `stepMs` apart and narrowing each to the second; a
 * change and its reversal within one step are missed.
 */
function scanTransitions(
  offsetIn: (utcMs: number) => number,
  fromMs: number,
  toMs: number,
  stepMs: number,
): ZoneTransition[] {
  const found: ZoneTransition[] = [];
  let at = Math.floor(fromMs / 1000) * 1000;
  let offset = offsetIn(at);
  while (at < toMs) {
    const next = Math.min(at + stepMs, Math.ceil(toMs / 1000) * 1000);
    if (offsetIn(next) === offset) {
      at = next;
      continue;
    }
    let low = at;
    let high = next;
    while (high - low > 1000) {
      const middle = Math.floor((low + high) / 2000) * 1000;
      if (offsetIn(middle) === offset) low = middle;
      else high = middle;
    }
    const after = offsetIn(high);
    found.push({ at: high, before: offset, after });
    offset = after;
    at = high;
  }
  return found;
}
