// A brute-force reading of RFC 5545 §3.3.10 for the tests to hold ical.js's expansion to. For each
// period of the rule's frequency it lists every candidate date-time, keeps those every BYxxx part
// allows (the "expand" parts of the §3.3.10 table become filters over a period's candidates, which
// lists the same set), takes BYSETPOS over what remains, and applies DTSTART, COUNT and UNTIL. It
// works on wall-clock fields framed as UTC (no zones) and leaves out BYWEEKNO, which Slotlock
// refuses. Every RFC 5545 §3.8.5.3 example it can read is checked against it in the tests.

const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface OracleRule {
  freq: 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  /** Inclusive, as a UTC frame. */
  until?: number;
  bymonth?: number[];
  byyearday?: number[];
  bymonthday?: number[];
  byday?: { n: number; weekday: number }[];
  byhour?: number[];
  byminute?: number[];
  bysecond?: number[];
  bysetpos?: number[];
  /** 0 = Sunday ... 6 = Saturday; Monday by default. */
  wkst: number;
}

/** A rule as text (no BYWEEKNO), read into the oracle's form; `until` must be UTC or floating. */
export function oracleRule(text: string): OracleRule {
  const rule: OracleRule = { freq: 'DAILY', interval: 1, wkst: 1 };
  const numbers = (value: string) => value.split(',').map(Number);
  for (const part of text.split(';')) {
    const [key, value = ''] = part.split('=');
    switch (key) {
      case 'FREQ':
        rule.freq = value as OracleRule['freq'];
        break;
      case 'INTERVAL':
        rule.interval = Number(value);
        break;
      case 'COUNT':
        rule.count = Number(value);
        break;
      case 'UNTIL': {
        const [, y, mo, d, h = '0', mi = '0', s = '0'] =
          /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value) ?? [];
        rule.until = Date.UTC(
          Number(y),
          Number(mo) - 1,
          Number(d),
          Number(h),
          Number(mi),
          Number(s),
        );
        if (value.length === 8) rule.until += DAY - 1000;
        break;
      }
      case 'BYMONTH':
        rule.bymonth = numbers(value);
        break;
      case 'BYYEARDAY':
        rule.byyearday = numbers(value);
        break;
      case 'BYMONTHDAY':
        rule.bymonthday = numbers(value);
        break;
      case 'BYDAY':
        rule.byday = value.split(',').map((day) => {
          const [, n = '0', code = ''] = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(day) ?? [];
          return { n: Number(n), weekday: WEEKDAYS.indexOf(code) };
        });
        break;
      case 'BYHOUR':
        rule.byhour = numbers(value);
        break;
      case 'BYMINUTE':
        rule.byminute = numbers(value);
        break;
      case 'BYSECOND':
        rule.bysecond = numbers(value);
        break;
      case 'BYSETPOS':
        rule.bysetpos = numbers(value);
        break;
      case 'WKST':
        rule.wkst = WEEKDAYS.indexOf(value);
        break;
      default:
        throw new Error(`the oracle does not read ${key}`);
    }
  }
  return rule;
}

const fields = (ms: number) => {
  const t = new Date(ms);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    weekday: t.getUTCDay(),
  };
};
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
const daysInYear = (year: number) => (daysInMonth(year, 2) === 29 ? 366 : 365);
const dayOfYear = (ms: number) => {
  const { year } = fields(ms);
  return Math.round((ms - Date.UTC(year, 0, 1)) / DAY) + 1;
};
/** `value` (1-based, or negative from the end) names position `index` of `length`. */
const names = (value: number, index: number, length: number) =>
  value > 0 ? value === index : length + value + 1 === index;

/** The days (UTC midnights) of one period whose day-level BYxxx parts and defaults allow them. */
function periodDays(rule: OracleRule, start: number, k: number): number[] {
  const s = fields(start);
  let days: number[];
  switch (rule.freq) {
    case 'YEARLY': {
      const year = s.year + k * rule.interval;
      days = Array.from({ length: daysInYear(year) }, (_, i) => Date.UTC(year, 0, 1) + i * DAY);
      break;
    }
    case 'MONTHLY': {
      const index = s.year * 12 + s.month - 1 + k * rule.interval;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      days = Array.from(
        { length: daysInMonth(year, month) },
        (_, i) => Date.UTC(year, month - 1, 1) + i * DAY,
      );
      break;
    }
    case 'WEEKLY': {
      const startDay = Date.UTC(s.year, s.month - 1, s.day);
      const weekStart = startDay - ((s.weekday - rule.wkst + 7) % 7) * DAY;
      const first = weekStart + k * rule.interval * 7 * DAY;
      days = Array.from({ length: 7 }, (_, i) => first + i * DAY);
      break;
    }
    case 'DAILY':
      days = [Date.UTC(s.year, s.month - 1, s.day) + k * rule.interval * DAY];
      break;
    default: {
      const unit = rule.freq === 'HOURLY' ? 3_600_000 : rule.freq === 'MINUTELY' ? 60_000 : 1000;
      const instant = start + k * rule.interval * unit;
      const f = fields(instant);
      days = [Date.UTC(f.year, f.month - 1, f.day)];
    }
  }
  return days.filter((day) => dayAllowed(rule, s, day));
}

