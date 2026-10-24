// A feed series that began years ago (a daily standup since 2014) was searched from its DTSTART,
// past every occurrence before the window, so one such series refused the whole feed (D13). Now a
// series that repeats every so many days is searched from a whole number of periods after its
// DTSTART, and one Slotlock still cannot read is refused on its own, with the rest of the feed read.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarExpansionLimitError,
  parseICalendarChanges,
  parseICalendarFeed,
  recurrenceRuleProblem,
} from '../sync.js';
import { oracleOccurrences } from './helpers/rrule-oracle.js';

const DAY = 86_400_000;
const WINDOW = { start: new Date('2026-10-23T00:00:00Z'), end: new Date('2027-10-25T00:00:00Z') };

const cal = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const ev = (uid: string, ...lines: string[]) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20260101T000000Z',
  ...lines,
  'END:VEVENT',
];
const oneOff = ev('one-off', 'DTSTART:20270105T120000Z', 'DTEND:20270105T130000Z');
const standup = (rule: string) =>
  ev('standup', 'DTSTART:20140106T090000Z', 'DTEND:20140106T091500Z', `RRULE:${rule}`);
const startsOf = (uid: string, changes: { externalId: string; start: Date | null }[]) =>
  changes.filter((change) => change.externalId === uid).map((change) => change.start?.getTime());

/** Wall-clock fields of `instant` in `zone`, framed as UTC (as the oracle reads times). */
function wallFrame(instant: number, zone: string): number {
  const parts: Record<string, number> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  );
  const field = (name: string) => parts[name] ?? 0;
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}
const stamp = (frame: number) => new Date(frame).toISOString().replace(/[-:]/g, '').slice(0, 15);

describe('a daily standup since 2014 (D13)', () => {
  it('is read with the rest of the feed', () => {
    const changes = parseICalendarChanges(cal(...standup('FREQ=DAILY'), ...oneOff), 'UTC', WINDOW);
    const days = Math.round((WINDOW.end.getTime() - WINDOW.start.getTime()) / DAY);
    const expected = Array.from(
      { length: days },
      (_, day) => Date.parse('2026-10-23T09:00:00Z') + day * DAY,
    );
    expect(startsOf('standup', changes)).toEqual(expected);
    expect(startsOf('one-off', changes)).toEqual([Date.parse('2027-01-05T12:00:00Z')]);
  });

  it('weekly, every other week, on its own weekdays', () => {
    const changes = parseICalendarChanges(
      cal(...standup('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'), ...oneOff),
      'UTC',
      WINDOW,
    );
    const got = startsOf('standup', changes) as number[];
    const expected = oracleOccurrences(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
      Date.parse('2014-01-06T09:00:00Z'),
      WINDOW.end.getTime(),
    ).filter((start) => start + 15 * 60_000 > WINDOW.start.getTime());
    expect(got).toEqual(expected);
  });

  it('a series it cannot read is refused on its own, and the rest of the feed is read', () => {
    // A COUNT is counted from DTSTART, so this one is still searched from 2014: past the 4,000
    // occurrences a series may pass.
    const text = cal(...standup('FREQ=DAILY;COUNT=5000'), ...oneOff);
    expect(() => parseICalendarChanges(text, 'UTC', WINDOW)).toThrow(CalendarExpansionLimitError);
    const read = parseICalendarFeed(text, 'UTC', WINDOW);
    expect(startsOf('one-off', read.changes)).toEqual([Date.parse('2027-01-05T12:00:00Z')]);
    expect(startsOf('standup', read.changes)).toEqual([]);
    expect(read.refused).toEqual([{ uid: 'standup', code: 'invalid_icalendar', limit: true }]);
  });
});

/** A DAILY or WEEKLY rule with no COUNT, of a shape Slotlock accepts. */
const periodicRule = fc
  .record({
    freq: fc.constantFrom('DAILY', 'WEEKLY'),
    interval: fc.constantFrom(1, 1, 2, 3, 5),
    bymonth: fc.option(
      fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 4 }),
    ),
    bymonthday: fc.option(
      fc.uniqueArray(fc.constantFrom(1, 2, 13, 15, 28, 29, 31), { minLength: 1, maxLength: 3 }),
    ),
    byday: fc.option(
      fc.uniqueArray(fc.constantFrom('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'), {
        minLength: 1,
        maxLength: 3,
      }),
    ),
    byhour: fc.option(fc.uniqueArray(fc.constantFrom(8, 13, 17), { minLength: 1, maxLength: 2 })),
    wkst: fc.option(fc.constantFrom('SU', 'MO', 'WE')),
    until: fc.option(fc.constantFrom('20270301T000000Z', '20261201T000000Z', '20260101T000000Z')),
    zone: fc.constantFrom('UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney'),
    years: fc.integer({ min: 1, max: 14 }),
    day: fc.integer({ min: 0, max: 364 }),
  })
  .map((r) => {
    const parts = [`FREQ=${r.freq}`];
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
    if (r.bymonth) parts.push(`BYMONTH=${r.bymonth.join(',')}`);
    if (r.bymonthday && r.freq === 'DAILY') parts.push(`BYMONTHDAY=${r.bymonthday.join(',')}`);
    if (r.byday) parts.push(`BYDAY=${r.byday.join(',')}`);
    if (r.byhour) parts.push(`BYHOUR=${r.byhour.join(',')}`);
    if (r.wkst) parts.push(`WKST=${r.wkst}`);
    if (r.until) parts.push(`UNTIL=${r.until}`);
    const start = Date.UTC(2026 - r.years, 0, 1, 9) + r.day * DAY;
    return { rule: parts.join(';'), zone: r.zone, start };
  })
  .filter(({ rule }) => recurrenceRuleProblem(rule) === null);

describe('a series searched from a whole number of periods after its start', () => {
  it('has the occurrences it has when searched from its start', () => {
    fc.assert(
      fc.property(periodicRule, ({ rule, zone, start }) => {
        // A DTSTART the rule produces (RFC 5545 leaves an unsynchronised one undefined).
        const first = oracleOccurrences(
          rule.replace(/;UNTIL=\w+/, ''),
          start,
          start + 800 * DAY,
        )[0];
        if (first === undefined) return;
        const window = { start: WINDOW.start, end: new Date(WINDOW.start.getTime() + 60 * DAY) };
        const zoned =
          zone === 'UTC' ? `DTSTART:${stamp(first)}Z` : `DTSTART;TZID=${zone}:${stamp(first)}`;
        const ended =
          zone === 'UTC'
            ? `DTEND:${stamp(first + 1_800_000)}Z`
            : `DTEND;TZID=${zone}:${stamp(first + 1_800_000)}`;
        const text = cal(...ev('s', zoned, ended, `RRULE:${rule}`));
        const got = parseICalendarChanges(text, undefined, window).map((change) =>
          wallFrame((change.start as Date).getTime(), zone),
        );
        // The oracle reads wall times, a UTC UNTIL included; a window's edge, a few hours either
        // side, is left out.
        const from = wallFrame(window.start.getTime(), zone) + DAY;
        const to = wallFrame(window.end.getTime(), zone) - DAY;
        const wallRule = rule.replace(
          /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
          (_match, y, mo, d, h, mi, sec) =>
            `UNTIL=${stamp(wallFrame(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec), zone))}`,
        );
        const expected = oracleOccurrences(wallRule, first, to).filter((wall) => wall >= from);
        expect(
          got.filter((wall) => wall >= from && wall < to),
          `${rule} ${zone}`,
        ).toEqual(expected);
      }),
      { seed: 20261024, numRuns: 300 },
    );
  });
});
