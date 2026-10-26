// Slotlock reads a zone's offsets from Intl a UTC month at a time and keeps them, rather than
// asking Intl for four to six offsets at every conversion: every occurrence of a series converts a
// time, and forty daily London series held a feed for 35 seconds that way (SEC-3). A month is read
// from its offsets at each UTC midnight, each change narrowed to the second, so it must give what
// Intl gives at every instant, a change and its reversal a few days apart included (Gaza's in 2040,
// which a search a week at a time missed, ENG-15).
import { describe, expect, it } from 'vitest';
import { zoneTransitions, zonedDateTimeFields, zonedDateTimeToUtc } from '../timezone.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** `zone`'s offset in ms at `at`, read from Intl itself. */
function intlOffset(zone: string, at: number): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wall = new Date(0);
  wall.setUTCFullYear(parts.year as number, (parts.month as number) - 1, parts.day as number);
  wall.setUTCHours(parts.hour as number, parts.minute as number, parts.second as number, 0);
  return wall.getTime() - Math.floor(at / 1000) * 1000;
}

/** The offset Slotlock reads for `zone` at `at`, from the wall-clock fields it gives. */
function slotlockOffset(zone: string, at: number): number {
  const fields = zonedDateTimeFields(new Date(at), zone);
  const wall = new Date(0);
  wall.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  wall.setUTCHours(fields.hour, fields.minute, fields.second, 0);
  return wall.getTime() - Math.floor(at / 1000) * 1000;
}

/** A fixed sequence of numbers in [0, 1), so a failure names the same instants every run. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Every change of `zone`'s offset from `from` to `to` an hourly search finds, as hour spans. */
function hourlyChanges(zone: string, from: number, to: number): number[] {
  const found: number[] = [];
  let previous = intlOffset(zone, from);
  for (let at = from + HOUR; at <= to; at += HOUR) {
    const offset = intlOffset(zone, at);
    if (offset !== previous) found.push(at);
    previous = offset;
  }
  return found;
}

const ZONES = [
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
  'US/Eastern',
  'Asia/Calcutta',
  'Etc/GMT-14',
  'Etc/GMT+12',
];

describe("a zone's offsets, read a month at a time", () => {
  it('give what Intl gives, in every zone it knows, at instants from 1850 to 2100', () => {
    const next = sequence(20261025);
    const from = Date.UTC(1850, 0, 1);
    const to = Date.UTC(2100, 0, 1);
    let compared = 0;
    for (const zone of ZONES) {
      for (let sample = 0; sample < 24; sample++) {
        // Whole seconds and fractions of one: the offset is Intl's at the whole second.
        const at = from + Math.floor(next() * (to - from));
        expect(slotlockOffset(zone, at), `${zone} ${new Date(at).toISOString()}`).toBe(
          intlOffset(zone, at),
        );
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(9_000);
  }, 120_000);

  it('give what Intl gives either side of every change, 2020 to 2032', () => {
    let changes = 0;
    for (const zone of ZONES) {
      for (const change of zoneTransitions(zone, Date.UTC(2020, 0, 1), Date.UTC(2032, 0, 1))) {
        for (const at of [change.at - 1000, change.at - 1, change.at, change.at + 999]) {
          expect(slotlockOffset(zone, at), `${zone} ${new Date(at).toISOString()}`).toBe(
            intlOffset(zone, at),
          );
        }
        expect(intlOffset(zone, change.at - 1000), zone).toBe(change.before);
        expect(intlOffset(zone, change.at), zone).toBe(change.after);
        changes += 1;
      }
    }
    expect(changes).toBeGreaterThan(1_000);
  }, 120_000);

  it.each([
    'Asia/Gaza',
    'Asia/Hebron',
    'Africa/Casablanca',
    'Africa/El_Aaiun',
    'Africa/Cairo',
    'America/Santiago',
    'Australia/Lord_Howe',
    'Antarctica/Troll',
  ])(
    'find every change an hourly search finds in %s, 2025 to 2070',
    (zone) => {
      const from = Date.UTC(2025, 0, 1);
      const to = Date.UTC(2070, 0, 1);
      const hourly = hourlyChanges(zone, from, to);
      const found = zoneTransitions(zone, from, to);
      expect(found.length, zone).toBe(hourly.length);
      found.forEach((change, index) => {
        // Each change lies in the hour before the hourly search first sees it.
        expect(change.at, zone).toBeGreaterThan((hourly[index] as number) - HOUR);
        expect(change.at, zone).toBeLessThanOrEqual(hourly[index] as number);
      });
    },
    60_000,
  );

  it('find a change and its reversal less than a week apart (Gaza and Hebron, 2040 and 2054)', () => {
    const short: string[] = [];
    for (const zone of ['Asia/Gaza', 'Asia/Hebron']) {
      for (const year of [2040, 2054]) {
        const from = Date.UTC(year, 0, 1);
        const to = Date.UTC(year + 1, 0, 1);
        const hourly = hourlyChanges(zone, from, to);
        // The changes this test is about: Intl's zone data has them (a canary, should a later
        // release of the data drop them).
        for (let index = 1; index < hourly.length; index++) {
          if ((hourly[index] as number) - (hourly[index - 1] as number) < 7 * DAY) {
            short.push(`${zone} ${new Date(hourly[index - 1] as number).toISOString()}`);
          }
        }
        expect(zoneTransitions(zone, from, to).length, `${zone} ${year}`).toBe(hourly.length);
      }
    }
    expect(short.length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('convert a wall time to its instant as before in a gap and a fold, Lord Howe included', () => {
    // 02:30 the night London's clocks go forward moves forward by the gap; 01:30 the night they go
    // back is its first instant (RFC 5545 §3.3.5), and the later one when asked for.
    const at = (zone: string, wall: number[], fold?: 'later') =>
      zonedDateTimeToUtc(
        {
          year: wall[0] as number,
          month: wall[1] as number,
          day: wall[2] as number,
          hour: wall[3] as number,
          minute: wall[4] as number,
        },
        zone,
        fold ? { fold } : undefined,
      ).toISOString();
    expect(at('Europe/London', [2027, 3, 28, 1, 30])).toBe('2027-03-28T01:30:00.000Z');
    expect(at('Europe/London', [2027, 10, 31, 1, 30])).toBe('2027-10-31T00:30:00.000Z');
    expect(at('Europe/London', [2027, 10, 31, 1, 30], 'later')).toBe('2027-10-31T01:30:00.000Z');
    // Lord Howe moves its clocks half an hour, at 02:00 standard time.
    expect(at('Australia/Lord_Howe', [2027, 10, 3, 2, 15])).toBe('2027-10-02T15:45:00.000Z');
    expect(at('Australia/Lord_Howe', [2027, 4, 4, 1, 45])).toBe('2027-04-03T14:45:00.000Z');
    expect(at('Australia/Lord_Howe', [2027, 4, 4, 1, 45], 'later')).toBe(
      '2027-04-03T15:15:00.000Z',
    );
  });
});
