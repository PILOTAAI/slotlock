// A stored event is instants and a zone. Its expansion starts from those instants, never from wall
// times read back out of them (an instant in a repeated hour has no wall time of its own), keys its
// exceptions by instant, and refuses an exception that names no occurrence; its export reads back as
// the same occupation.
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  emitITipCalendar,
  expandCalendarEventOccurrences,
  normalizeCalendarEventContent,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';
import type { CalendarEventContent } from '../types.js';

const d = (iso: string) => new Date(iso);
const w = (start: string, end: string) => ({ start: d(start), end: d(end) });
const spans = (occurrences: { start: Date; end: Date }[]) =>
  occurrences.map((o) => [o.start.toISOString(), o.end.toISOString()]);
const berlinGapSeries = (
  exceptions?: NonNullable<CalendarEventContent['recurrence']>['exceptions'],
): CalendarEventContent => ({
  start: d('2027-03-26T01:30:00Z'), // 02:30 CET
  end: d('2027-03-26T02:30:00Z'),
  timezone: 'Europe/Berlin',
  summary: 'Night check',
  recurrence: { rrule: 'FREQ=DAILY;COUNT=5', ...(exceptions ? { exceptions } : {}) },
});
const GAP_NIGHT = w('2027-03-27T00:00:00Z', '2027-03-30T00:00:00Z');

describe('a stored series in a repeated hour (ENG-2)', () => {
  it('starts at its stored instant: the second 01:15 stays the second', () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        start: d('2026-10-25T01:15:00Z'),
        end: d('2026-10-25T01:45:00Z'),
        timezone: 'Europe/London',
        summary: 'x',
        recurrence: { rrule: 'FREQ=DAILY;COUNT=2' },
      },
      w('2026-10-24T00:00:00Z', '2026-10-28T00:00:00Z'),
    );
    expect(occurrences).toEqual([
      {
        recurrenceId: '2026-10-25T01:15:00.000Z',
        start: d('2026-10-25T01:15:00Z'),
        end: d('2026-10-25T01:45:00Z'),
      },
      {
        recurrenceId: '2026-10-26T01:15:00.000Z',
        start: d('2026-10-26T01:15:00Z'),
        end: d('2026-10-26T01:45:00Z'),
      },
    ]);
  });

  it('keeps a series that runs across the fold, from 01:30 BST to 01:30 GMT', () => {
    expect(
      spans(
        expandCalendarEventOccurrences(
          {
            start: d('2026-10-25T00:30:00Z'),
            end: d('2026-10-25T01:30:00Z'),
            timezone: 'Europe/London',
            summary: 'x',
            recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
          },
          w('2026-10-24T00:00:00Z', '2026-10-30T00:00:00Z'),
        ),
      ),
    ).toEqual([
      ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
      ['2026-10-26T01:30:00.000Z', '2026-10-26T02:30:00.000Z'],
      ['2026-10-27T01:30:00.000Z', '2026-10-27T02:30:00.000Z'],
    ]);
  });

  it('exports a second-pass start so that a reader finds the same first instance', () => {
    const event = {
      uid: 'second-pass@slotlock.test',
      start: d('2026-10-25T01:15:00Z'),
      end: d('2026-10-25T01:45:00Z'),
      timezone: 'Europe/London',
      summary: 'x',
      recurrence: { rrule: 'FREQ=DAILY;COUNT=2' },
    };
    const text = emitITipCalendar(event, 'PUBLISH');
    expect(
      parseICalendarChanges(text, undefined, w('2026-10-24T00:00:00Z', '2026-10-28T00:00:00Z'))
        .filter((c) => !c.deleted && c.busy)
        .map((c) => [c.start?.toISOString(), c.end?.toISOString()]),
    ).toEqual([
      ['2026-10-25T01:15:00.000Z', '2026-10-25T01:45:00.000Z'],
      ['2026-10-26T01:15:00.000Z', '2026-10-26T01:45:00.000Z'],
    ]);
    // And the trusted parser stores it back with the same occupation.
    const [stored] = parseTrustedICalendarEvents(text);
    expect(
      spans(
        expandCalendarEventOccurrences(
          stored as CalendarEventContent,
          w('2026-10-24T00:00:00Z', '2026-10-28T00:00:00Z'),
        ),
      ),
    ).toEqual([
      ['2026-10-25T01:15:00.000Z', '2026-10-25T01:45:00.000Z'],
      ['2026-10-26T01:15:00.000Z', '2026-10-26T01:45:00.000Z'],
    ]);
  });
});

