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
 * Which instant a wall time names where the clocks change. RFC 5545 §3.3.5 reads a time in a fold
 * (an hour the clocks repeat) as its first instant, and a time in a gap (an hour they skip) with the
 * offset in force before the gap, which moves it forward by the gap: the defaults.
 */
export interface WallTimeChoice {
  /** In a fold: the earlier instant (default), or the later one. */
  fold?: 'earlier' | 'later';
  /** In a gap: moved forward by the gap (default), or the instant the gap ends. */
  gap?: 'shift' | 'end';
}

export interface TimeZoneConverter {
  /**
   * Convert UTC-framed wall-clock fields to the instant that reads as those fields in this zone.
   * By default the first instant for a fold, and shifted forward by the gap for a hole.
   */
  wallFrameToUtc(wallFrameMs: number, choice?: WallTimeChoice): Date;
}

const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;

/**
 * The instant, in ms, that reads as `wallFrameMs` (wall-clock fields framed as UTC) in a zone whose
 * offset at an instant `offsetAt` gives, in ms. The offsets in force within fourteen hours either
 * side are the candidates (no zone is further than that from UTC, so they include both sides of any
 * change the wall time is near); one that maps back to the wall time names it. Two do in a fold,
 * none in a gap, where the offset before the gap is the smaller one.
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
  // The gap ends at the change: the first whole second after the instant read with the offset
  // after the gap (which is still before it) whose offset differs from that one's.
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
 * Date.UTC remaps years 0..99 to 1900..1999. Slotlock accepts ISO calendar years down to 1,
 * so construct UTC frames through setUTCFullYear instead of inheriting that legacy quirk.
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
 * Formatters already built, by zone name. Building one costs far more than using it, and every
 * conversion needs one: a recurring series reads about three times an occurrence. A formatter never
 * changes, so one per zone serves every caller. Intl accepts every capitalisation of each zone's
 * name, so the map is emptied when it fills rather than growing with whatever names arrive.
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
 * How far either side of a wall time converting it to its instant reads the zone's offsets: no zone
 * is further than this from UTC. The days from one end to the other hold every offset it reads.
 */
export const ZONE_OFFSET_REACH_MS = FOURTEEN_HOURS_MS;

/** How many midnights one block of a zone's offsets holds. */
const BLOCK_DAYS = 512;
const NO_CHANGES: readonly ZoneTransition[] = [];

/**
 * A zone's offsets, read from Intl a UTC day at a time and kept. Intl's formatToParts takes about
 * two microseconds and a conversion asks for four to six offsets, so a series that converts a time
 * at each of thousands of occurrences spent most of its time there (forty daily London series from
 * 2016, 35 seconds). Each UTC midnight's offset is read once; a day whose two midnights agree has
 * that offset throughout, and one whose midnights differ has each change in it narrowed to the
 * second (scanTransitions). A change and its reversal within one day would be missed; the tests
 * compare the zones whose clocks change most with an hourly search.
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
    // Not a time value: Intl refuses it, as it always has.
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
 * Each zone's offsets, by name, as createFormatter keeps formatters. A block of midnights takes 4
 * KB; once there are this many (16 MB, about 57 zone-centuries), every zone's are emptied, and so
 * are the days with changes once there are this many of those (zones change twice a year at most
 * but for a few).
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
 * How many instants reading `timezone`'s offsets on UTC day `day` asks Intl for with none of them
 * kept, beyond the day's two midnights (one each): about twenty to find each change between them.
 * A caller that must charge the same for an input however much the process has kept charges each
 * midnight and this the first time it reads them.
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
  // Intl parts expose seconds but not milliseconds. Compute the zone offset against the same
  // whole-second instant so sub-second input does not leak into the offset and get rounded away.
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
 * The spelling Slotlock keeps of an IANA zone name: Intl's, when Intl reads the name as itself in
 * another case (`europe/london` is `Europe/London`); otherwise the name as given (`US/Eastern` stays,
 * although this Node's ICU may call it `America/New_York`, so a stored name never depends on the
 * ICU version that wrote it). A UTC offset (`+05:00`, which Intl accepts as a zone) is not an IANA
 * name and is refused, as is anything Intl does not know: both with `code: 'invalid_timezone'`.
 */
export function canonicalTimeZoneName(timezone: string): string {
  const name = timezone.trim();
  const invalid = () =>
    Object.assign(new Error(`Invalid timezone: ${timezone}`), { code: 'invalid_timezone' });
  if (!name || /^[+-]/.test(name)) throw invalid();
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw invalid();
  }
  if (/^[+-]/.test(resolved)) throw invalid();
  return resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
}

export interface ZonedCalendarDate {
  /** Civil date of the instant in the zone, `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 weekday of that civil date: Monday = 1 … Sunday = 7. */
  isoWeekday: number;
}

/**
 * The civil date and ISO weekday an instant falls on in `timezone` — the inverse direction of
 * {@link zonedDateTimeToUtc}. Pricing reads "which day is this night" through here so a pickup at
 * 00:30 BST on a Friday is a Friday, not the Thursday its UTC timestamp reads as.
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
 * The civil date and wall-clock time an instant reads as in `timezone`. Agreements and receipts
 * state a booking's start and end as a date and a time on the resource's own clock, not the
 * server's and not UTC.
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
 * beside a TZID. Reads through the cached formatters, as every conversion here does.
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
 * Every change of `timezone`'s offset from `fromMs` to `toMs`, as Intl reads the zone, from its
 * offsets a day at a time (ZoneOffsets): Gaza's clocks go forward on 20 October 2040 and back six
 * days later, which a search a week at a time missed.
 */
export function zoneTransitions(timezone: string, fromMs: number, toMs: number): ZoneTransition[] {
  if (timezone === 'UTC') return [];
  return zoneOffsets(timezone).transitions(
    Math.floor(fromMs / 1000) * 1000,
    Math.ceil(toMs / 1000) * 1000,
  );
}

/**
 * The changes of the offset `offsetIn` reads from `fromMs` to `toMs`, found by comparing offsets
 * `stepMs` apart and narrowing each change to the second: a change and its reversal both within
 * one step are missed.
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
    // The last whole second at `offset` and the first at another.
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