function dayAllowed(rule: OracleRule, s: ReturnType<typeof fields>, day: number): boolean {
  const f = fields(day);
  if (rule.bymonth && !rule.bymonth.includes(f.month)) return false;
  if (rule.byyearday && !rule.byyearday.some((n) => names(n, dayOfYear(day), daysInYear(f.year)))) {
    return false;
  }
  const monthLength = daysInMonth(f.year, f.month);
  if (rule.bymonthday && !rule.bymonthday.some((n) => names(n, f.day, monthLength))) return false;
  if (rule.byday) {
    const inMonth = rule.freq === 'MONTHLY' || (rule.freq === 'YEARLY' && rule.bymonth);
    const allowed = rule.byday.some(({ n, weekday }) => {
      if (weekday !== f.weekday) return false;
      if (n === 0) return true;
      if (inMonth) {
        const nth = Math.floor((f.day - 1) / 7) + 1;
        const fromEnd = Math.floor((monthLength - f.day) / 7) + 1;
        return n > 0 ? nth === n : fromEnd === -n;
      }
      const doy = dayOfYear(day);
      const nth = Math.floor((doy - 1) / 7) + 1;
      const fromEnd = Math.floor((daysInYear(f.year) - doy) / 7) + 1;
      return n > 0 ? nth === n : fromEnd === -n;
    });
    if (!allowed) return false;
  }
  // What DTSTART supplies where no BYxxx part says.
  switch (rule.freq) {
    case 'YEARLY':
      if (!rule.bymonth && !rule.byyearday && !rule.bymonthday && !rule.byday) {
        return f.month === s.month && f.day === s.day;
      }
      if (!rule.byyearday && !rule.bymonthday && !rule.byday) return f.day === s.day;
      return true;
    case 'MONTHLY':
      return rule.bymonthday || rule.byday ? true : f.day === s.day;
    case 'WEEKLY':
      return rule.byday ? true : f.weekday === s.weekday;
    default:
      return true;
  }
}

/** One period's candidates, sorted, after BYSETPOS. */
function periodCandidates(rule: OracleRule, start: number, k: number): number[] {
  const s = fields(start);
  const unit = { HOURLY: 3_600_000, MINUTELY: 60_000, SECONDLY: 1000 } as Record<string, number>;
  const out: number[] = [];
  for (const day of periodDays(rule, start, k)) {
    let hours = rule.byhour ?? [s.hour];
    let minutes = rule.byminute ?? [s.minute];
    let seconds = rule.bysecond ?? [s.second];
    if (rule.freq === 'HOURLY' || rule.freq === 'MINUTELY' || rule.freq === 'SECONDLY') {
      const f = fields(start + k * rule.interval * (unit[rule.freq] as number));
      if (rule.byhour && !rule.byhour.includes(f.hour)) continue;
      hours = [f.hour];
      if (rule.freq !== 'HOURLY') {
        if (rule.byminute && !rule.byminute.includes(f.minute)) continue;
        minutes = [f.minute];
      }
      if (rule.freq === 'SECONDLY') {
        if (rule.bysecond && !rule.bysecond.includes(f.second)) continue;
        seconds = [f.second];
      }
    }
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const second of seconds) {
          out.push(day + ((hour * 60 + minute) * 60 + second) * 1000);
        }
      }
    }
  }
  out.sort((a, b) => a - b);
  if (!rule.bysetpos) return out;
  const bysetpos = rule.bysetpos;
  return out.filter((_, index) => bysetpos.some((n) => names(n, index + 1, out.length)));
}

/**
 * The rule's occurrences from `start` (a UTC frame, the DTSTART) before `to`, as UTC frames. DTSTART
 * is always the first (RFC 5545 §3.8.5.3), counted toward COUNT.
 */
export function oracleOccurrences(text: string, start: number, to: number): number[] {
  const rule = oracleRule(text);
  const out: number[] = [start];
  let produced = 1;
  // Every candidate of period k is on or after this: k of the period's shortest length after
  // DTSTART, less the most a period can start before DTSTART's own (a year and a bit).
  const shortest = { YEARLY: 365, MONTHLY: 28, WEEKLY: 7, DAILY: 1 } as Record<string, number>;
  const unitMs = { HOURLY: 3_600_000, MINUTELY: 60_000, SECONDLY: 1000 } as Record<string, number>;
  const periodMs = (shortest[rule.freq] ?? 0) * DAY + (unitMs[rule.freq] ?? 0);
  for (let k = 0; k < 20_000; k++) {
    if (start - 400 * DAY + k * rule.interval * periodMs >= to) return out;
    const candidates = periodCandidates(rule, start, k);
    for (const candidate of candidates) {
      if (candidate <= start) continue;
      if (rule.until !== undefined && candidate > rule.until) return out;
      if (rule.count !== undefined && produced >= rule.count) return out;
      if (candidate >= to) return out;
      out.push(candidate);
      produced += 1;
    }
  }
  return out;
}
