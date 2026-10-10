export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export interface TimeZoneConverter {
  /**
   * Convert UTC-framed wall-clock fields to the instant that reads as those fields in this zone.
   * Compatible disambiguation: first instant for a fold; shift forward by the gap for a hole.
   */
  wallFrameToUtc(wallFrameMs: number): Date;
}

const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;

/**
 * Date.UTC remaps years 0..99 to 1900..1999. Slotlock accepts ISO calendar years down to 1,
 * so construct UTC frames through setUTCFullYear instead of inheriting that legacy quirk.
 */
function utcFrame(
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

function createFormatter(timezone: string): Intl.DateTimeFormat {
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
  const formatter = createFormatter(timezone);
  return {
    wallFrameToUtc(wallFrameMs) {
      const offsets = new Set([
        offsetAt(wallFrameMs - FOURTEEN_HOURS_MS, formatter),
        offsetAt(wallFrameMs, formatter),
        offsetAt(wallFrameMs + FOURTEEN_HOURS_MS, formatter),
      ]);
      const valid: number[] = [];
      for (const offset of offsets) {
        if (offsetAt(wallFrameMs - offset, formatter) === offset) valid.push(offset);
      }
      if (valid.length === 1) return new Date(wallFrameMs - (valid[0] as number));
      if (valid.length > 1) return new Date(wallFrameMs - Math.max(...valid));
      return new Date(wallFrameMs - Math.min(...offsets));
    },
  };
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

/** The instant shifted so its UTC fields read as the wall clock in `timezone`. */
function wallFrame(instant: Date, timezone: string): Date {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error('Invalid instant'), { code: 'invalid_instant' });
  }
  const offset = timezone === 'UTC' ? 0 : offsetAt(ms, createFormatter(timezone));
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

export function zonedDateTimeToUtc(value: LocalDateTime, timezone: string): Date {
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
  return createTimeZoneConverter(timezone).wallFrameToUtc(wallFrame);
}
