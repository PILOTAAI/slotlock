// Recurrence edges a second review found after undefined zones were given to ical.js: floating
// UNTIL, hostile pre-pass input, daylight-saving gaps, cursors kept before the change, all-day
// EXDATEs in the trusted parser, exceptions named in other zones, RDATE instances, odd TZIDs.
import { describe, expect, it } from 'vitest';
import {
  expandCalendarEventOccurrences,
  expandCalendarEventSeries,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';

const cal = (...l: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//a//EN', ...l, 'END:VCALENDAR', ''].join('\r\n');
const ev = (uid: string, ...l: string[]) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20230101T000000Z',
  ...l,
  'END:VEVENT',
];
const w = (s: string, e: string) => ({ start: new Date(s), end: new Date(e) });
const starts = (cs: { start: Date | null }[]) => cs.map((c) => c.start?.toISOString());
const spans = (cs: { start: Date | null; end: Date | null }[]) =>
  cs.map((c) => [c.start?.toISOString(), c.end?.toISOString()]);
const timed = (f: () => unknown) => {
  const t = performance.now();
  try {
    f();
  } catch {}
  return Math.round(performance.now() - t);
};

describe('recurrence edges', () => {
  it('a floating series ends at its floating UNTIL, east and west of UTC', () => {
    const feed = (zone: string, until: string) =>
      cal(
        `X-WR-TIMEZONE:${zone}`,
        ...ev(
          'f',
          'DTSTART:20270104T090000',
          'DTEND:20270104T100000',
          `RRULE:FREQ=DAILY;UNTIL=${until}`,
        ),
      );
    const W = w('2027-01-01T00:00:00Z', '2027-01-20T00:00:00Z');
    // RFC 5545 3.3.10: floating DTSTART, floating UNTIL; both read in the calendar's zone.
    expect(
      starts(parseICalendarChanges(feed('America/New_York', '20270106T090000'), undefined, W)),
    ).toEqual(['2027-01-04T14:00:00.000Z', '2027-01-05T14:00:00.000Z', '2027-01-06T14:00:00.000Z']);
    expect(
      starts(parseICalendarChanges(feed('Asia/Tokyo', '20270106T010000'), undefined, W)),
    ).toEqual(['2027-01-04T00:00:00.000Z', '2027-01-05T00:00:00.000Z']);
  });

  it(
    'an all-day master with many EXDATEs is refused within the time budget',
    { timeout: 120_000 },
    () => {
      const values = Array.from(
        { length: 115_000 },
        (_, i) =>
          `${new Date(Date.UTC(2000, 0, 1) + i * 864e5).toISOString().slice(0, 10).replace(/-/g, '')}T000000`,
      );
      const feed = cal(
        'X-WR-TIMEZONE:Europe/Berlin',
        ...ev(
          'a',
          'DTSTART;VALUE=DATE:20270101',
          'DTEND;VALUE=DATE:20270102',
          'RRULE:FREQ=DAILY',
          `EXDATE;TZID=America/New_York:${values.join(',')}`,
        ),
      );
      expect(Buffer.byteLength(feed)).toBeLessThan(2_000_000);
      expect(
        timed(() =>
          parseICalendarChanges(feed, undefined, w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
        ),
      ).toBeLessThan(2_500);
    },
  );

  it(
    'many spellings of one IANA zone are refused within the time budget',
    { timeout: 120_000 },
    () => {
      const name = 'america/anchorage';
      const letters = [...name].flatMap((c, i) => (/[a-z]/.test(c) ? [i] : []));
      const spellings = Array.from({ length: 50_000 }, (_, n) =>
        [...name]
          .map((c, i) =>
            n & (1 << letters.indexOf(i)) && letters.includes(i) ? c.toUpperCase() : c,
          )
          .join(''),
      );
      const feed = cal(
        ...ev(
          'x',
          'DTSTART:20270101T090000Z',
          'DTEND:20270101T100000Z',
          ...spellings.map((z) => `DTEND;TZID=${z}:20270101`),
        ),
      );
      expect(Buffer.byteLength(feed)).toBeLessThan(2_000_000);
      expect(
        timed(() =>
          parseICalendarChanges(feed, undefined, w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
        ),
      ).toBeLessThan(2_500);
    },
  );

  it('an occurrence starting in a DST gap is reported, for its exact length', () => {
    // RFC 5545 3.3.5: 02:00 in the gap is read with the offset before it (01:00Z), and lasts the
    // series' exact length (3.8.5.3), 1h: on the wall clock it would end as it starts. Every
    // occurrence ends at the later of its exact end and its wall-clock end (SPEC.md, "Daylight-saving
    // time"): 01:00-04:00 the night the clocks go forward is three hours, as on any other night,
    // although the wall clock shows two.
    const W = w('2027-03-01T00:00:00Z', '2027-05-01T00:00:00Z');
    const gap = cal(
      ...ev(
        'g',
        'DTSTART;TZID=Europe/Berlin:20270321T020000',
        'DTEND;TZID=Europe/Berlin:20270321T030000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ),
    );
    const night = cal(
      ...ev(
        'n',
        'DTSTART;TZID=Europe/Berlin:20270321T010000',
        'DTEND;TZID=Europe/Berlin:20270321T040000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
      ),
    );
    expect([
      spans(parseICalendarChanges(gap, undefined, W)),
      spans(parseICalendarChanges(night, undefined, W)),
    ]).toEqual([
      [
        ['2027-03-21T01:00:00.000Z', '2027-03-21T02:00:00.000Z'],
        ['2027-03-28T01:00:00.000Z', '2027-03-28T02:00:00.000Z'],
        ['2027-04-04T00:00:00.000Z', '2027-04-04T01:00:00.000Z'],
      ],
      [
        ['2027-03-21T00:00:00.000Z', '2027-03-21T03:00:00.000Z'],
        ['2027-03-28T00:00:00.000Z', '2027-03-28T03:00:00.000Z'],
      ],
    ]);
  });

  it('a cursor 0.1 kept for a zoned series that ends is searched past from the start', () => {
    // What 0.1's expandCalendarEventSeries kept for this series and [2027-01-27, 2027-03-01], when it
    // read a zoned occurrence as UTC beside the UTC UNTIL: Berlin's had ended, New York's had not.
    const iterator = (last: number[], completed: boolean, n: number) => ({
      last: [...last, false],
      completed,
      occurrence_number: n,
      by_data: { BYSECOND: [0], BYMINUTE: [0], BYHOUR: [9], BYMONTHDAY: [4], BYDAY: ['MO'] },
      days: [],
      days_index: 0,
      by_indices: {
        BYSECOND: 0,
        BYMINUTE: 0,
        BYHOUR: 0,
        BYDAY: 0,
        BYMONTH: 0,
        BYWEEKNO: 0,
        BYMONTHDAY: 0,
      },
    });
    const old = (key: string, position: number, completed: boolean, n: number) => ({
      v: 1,
      ical: '2.2.1',
      key,
      position,
      last: [2027, 1, 25, 9, 0, 0, false],
      complete: false,
      iterator: iterator([2027, 2, 1, 9, 0, 0], completed, n),
    });
    const cases = [
      [
        {
          timezone: 'Europe/Berlin',
          start: '2027-01-04T08:00:00Z',
          until: '20270201T080000Z',
          // UNTIL names 1 February's 09:00 in Berlin: it is the last occurrence.
          expected: ['2027-02-01T08:00:00.000Z'],
        },
        old(
          '55c3c64437d7709ca212e3c7758c1c0c0668bdeb2d715af111223e5e967668a4',
          1800864000000,
          true,
          4,
        ),
      ],
      [
        {
          timezone: 'America/New_York',
          start: '2027-01-04T14:00:00Z',
          until: '20270201T100000Z',
          // 1 February's 09:00 in New York is 14:00Z, after UNTIL: 25 January was the last.
          expected: [] as string[],
        },
        old(
          'c5c111deb7ba256007c187860dc1ec68d72916686c4f4b496681556452ca38bb',
          1800885600000,
          false,
          5,
        ),
      ],
    ] as const;
    for (const [s, cursor] of cases) {
      const start = new Date(s.start);
      const series = {
        start,
        end: new Date(start.getTime() + 36e5),
        timezone: s.timezone,
        summary: 'Handover',
        recurrence: { rrule: `FREQ=WEEKLY;UNTIL=${s.until}` },
      };
      const W = w('2027-01-28T00:00:00Z', '2027-03-01T00:00:00Z');
      const fresh = expandCalendarEventSeries(series, W, { cursor: null, stored: true });
      const kept = expandCalendarEventSeries(series, W, { cursor, stored: true });
      // A cursor this version leaves for the series still serves the same window.
      const before = w('2027-01-27T00:00:00Z', '2027-03-01T00:00:00Z');
      const left = expandCalendarEventSeries(series, before, { cursor: null, stored: true }).cursor;
      const own = expandCalendarEventSeries(series, W, { cursor: left, stored: true });
      expect({
        zone: s.timezone,
        fresh: starts(fresh.occurrences),
        kept: { resumed: kept.resumed, at: starts(kept.occurrences) },
        own: { resumed: own.resumed, at: starts(own.occurrences) },
      }).toEqual({
        zone: s.timezone,
        fresh: s.expected,
        kept: { resumed: false, at: s.expected },
        own: { resumed: true, at: s.expected },
      });
    }
  });

  it('a stored all-day series occupies what the feed reports (UTC EXDATE)', () => {
    const feed = cal(
      ...ev(
        'a',
        'SUMMARY:Car out',
        'DTSTART;VALUE=DATE:20270104',
        'DTEND;VALUE=DATE:20270105',
        'RRULE:FREQ=DAILY;COUNT=4',
        'EXDATE:20270105T120000Z',
      ),
    );
    const W = w('2027-01-01T00:00:00Z', '2027-01-20T00:00:00Z');
    const [series] = parseTrustedICalendarEvents(feed, 'Europe/Berlin');
    // 4, 6 and 7 January in Berlin: noon UTC on 5 January falls on the 5th there.
    const days = [
      '2027-01-03T23:00:00.000Z',
      '2027-01-05T23:00:00.000Z',
      '2027-01-06T23:00:00.000Z',
    ];
    expect([
      starts(expandCalendarEventOccurrences(series as never, W)),
      starts(parseICalendarChanges(feed, 'Europe/Berlin', W)),
    ]).toEqual([days, days]);
  });

  it('every EXDATE excludes its occurrence, however many it passed first (RFC 5545 3.8.5.1)', () => {
    // Two EXDATEs at 10:00 name no occurrence of this 09:00 series; the third names 18 January's.
    // ical.js passed one EXDATE per occurrence, so the third was still waiting when the 18th came.
    const feed = cal(
      ...ev(
        'x',
        'SUMMARY:Standup',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T093000Z',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'EXDATE:20270104T100000Z,20270111T100000Z,20270118T090000Z',
      ),
    );
    const W = w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z');
    const [series] = parseTrustedICalendarEvents(feed, 'UTC');
    const weeks = [
      '2027-01-04T09:00:00.000Z',
      '2027-01-11T09:00:00.000Z',
      '2027-01-25T09:00:00.000Z',
    ];
    expect([
      starts(parseICalendarChanges(feed, undefined, W)),
      starts(expandCalendarEventOccurrences(series as never, W)),
    ]).toEqual([weeks, weeks]);
  });

  it('RANGE=THISANDFUTURE named in UTC shifts later occurrences by its own delta', () => {
    const feed = cal(
      ...ev(
        's',
        'DTSTART;TZID=Europe/Berlin:20270104T090000',
        'DTEND;TZID=Europe/Berlin:20270104T100000',
        'RRULE:FREQ=DAILY;COUNT=5',
      ),
      ...ev(
        's',
        'RECURRENCE-ID;RANGE=THISANDFUTURE:20270106T080000Z',
        'DTSTART;TZID=Europe/Berlin:20270106T100000',
        'DTEND;TZID=Europe/Berlin:20270106T110000',
      ),
    );
    // 09:00 -> 10:00 Berlin from 6 January on: 09:00Z.
    expect(
      starts(
        parseICalendarChanges(feed, undefined, w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
      ),
    ).toEqual([
      '2027-01-04T08:00:00.000Z',
      '2027-01-05T08:00:00.000Z',
      '2027-01-06T09:00:00.000Z',
      '2027-01-07T09:00:00.000Z',
      '2027-01-08T09:00:00.000Z',
    ]);
  });

  it('a TZID with surrounding space is still read (as it always was)', () => {
    const feed = cal(
      ...ev(
        't',
        'DTSTART;TZID=" Europe/Berlin":20270321T090000',
        'DTEND;TZID=" Europe/Berlin":20270321T100000',
      ),
    );
    expect(starts(parseICalendarChanges(feed))).toEqual(['2027-03-21T08:00:00.000Z']);
  });

  it('the trusted parser refuses an event with no length as invalid_icalendar', () => {
    let code = 'parsed';
    try {
      parseTrustedICalendarEvents(cal(...ev('t', 'SUMMARY:x', 'DTSTART:20270104T090000Z')), 'UTC');
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('invalid_icalendar');
  });

  it('a RECURRENCE-ID in another zone than DTSTART moves the occurrence it names', () => {
    const feed = cal(
      ...ev(
        's',
        'DTSTART;TZID=Europe/Berlin:20270104T090000',
        'DTEND;TZID=Europe/Berlin:20270104T100000',
        'RRULE:FREQ=DAILY;COUNT=3',
      ),
      ...ev(
        's',
        'RECURRENCE-ID;TZID=America/New_York:20270105T030000',
        'DTSTART;TZID=Europe/Berlin:20270105T150000',
        'DTEND;TZID=Europe/Berlin:20270105T160000',
      ),
    );
    expect(
      starts(
        parseICalendarChanges(feed, undefined, w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
      ),
    ).toEqual(['2027-01-04T08:00:00.000Z', '2027-01-05T14:00:00.000Z', '2027-01-06T08:00:00.000Z']);
  });

  it('RDATE: DTSTART is the first instance, and a duplicate counts once (RFC 5545 3.8.5.3)', () => {
    const W = w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z');
    const only = cal(
      ...ev('r', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', 'RDATE:20270106T090000Z'),
    );
    const dup = cal(
      ...ev(
        'd',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'RDATE:20270105T090000Z',
      ),
    );
    // An EXDATE excludes an instant however many name it.
    const excluded = cal(
      ...ev(
        'e',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'RDATE:20270105T090000Z',
        'EXDATE:20270105T090000Z',
      ),
    );
    expect([
      starts(parseICalendarChanges(only, undefined, W)),
      parseICalendarChanges(dup, undefined, W).length,
      starts(parseICalendarChanges(excluded, undefined, W)),
    ]).toEqual([
      ['2027-01-04T09:00:00.000Z', '2027-01-06T09:00:00.000Z'],
      3,
      ['2027-01-04T09:00:00.000Z', '2027-01-06T09:00:00.000Z'],
    ]);
  });

  it('a CalDAV-expanded series keeps every instance, its first without a RECURRENCE-ID', () => {
    // RFC 4791 §9.6.5: every instance but the first must carry a RECURRENCE-ID, and none carries
    // RRULE. Each later instance was read as an exception of a one-off, and dropped.
    const W = w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z');
    const expanded = cal(
      ...ev('x', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z'),
      ...ev(
        'x',
        'RECURRENCE-ID:20270105T090000Z',
        'DTSTART:20270105T090000Z',
        'DTEND:20270105T100000Z',
      ),
      ...ev(
        'x',
        'RECURRENCE-ID:20270106T090000Z',
        'DTSTART:20270106T140000Z',
        'DTEND:20270106T150000Z',
      ),
    );
    expect(spans(parseICalendarChanges(expanded, undefined, W))).toEqual([
      ['2027-01-04T09:00:00.000Z', '2027-01-04T10:00:00.000Z'],
      ['2027-01-05T09:00:00.000Z', '2027-01-05T10:00:00.000Z'],
      ['2027-01-06T14:00:00.000Z', '2027-01-06T15:00:00.000Z'],
    ]);
  });
});

// A third review: a feed's own VTIMEZONE for an IANA name, the cap on zones, a DATE EXDATE on a
// timed series, a DURATION in a gap, and two RRULEs.
describe('recurrence edges, third review', () => {
  const stored = (feed: string, window: { start: Date; end: Date }, timezone?: string) => {
    const [series] = parseTrustedICalendarEvents(feed, timezone);
    return spans(expandCalendarEventOccurrences(series as never, window));
  };

  it('reads an IANA zone the feed defines as Intl does, everywhere ical.js compares it', () => {
    // A stale definition: standard time only, so it reads July's 09:00 as 14:00Z, not 13:00Z.
    const staleNewYork = [
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
    ];
    const feed = (recurrenceId: string) =>
      cal(
        ...staleNewYork,
        ...ev(
          's',
          'SUMMARY:Standup',
          'DTSTART;TZID=America/New_York:20270705T090000',
          'DTEND;TZID=America/New_York:20270705T100000',
          'RRULE:FREQ=WEEKLY;COUNT=3',
        ),
        ...ev(
          's',
          recurrenceId,
          'DTSTART;TZID=America/New_York:20270712T150000',
          'DTEND;TZID=America/New_York:20270712T160000',
        ),
      );
    const W = w('2027-07-01T00:00:00Z', '2027-07-31T00:00:00Z');
    const moved = [
      ['2027-07-05T13:00:00.000Z', '2027-07-05T14:00:00.000Z'],
      ['2027-07-12T19:00:00.000Z', '2027-07-12T20:00:00.000Z'],
      ['2027-07-19T13:00:00.000Z', '2027-07-19T14:00:00.000Z'],
    ];
    // Named in the series' zone, and in UTC at the instant Intl gives it.
    for (const recurrenceId of [
      'RECURRENCE-ID;TZID=America/New_York:20270712T090000',
      'RECURRENCE-ID:20270712T130000Z',
    ]) {
      expect({
        recurrenceId,
        feed: spans(parseICalendarChanges(feed(recurrenceId), undefined, W)),
        stored: stored(feed(recurrenceId), W),
      }).toEqual({ recurrenceId, feed: moved, stored: moved });
    }
  });

  it('counts only zones a feed names without defining against the cap', () => {
    const zones = Array.from({ length: 100 }, (_, i) => [
      'BEGIN:VTIMEZONE',
      `TZID:Custom/Z${i}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0000',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]).flat();
    const events = Array.from({ length: 100 }, (_, i) =>
      ev(
        `z${i}`,
        `DTSTART;TZID=Custom/Z${i}:20270104T090000`,
        `DTEND;TZID=Custom/Z${i}:20270104T100000`,
      ),
    ).flat();
    const feed = cal(
      ...zones,
      ...events,
      ...ev(
        'ny',
        'DTSTART;TZID=America/New_York:20270104T090000',
        'DTEND;TZID=America/New_York:20270104T100000',
      ),
    );
    expect(parseICalendarChanges(feed)).toHaveLength(101);
  });

  it('a DATE EXDATE on a timed series excludes that day, stored or read from the feed', () => {
    const feed = cal(
      ...ev(
        'd',
        'SUMMARY:Car out',
        'DTSTART;TZID=Europe/Berlin:20270104T090000',
        'DTEND;TZID=Europe/Berlin:20270104T100000',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE;VALUE=DATE:20270105',
      ),
    );
    const W = w('2027-01-01T00:00:00Z', '2027-01-10T00:00:00Z');
    const days = [
      ['2027-01-04T08:00:00.000Z', '2027-01-04T09:00:00.000Z'],
      ['2027-01-06T08:00:00.000Z', '2027-01-06T09:00:00.000Z'],
    ];
    expect({
      feed: spans(parseICalendarChanges(feed, undefined, W)),
      stored: stored(feed, W),
    }).toEqual({ feed: days, stored: days });
  });

  it('an occurrence of a DURATION series starting in a DST gap lasts its exact length', () => {
    const feed = cal(
      ...ev(
        'g',
        'SUMMARY:Night run',
        'DTSTART;TZID=Europe/Berlin:20270327T020000',
        'DURATION:PT1H',
        'RRULE:FREQ=DAILY;COUNT=3',
      ),
    );
    const W = w('2027-03-26T00:00:00Z', '2027-04-02T00:00:00Z');
    const nights = [
      ['2027-03-27T01:00:00.000Z', '2027-03-27T02:00:00.000Z'],
      ['2027-03-28T01:00:00.000Z', '2027-03-28T02:00:00.000Z'],
      ['2027-03-29T00:00:00.000Z', '2027-03-29T01:00:00.000Z'],
    ];
    expect({
      feed: spans(parseICalendarChanges(feed, undefined, W)),
      stored: stored(feed, W),
    }).toEqual({ feed: nights, stored: nights });
  });

  it('expands every RRULE of a series, after one of them ends (RFC 5545 3.8.5.3)', () => {
    // ical.js skipped the rule after one that had finished, so 11 January was never reached.
    const feed = cal(
      ...ev(
        'm',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T100000Z',
        'RRULE:FREQ=DAILY;COUNT=2',
        'RRULE:FREQ=WEEKLY;COUNT=2',
      ),
    );
    expect(
      starts(
        parseICalendarChanges(feed, undefined, w('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
      ),
    ).toEqual(['2027-01-04T09:00:00.000Z', '2027-01-05T09:00:00.000Z', '2027-01-11T09:00:00.000Z']);
  });
});
