// Randomised series around every clock change from October 2026 to October 2028 in seven zones,
// held to an Intl-only statement of the occupation rule (helpers/dst-oracle.ts): each occurrence
// occupies the union of its exact and its wall-clock reading. The feed path, the trusted importer
// with the store's expansion, and the store's export read back as a feed must all give it.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  emitITipCalendar,
  expandCalendarEventOccurrences,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';
import type { CalendarEventContent } from '../types.js';
import {
  instantsOf,
  occupation,
  resolve,
  transitions,
  wallFrame,
  wallOf,
  wallText,
} from './helpers/dst-oracle.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ZONES = [
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'America/Santiago',
];
const CHANGES = ZONES.flatMap((zone) =>
  transitions(zone, Date.UTC(2026, 9, 1), Date.UTC(2028, 9, 1)).map((at) => ({ zone, at })),
);

/** A DAILY or WEEKLY COUNT series with an occurrence on or near the day the clocks change. */
const seriesNearAChange = fc
  .record({
    change: fc.integer({ min: 0, max: CHANGES.length - 1 }),
    weekly: fc.boolean(),
    before: fc.integer({ min: 0, max: 2 }),
    after: fc.integer({ min: 0, max: 2 }),
    // Quarter hours from the clock change's own wall time, or anywhere in the day.
    near: fc.boolean(),
    quarters: fc.integer({ min: -12, max: 12 }),
    anyQuarter: fc.integer({ min: 0, max: 95 }),
    lengthQuarters: fc.integer({ min: 1, max: 20 }),
  })
  .map((r) => {
    const { zone, at } = CHANGES[r.change] as { zone: string; at: number };
    const every = r.weekly ? 7 : 1;
    // The wall time just before the clocks change, and its day.
    const changeWall = wallOf(at - 1000, zone) + 1000;
    const changeDay = Math.floor(changeWall / DAY) * DAY;
    const minuteOfDay = r.near
      ? Math.round((changeWall - changeDay) / (15 * MINUTE)) * 15 * MINUTE +
        r.quarters * 15 * MINUTE
      : r.anyQuarter * 15 * MINUTE;
    const start = changeDay - r.before * every * DAY + minuteOfDay;
    return {
      zone,
      start: wallText(start),
      end: wallText(start + r.lengthQuarters * 15 * MINUTE),
      everyDays: every,
      count: r.before + 1 + r.after,
    };
  });

const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
type Span = [string, string];
const sorted = (spans: Span[]) => [...spans].sort((a, b) => a[0].localeCompare(b[0]));

describe('every occurrence near a clock change, on every path', () => {
  it('occupies the union of its exact and wall-clock readings', () => {
    fc.assert(
      fc.property(seriesNearAChange, (series) => {
        const { zone, start, end, everyDays, count } = series;
        const rule = `RRULE:FREQ=${everyDays === 7 ? 'WEEKLY' : 'DAILY'};COUNT=${count}`;
        const ics = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//t//EN',
          'BEGIN:VEVENT',
          'UID:s',
          'DTSTAMP:20260101T000000Z',
          'SUMMARY:s',
          `DTSTART;TZID=${zone}:${start}`,
          `DTEND;TZID=${zone}:${end}`,
          rule,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n');
        const first = resolve(wallFrame(start), zone);
        const window = {
          start: new Date(first - 2 * DAY),
          end: new Date(first + (count * everyDays + 2) * DAY),
        };
        const label = `${zone} ${start}-${end} ${rule}`;
        const s0 = first;
        const e0 = resolve(wallFrame(end), zone);
        // An end the clocks move onto or before its start cannot be read: both parsers refuse it.
        if (e0 <= s0) {
          expect(() => parseICalendarChanges(ics, undefined, window), label).toThrow(
            CalendarContractError,
          );
          expect(() => parseTrustedICalendarEvents(ics), label).toThrow(CalendarContractError);
          return;
        }
        const expected = sorted(
          occupation(series).map(([from, to]): Span => [minute(from), minute(to)]),
        );
        const feed = sorted(
          parseICalendarChanges(ics, undefined, window).map(
            (change): Span => [
              minute((change.start as Date).getTime()),
              minute((change.end as Date).getTime()),
            ],
          ),
        );
        expect(feed, `feed: ${label}`).toEqual(expected);
        // A DTSTART the clocks skip has no instant that reads as it: the importer refuses it.
        const startWall = wallFrame(start);
        if (instantsOf(startWall, zone).length === 0) {
          expect(() => parseTrustedICalendarEvents(ics), label).toThrow(CalendarContractError);
          return;
        }
        const [event] = parseTrustedICalendarEvents(ics);
        const stored = sorted(
          expandCalendarEventOccurrences(event as CalendarEventContent, window).map(
            (occurrence): Span => [
              minute(occurrence.start.getTime()),
              minute(occurrence.end.getTime()),
            ],
          ),
        );
        expect(stored, `store: ${label}`).toEqual(expected);
        const exported = emitITipCalendar(
          { ...(event as CalendarEventContent), uid: 's@slotlock.test' },
          'PUBLISH',
        );
        const readBack = sorted(
          parseICalendarChanges(exported, undefined, window).map(
            (change): Span => [
              minute((change.start as Date).getTime()),
              minute((change.end as Date).getTime()),
            ],
          ),
        );
        expect(readBack, `export: ${label}`).toEqual(expected);
      }),
      { seed: 20261024, numRuns: 1500 },
    );
  }, 300_000);

  it('tries starts and ends the clocks skip or repeat, and lengths they collapse', () => {
    const kinds = { startSkipped: 0, startRepeated: 0, endSkipped: 0, endRepeated: 0, gone: 0 };
    for (const series of fc.sample(seriesNearAChange, { seed: 20261024, numRuns: 1500 })) {
      const starts = instantsOf(wallFrame(series.start), series.zone).length;
      const ends = instantsOf(wallFrame(series.end), series.zone).length;
      if (starts === 0) kinds.startSkipped += 1;
      if (starts === 2) kinds.startRepeated += 1;
      if (ends === 0) kinds.endSkipped += 1;
      if (ends === 2) kinds.endRepeated += 1;
      const first = resolve(wallFrame(series.start), series.zone);
      if (resolve(wallFrame(series.end), series.zone) <= first) kinds.gone += 1;
    }
    // A length the clocks collapse needs both ends in one gap, the end at its close: rare.
    const { gone, ...rest } = kinds;
    for (const [kind, count] of Object.entries(rest)) {
      expect(count, kind).toBeGreaterThanOrEqual(10);
    }
    expect(gone).toBeGreaterThanOrEqual(2);
  });

  it('covers every clock change in every zone: two a year, at least', () => {
    for (const zone of ZONES) {
      expect(CHANGES.filter((change) => change.zone === zone).length, zone).toBeGreaterThanOrEqual(
        4,
      );
    }
  });
});