describe("a stored series' skipped-hour occurrence (ENG-3)", () => {
  it('is cancelled by its UTC instant', () => {
    expect(
      spans(
        expandCalendarEventOccurrences(
          berlinGapSeries([{ recurrenceId: d('2027-03-28T01:30:00Z'), cancelled: true }]),
          GAP_NIGHT,
        ),
      ),
    ).toEqual([
      ['2027-03-27T01:30:00.000Z', '2027-03-27T02:30:00.000Z'],
      ['2027-03-29T00:30:00.000Z', '2027-03-29T01:30:00.000Z'],
    ]);
  });

  it('is moved by its UTC instant, and occupies only where it moved to', () => {
    expect(
      spans(
        expandCalendarEventOccurrences(
          berlinGapSeries([
            {
              recurrenceId: d('2027-03-28T01:30:00Z'),
              start: d('2027-03-28T10:00:00Z'),
              end: d('2027-03-28T11:00:00Z'),
            },
          ]),
          GAP_NIGHT,
        ),
      ),
    ).toEqual([
      ['2027-03-27T01:30:00.000Z', '2027-03-27T02:30:00.000Z'],
      ['2027-03-28T10:00:00.000Z', '2027-03-28T11:00:00.000Z'],
      ['2027-03-29T00:30:00.000Z', '2027-03-29T01:30:00.000Z'],
    ]);
  });

  it('is exported with its RECURRENCE-ID in UTC', () => {
    const text = emitITipCalendar(
      {
        ...berlinGapSeries([{ recurrenceId: d('2027-03-28T01:30:00Z'), cancelled: true }]),
        uid: 'gap@slotlock.test',
      },
      'PUBLISH',
    );
    expect(text.split('\r\n').filter((line) => line.startsWith('RECURRENCE-ID'))).toEqual([
      'RECURRENCE-ID:20270328T013000Z',
    ]);
  });

  it.each([
    ['an instant no occurrence starts at', '2027-03-28T02:30:00Z'],
    ['an instant before the series starts', '2027-03-25T01:30:00Z'],
    ['an instant after the series ends', '2027-04-02T00:30:00Z'],
  ])('refuses an exception for %s, cancelled or moved', (_what, recurrenceId) => {
    for (const exception of [
      { recurrenceId: d(recurrenceId), cancelled: true },
      {
        recurrenceId: d(recurrenceId),
        start: d('2027-03-28T10:00:00Z'),
        end: d('2027-03-28T11:00:00Z'),
      },
    ]) {
      expect(() => expandCalendarEventOccurrences(berlinGapSeries([exception]), GAP_NIGHT)).toThrow(
        CalendarContractError,
      );
    }
  });

  const feed = (...extra: string[][]) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//t//EN',
      'BEGIN:VEVENT',
      'UID:g',
      'DTSTAMP:20260101T000000Z',
      'SUMMARY:x',
      'DTSTART;TZID=Europe/Berlin:20270326T023000',
      'DTEND;TZID=Europe/Berlin:20270326T033000',
      'RRULE:FREQ=DAILY;COUNT=5',
      ...(extra[0] ?? []),
      'END:VEVENT',
      ...(extra[1] ?? []),
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  const override = (recurrenceId: string) => [
    'BEGIN:VEVENT',
    'UID:g',
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:x',
    `RECURRENCE-ID;TZID=Europe/Berlin:${recurrenceId}`,
    'DTSTART:20270328T100000Z',
    'DTEND:20270328T110000Z',
    'END:VEVENT',
  ];
  const busyIn = (text: string) =>
    parseICalendarChanges(text, undefined, GAP_NIGHT)
      .filter((c) => !c.deleted && c.busy)
      .map((c) => [c.start?.toISOString(), c.end?.toISOString()]);

  it('a feed EXDATE and override in the gap name the same occurrence once stored', () => {
    const excluded = feed(['EXDATE;TZID=Europe/Berlin:20270328T023000']);
    const moved = feed([], override('20270328T023000'));
    for (const text of [excluded, moved]) {
      const [event] = parseTrustedICalendarEvents(text);
      expect(
        spans(expandCalendarEventOccurrences(event as CalendarEventContent, GAP_NIGHT)),
      ).toEqual(busyIn(text));
    }
  });

  it('a feed EXDATE that names no occurrence is not stored, and a move that names none is refused', () => {
    // RFC 5545 §3.8.5.1: an EXDATE that names no occurrence excludes nothing, so it is dropped
    // rather than stored, which the store refuses. A move whose RECURRENCE-ID names no occurrence
    // is busy in the feed at its own time, which a stored series cannot hold.
    const stray = feed(['EXDATE;TZID=Europe/Berlin:20270328T013000,20270401T023000']);
    const [event] = parseTrustedICalendarEvents(stray);
    expect(event?.recurrence).toEqual({ rrule: 'FREQ=DAILY;COUNT=5' });
    expect(spans(expandCalendarEventOccurrences(event as CalendarEventContent, GAP_NIGHT))).toEqual(
      busyIn(stray),
    );
    expect(() => parseTrustedICalendarEvents(feed([], override('20270328T013000')))).toThrow(
      CalendarContractError,
    );
  });
});

describe('what a stored rule may be (ENG-11)', () => {
  const base = {
    start: d('2027-01-04T09:00:00Z'),
    end: d('2027-01-04T10:00:00Z'),
    timezone: 'UTC',
    summary: 'x',
  };

  it.each([
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;COUNT=3X',
    'FREQ=WEEKLY;FREQ=DAILY;COUNT=2',
    'FREQ=DAILY;COUNT=2;BOGUS=1',
    'FREQ=HOURLY;COUNT=3',
    'FREQ=DAILY;COUNT=2;UNTIL=20270110T000000Z',
    'FREQ=WEEKLY;BYMONTHDAY=5;COUNT=2',
    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
  ])('refuses %s on the store and trusted paths', (rule) => {
    expect(() => normalizeCalendarEventContent({ ...base, recurrence: { rrule: rule } })).toThrow(
      CalendarContractError,
    );
    expect(() =>
      expandCalendarEventOccurrences(
        { ...base, recurrence: { rrule: rule } },
        w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z'),
      ),
    ).toThrow(CalendarContractError);
    expect(() =>
      parseTrustedICalendarEvents(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//t//EN',
          'BEGIN:VEVENT',
          'UID:r',
          'DTSTAMP:20260101T000000Z',
          'SUMMARY:x',
          'DTSTART:20270104T090000Z',
          'DTEND:20270104T100000Z',
          `RRULE:${rule}`,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      ),
    ).toThrow(CalendarContractError);
  });

  it('stores a rule in its canonical spelling', () => {
    expect(
      normalizeCalendarEventContent({
        ...base,
        recurrence: { rrule: ' freq=weekly;byday=mo,we;count=4 ' },
      }).recurrence?.rrule,
    ).toBe('FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE');
  });
});

describe('an event time zone (ENG-15)', () => {
  const event = (timezone: string) => ({
    start: d('2027-01-04T09:00:00Z'),
    end: d('2027-01-04T10:00:00Z'),
    timezone,
    summary: 'x',
  });

  it('is kept in its IANA spelling', () => {
    expect(normalizeCalendarEventContent(event('europe/london')).timezone).toBe('Europe/London');
  });

  it.each(['+05:00', '-0500', 'UTC+1'])('refuses %s, which is an offset, not a zone', (zone) => {
    expect(() => normalizeCalendarEventContent(event(zone))).toThrow(CalendarContractError);
  });
});
