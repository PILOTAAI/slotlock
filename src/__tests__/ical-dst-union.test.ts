// What a timed recurring event occupies across daylight-saving changes (SPEC.md, "Daylight-saving
// time"): each occurrence starts at its wall time read per RFC 5545 §3.3.5, and ends at the later of
// its exact end (§3.8.5.3: DTEND − DTSTART as instants; §3.3.6: DURATION hours exact, days nominal)
// and its wall-clock end (DTEND's wall time carried to the occurrence's date, the later instant of
// a repeated hour). The first instance starts at DTSTART. A one-off, an override or a PERIOD RDATE
// occupies exactly what it says. The feed and the store give the same answer.
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  expandCalendarEventOccurrences,
  parseICalendarChanges,
  parseICalendarFeed,
  parseTrustedICalendarEvents,
} from '../sync.js';
import type { CalendarEventContent } from '../types.js';
import { occupation } from './helpers/dst-oracle.js';

const cal = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const ev = (uid: string, ...lines: string[]) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20260101T000000Z',
  'SUMMARY:dst',
  ...lines,
  'END:VEVENT',
];
const w = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const iso = (ms: number | Date) => new Date(ms).toISOString();
type Spans = [string, string][];
const feedSpans = (text: string, window: { start: Date; end: Date }): Spans =>
  parseICalendarChanges(text, undefined, window)
    .filter((c) => !c.deleted && c.busy && c.start && c.end)
    .map((c): [string, string] => [iso(c.start as Date), iso(c.end as Date)])
    .sort((a, b) => a[0].localeCompare(b[0]));
const storeSpans = (content: CalendarEventContent, window: { start: Date; end: Date }): Spans =>
  expandCalendarEventOccurrences(content, window).map((o): [string, string] => [
    iso(o.start),
    iso(o.end),
  ]);
const series = (zone: string, start: string, end: string, rule: string, ...extra: string[]) =>
  cal(
    ...ev(
      's',
      `DTSTART;TZID=${zone}:${start}`,
      `DTEND;TZID=${zone}:${end}`,
      `RRULE:${rule}`,
      ...extra,
    ),
  );
const oracle = (
  zone: string,
  start: string,
  end: string,
  everyDays: number,
  count: number,
): Spans =>
  occupation({ zone, start, end, everyDays, count }).map(([a, b]): [string, string] => [
    iso(a),
    iso(b),
  ]);
const WIDE = w('2026-09-01T00:00:00Z', '2027-08-31T00:00:00Z');
/** A month from two days before a DTSTART written `yyyymmddThhmmss`. */
const around = (start: string) => {
  const at = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8)));
  return { start: new Date(at - 2 * 86_400_000), end: new Date(at + 30 * 86_400_000) };
};

describe('a series whose first instance spans a clock change (ENG-1)', () => {
  it.each([
    ['Europe/Berlin', '20270328T010000', '20270328T040000', 7, '2027-03-28T00:00:00.000Z'],
    ['Europe/London', '20270328T000000', '20270328T030000', 1, '2027-03-28T00:00:00.000Z'],
    ['America/New_York', '20270314T010000', '20270314T040000', 1, '2027-03-14T06:00:00.000Z'],
    ['Australia/Sydney', '20271003T010000', '20271003T040000', 1, '2027-10-02T15:00:00.000Z'],
  ])(
    '%s %s-%s: the first instance is DTSTART to DTEND as written',
    (zone, start, end, every, at) => {
      const rule = every === 7 ? 'FREQ=WEEKLY;COUNT=3' : 'FREQ=DAILY;COUNT=3';
      const window = w('2027-03-01T00:00:00Z', '2027-10-31T00:00:00Z');
      const fromFeed = feedSpans(series(zone, start, end, rule), window);
      // Written: two exact hours over the skipped one.
      expect(fromFeed[0]).toEqual([at, iso(Date.parse(at) + 2 * 3_600_000)]);
      expect(fromFeed).toEqual(oracle(zone, start, end, every, 3));
      const [first] = fromFeed;
      const stored = storeSpans(
        {
          start: new Date((first as [string, string])[0]),
          end: new Date((first as [string, string])[1]),
          timezone: zone,
          summary: 'x',
          recurrence: { rrule: rule },
        },
        window,
      );
      expect(stored).toEqual(fromFeed);
    },
  );

  it('later instances keep the wall clock where it is longer: 01:00-04:00 local is three hours', () => {
    expect(
      feedSpans(
        series('Europe/Berlin', '20270328T010000', '20270328T040000', 'FREQ=WEEKLY;COUNT=3'),
        WIDE,
      ),
    ).toEqual([
      ['2027-03-28T00:00:00.000Z', '2027-03-28T02:00:00.000Z'],
      ['2027-04-03T23:00:00.000Z', '2027-04-04T02:00:00.000Z'],
      ['2027-04-10T23:00:00.000Z', '2027-04-11T02:00:00.000Z'],
    ]);
  });

  it.each([
    ['Europe/London', '20261025T000000', '20261025T030000', '2026-10-24T23:00:00.000Z', 4],
    ['Europe/Berlin', '20271031T010000', '20271031T040000', '2027-10-30T23:00:00.000Z', 4],
  ])('%s %s-%s in autumn: the first instance is as written', (zone, start, end, at, hours) => {
    const got = feedSpans(series(zone, start, end, 'FREQ=DAILY;COUNT=3'), around(start));
    expect(got[0]).toEqual([at, iso(Date.parse(at) + hours * 3_600_000)]);
    expect(got).toEqual(oracle(zone, start, end, 1, 3));
  });
});

describe('an occurrence that starts in the skipped hour (ENG-5)', () => {
  it.each([60, 75, 90, 120])('a %i-minute occurrence lasts its exact length', (minutes) => {
    const end = new Date(Date.UTC(2027, 2, 26, 1, 30) + minutes * 60_000);
    const wall = String(Math.floor((150 + minutes) / 60)).padStart(2, '0');
    const wallMinutes = String((150 + minutes) % 60).padStart(2, '0');
    const gapNight = w('2027-03-28T00:00:00Z', '2027-03-29T00:00:00Z');
    const expected = [
      ['2027-03-28T01:30:00.000Z', iso(Date.UTC(2027, 2, 28, 1, 30) + minutes * 60_000)],
    ];
    expect(
      feedSpans(
        series(
          'Europe/Berlin',
          '20270326T023000',
          `20270326T${wall}${wallMinutes}00`,
          'FREQ=DAILY;COUNT=5',
        ),
        gapNight,
      ),
    ).toEqual(expected);
    expect(
      storeSpans(
        {
          start: new Date('2027-03-26T01:30:00Z'),
          end,
          timezone: 'Europe/Berlin',
          summary: 'x',
          recurrence: { rrule: 'FREQ=DAILY;COUNT=5' },
        },
        gapNight,
      ),
    ).toEqual(expected);
  });

  it('Lord Howe skips half an hour: a 45-minute occurrence lasts 45 minutes', () => {
    expect(
      feedSpans(
        series('Australia/Lord_Howe', '20271001T020000', '20271001T024500', 'FREQ=DAILY;COUNT=5'),
        w('2027-10-02T12:00:00Z', '2027-10-03T12:00:00Z'),
      ),
    ).toEqual([['2027-10-02T15:30:00.000Z', '2027-10-02T16:15:00.000Z']]);
  });
});

describe('an ordinary occurrence spanning the change (ENG-18): the union of both readings', () => {
  it.each([
    // Exact six hours win in spring; the wall clock's seven win in autumn.
    [
      'Europe/London',
      '20270327T000000',
      '20270327T060000',
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T06:00:00.000Z',
    ],
    [
      'America/New_York',
      '20270313T000000',
      '20270313T060000',
      '2027-03-14T05:00:00.000Z',
      '2027-03-14T11:00:00.000Z',
    ],
    [
      'Europe/London',
      '20261024T000000',
      '20261024T060000',
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
    ],
    // Southern hemisphere: Santiago repeats 23:00 on 2027-04-03 (seven wall-clock hours); Auckland
    // skips 02:00 on 2027-09-26 (six exact hours).
    [
      'America/Santiago',
      '20270402T220000',
      '20270403T040000',
      '2027-04-04T01:00:00.000Z',
      '2027-04-04T08:00:00.000Z',
    ],
    [
      'Pacific/Auckland',
      '20270925T000000',
      '20270925T060000',
      '2027-09-25T12:00:00.000Z',
      '2027-09-25T18:00:00.000Z',
    ],
  ])('%s from %s', (zone, start, end, second, secondEnd) => {
    const got = feedSpans(series(zone, start, end, 'FREQ=DAILY;COUNT=2'), around(start));
    expect(got).toEqual(oracle(zone, start, end, 1, 2));
    expect(got[1]).toEqual([second, secondEnd]);
  });
});

describe('hours are exact, days nominal (ENG-6)', () => {
  const oneOff = (duration: string) =>
    feedSpans(
      cal(...ev('d', 'DTSTART;TZID=Europe/Berlin:20270327T120000', `DURATION:${duration}`)),
      WIDE,
    );

  it.each([
    ['PT48H', '2027-03-29T11:00:00.000Z'],
    ['PT24H', '2027-03-28T11:00:00.000Z'],
    ['P1D', '2027-03-28T10:00:00.000Z'],
    ['P2D', '2027-03-29T10:00:00.000Z'],
    ['P1DT1H', '2027-03-28T11:00:00.000Z'],
  ])('a one-off of %s ends at %s', (duration, end) => {
    expect(oneOff(duration)).toEqual([['2027-03-27T11:00:00.000Z', end]]);
  });

  it('a PT3H series runs three hours on the spring night', () => {
    expect(
      feedSpans(
        cal(
          ...ev(
            'r',
            'DTSTART;TZID=Europe/Berlin:20270327T010000',
            'DURATION:PT3H',
            'RRULE:FREQ=DAILY;COUNT=3',
          ),
        ),
        WIDE,
      ),
    ).toEqual([
      ['2027-03-27T00:00:00.000Z', '2027-03-27T03:00:00.000Z'],
      ['2027-03-28T00:00:00.000Z', '2027-03-28T03:00:00.000Z'],
      // 01:00 CEST to 04:00 CEST.
      ['2027-03-28T23:00:00.000Z', '2027-03-29T02:00:00.000Z'],
    ]);
  });

  it('a PERIOD RDATE and an override of PT48H last 48 hours', () => {
    const period = cal(
      ...ev(
        'p',
        'DTSTART;TZID=Europe/Berlin:20270320T120000',
        'DTEND;TZID=Europe/Berlin:20270320T130000',
        'RDATE;TZID=Europe/Berlin;VALUE=PERIOD:20270327T120000/PT48H',
      ),
    );
    expect(feedSpans(period, WIDE)).toEqual([
      ['2027-03-20T11:00:00.000Z', '2027-03-20T12:00:00.000Z'],
      ['2027-03-27T11:00:00.000Z', '2027-03-29T11:00:00.000Z'],
    ]);
    const override = cal(
      ...ev(
        'o',
        'DTSTART;TZID=Europe/Berlin:20270320T120000',
        'DTEND;TZID=Europe/Berlin:20270320T130000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
      ),
      ...ev(
        'o',
        'RECURRENCE-ID;TZID=Europe/Berlin:20270327T120000',
        'DTSTART;TZID=Europe/Berlin:20270327T120000',
        'DURATION:PT48H',
      ),
    );
    expect(feedSpans(override, WIDE)).toEqual([
      ['2027-03-20T11:00:00.000Z', '2027-03-20T12:00:00.000Z'],
      ['2027-03-27T11:00:00.000Z', '2027-03-29T11:00:00.000Z'],
    ]);
  });

  it('the trusted parser stores a PT48H one-off as 48 hours', () => {
    const [event] = parseTrustedICalendarEvents(
      cal(...ev('d', 'DTSTART;TZID=Europe/Berlin:20270327T120000', 'DURATION:PT48H')),
    );
    expect([iso(event?.start as Date), iso(event?.end as Date)]).toEqual([
      '2027-03-27T11:00:00.000Z',
      '2027-03-29T11:00:00.000Z',
    ]);
  });
});

describe('a DTEND written in the hour the clocks skip (ENG-18)', () => {
  // New York, daily 01:00-02:30 from 14 March 2027, the night 02:00 becomes 03:00: the first
  // instance ends at 03:30 EDT (RFC 5545 §3.3.5 moves 02:30 forward by the gap), 1.5 exact hours.
  // Later days end at the written 02:30 on the wall clock, also 1.5 hours: carrying the moved 03:30
  // instead held an extra hour every day for the life of the series.
  const text = series(
    'America/New_York',
    '20270314T010000',
    '20270314T023000',
    'FREQ=DAILY;COUNT=3',
  );
  const window = w('2027-03-13T00:00:00Z', '2027-03-20T00:00:00Z');

  it('the feed carries the written end to later days', () => {
    expect(feedSpans(text, window)).toEqual([
      ['2027-03-14T06:00:00.000Z', '2027-03-14T07:30:00.000Z'],
      ['2027-03-15T05:00:00.000Z', '2027-03-15T06:30:00.000Z'],
      ['2027-03-16T05:00:00.000Z', '2027-03-16T06:30:00.000Z'],
    ]);
    expect(feedSpans(text, window)).toEqual(
      oracle('America/New_York', '20270314T010000', '20270314T023000', 1, 3),
    );
  });

  it('the trusted parser refuses it: a stored series reads its end from the instant', () => {
    // Stored as 06:00Z-07:30Z, the series' end reads 03:30 on the wall clock, and every later day
    // would hold an hour more than the feed reports.
    expect(() => parseTrustedICalendarEvents(text)).toThrow(CalendarContractError);
    // The same series written with an end the clocks do not skip is stored as the feed reads it.
    const later = series(
      'America/New_York',
      '20270314T010000',
      '20270314T033000',
      'FREQ=DAILY;COUNT=3',
    );
    const [event] = parseTrustedICalendarEvents(later);
    expect(storeSpans(event as CalendarEventContent, window)).toEqual(feedSpans(later, window));
  });
});

describe('a series whose DURATION counts days (ENG-6)', () => {
  // London, weekly from Saturday 20 March 2027 at 23:00, P1DT2H: a day on the calendar, then two
  // exact hours. The occurrence of 27 March spans the spring change, so its day is 23 hours.
  const weekly = (zone: string, duration: string) =>
    cal(
      ...ev(
        'd',
        `DTSTART;TZID=${zone}:20270320T230000`,
        `DURATION:${duration}`,
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ),
    );
  const window = w('2027-03-19T00:00:00Z', '2027-04-10T00:00:00Z');

  it('the feed counts the day on the calendar and the hours exactly', () => {
    expect(feedSpans(weekly('Europe/London', 'P1DT2H'), window)).toEqual([
      ['2027-03-20T23:00:00.000Z', '2027-03-22T01:00:00.000Z'],
      ['2027-03-27T23:00:00.000Z', '2027-03-29T00:00:00.000Z'],
      ['2027-04-03T22:00:00.000Z', '2027-04-05T00:00:00.000Z'],
    ]);
  });

  it.each(['P1DT2H', 'P1D', 'P1W'])(
    'the trusted parser refuses %s in a zone with clock changes: the store has only instants',
    (duration) => {
      // Stored as the first instance's instants, every later one would last 26 exact hours: one
      // hour more than the feed reports across the change.
      expect(() => parseTrustedICalendarEvents(weekly('Europe/London', duration))).toThrow(
        CalendarContractError,
      );
    },
  );

  it('the trusted parser stores days in UTC, and hours anywhere, as the feed reads them', () => {
    for (const text of [weekly('UTC', 'P1DT2H'), weekly('Europe/London', 'PT26H')]) {
      const [event] = parseTrustedICalendarEvents(text);
      expect(storeSpans(event as CalendarEventContent, window)).toEqual(feedSpans(text, window));
    }
  });
});

describe('a DTSTART inside the gap or the fold (ENG-14)', () => {
  const night = w('2027-03-27T00:00:00Z', '2027-04-01T00:00:00Z');

  it('a series whose exact length the gap reduces to nothing is refused by both parsers', () => {
    const text = series(
      'Europe/Berlin',
      '20270328T023000',
      '20270328T033000',
      'FREQ=DAILY;COUNT=3',
    );
    expect(() => parseICalendarChanges(text, undefined, night)).toThrow(CalendarContractError);
    expect(parseICalendarFeed(text, undefined, night).refused).toEqual([
      { uid: 's', code: 'invalid_icalendar' },
    ]);
    expect(() => parseTrustedICalendarEvents(text)).toThrow(CalendarContractError);
  });

  it('a series starting in the gap: the feed reads it, the trusted parser refuses to store it', () => {
    const text = series(
      'Europe/Berlin',
      '20270328T023000',
      '20270328T043000',
      'FREQ=DAILY;COUNT=3',
    );
    expect(feedSpans(text, night)).toEqual([
      ['2027-03-28T01:30:00.000Z', '2027-03-28T02:30:00.000Z'],
      ['2027-03-29T00:30:00.000Z', '2027-03-29T02:30:00.000Z'],
      ['2027-03-30T00:30:00.000Z', '2027-03-30T02:30:00.000Z'],
    ]);
    // Its series runs at 02:30 local, a time no instant on its first day reads as: a stored series
    // (an instant and a zone) would move every occurrence to 03:30.
    expect(() => parseTrustedICalendarEvents(text)).toThrow(CalendarContractError);
  });

  it.each([
    // Santiago and Havana move their clocks forward at midnight: 00:00 becomes 01:00.
    ['America/Santiago', '20270905', '20270906', '2027-09-06T03:00:00.000Z'],
    ['America/Havana', '20270314', '20270315', '2027-03-15T04:00:00.000Z'],
  ])(
    'an all-day series whose first midnight %s skips: read, not stored an hour late',
    (zone, from, to, secondDay) => {
      const text = cal(
        ...ev(
          'a',
          `DTSTART;VALUE=DATE:${from}`,
          `DTEND;VALUE=DATE:${to}`,
          'RRULE:FREQ=DAILY;COUNT=3',
        ),
      );
      const window = w('2027-01-01T00:00:00Z', '2027-12-01T00:00:00Z');
      // Its later days start at midnight.
      expect(
        parseICalendarChanges(text, zone, window).map((change) => iso(change.start as Date))[1],
      ).toBe(secondDay);
      // Stored as an instant and a zone, it would recur at that instant's wall time, 01:00: every
      // later day's first hour would be free.
      expect(() => parseTrustedICalendarEvents(text, zone)).toThrow(CalendarContractError);
    },
  );

  it('a series starting in the fold: its first instance is the two hours written', () => {
    expect(
      feedSpans(
        series('Europe/Berlin', '20271031T023000', '20271031T033000', 'FREQ=DAILY;COUNT=2'),
        w('2027-10-30T00:00:00Z', '2027-11-03T00:00:00Z'),
      ),
    ).toEqual([
      ['2027-10-31T00:30:00.000Z', '2027-10-31T02:30:00.000Z'],
      ['2027-11-01T01:30:00.000Z', '2027-11-01T03:30:00.000Z'],
    ]);
  });
});

describe('a series in a zone whose offsets changed in the past', () => {
  it.each([
    // Moscow went from +04 all year to +03 all year on 2014-10-26 at 02:00 (an hour repeated).
    ['Europe/Moscow', '20141024T230000', '20141025T030000'],
    // Sao Paulo's last spring change, 2018-11-04 at 00:00 (an hour skipped); it has none since.
    ['America/Sao_Paulo', '20181102T220000', '20181103T020000'],
    // Lord Howe's half-hour change, in autumn.
    ['Australia/Lord_Howe', '20270402T013000', '20270402T023000'],
  ])('%s %s-%s matches the rule', (zone, start, end) => {
    const year = Number(start.slice(0, 4));
    const got = feedSpans(
      series(zone, start, end, 'FREQ=DAILY;COUNT=5'),
      w(`${year}-01-01T00:00:00Z`, `${year + 1}-01-01T00:00:00Z`),
    );
    expect(got).toEqual(oracle(zone, start, end, 1, 5));
  });
});

describe('DTSTART is always the first instance (RFC 5545 §3.8.5.3)', () => {
  it('even when the rule would not produce it', () => {
    // A Wednesday start, weekly on Mondays: the written Wednesday is occupied too.
    expect(
      feedSpans(
        cal(
          ...ev(
            'w',
            'DTSTART:20270106T090000Z',
            'DTEND:20270106T100000Z',
            'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2',
          ),
        ),
        WIDE,
      ),
    ).toEqual([
      ['2027-01-06T09:00:00.000Z', '2027-01-06T10:00:00.000Z'],
      ['2027-01-11T09:00:00.000Z', '2027-01-11T10:00:00.000Z'],
      ['2027-01-18T09:00:00.000Z', '2027-01-18T10:00:00.000Z'],
    ]);
  });
});

describe("a series' occurrences never overlap each other (ENG-18)", () => {
  /** Each pair of consecutive spans that overlap. */
  const overlaps = (spans: Spans) =>
    spans.slice(1).flatMap((span, i) => {
      const before = spans[i] as [string, string];
      return before[1] > span[0] ? [`${before.join('..')} overlaps ${span.join('..')}`] : [];
    });
  /** The minutes a set of spans covers, as one list of disjoint spans. */
  const merged = (spans: Spans): Spans => {
    const out: Spans = [];
    for (const [from, to] of [...spans].sort((a, b) => a[0].localeCompare(b[0]))) {
      const last = out.at(-1);
      if (last && from <= last[1]) last[1] = to > last[1] ? to : last[1];
      else out.push([from, to]);
    }
    return out;
  };
  const london24 = [
    ['2027-03-26T00:00:00.000Z', '2027-03-27T00:00:00.000Z'],
    ['2027-03-27T00:00:00.000Z', '2027-03-28T00:00:00.000Z'],
    // The exact 24 hours run to 01:00 BST; the next occurrence starts at midnight BST.
    ['2027-03-28T00:00:00.000Z', '2027-03-28T23:00:00.000Z'],
    ['2027-03-28T23:00:00.000Z', '2027-03-29T23:00:00.000Z'],
    ['2027-03-29T23:00:00.000Z', '2027-03-30T23:00:00.000Z'],
  ];

  it('a daily 24-hour series across the spring change: each ends where the next starts', () => {
    const window = w('2027-03-20T00:00:00Z', '2027-04-10T00:00:00Z');
    const fromFeed = feedSpans(
      series('Europe/London', '20270326T000000', '20270327T000000', 'FREQ=DAILY;COUNT=5'),
      window,
    );
    expect(fromFeed).toEqual(london24);
    const stored = storeSpans(
      {
        start: new Date('2027-03-26T00:00:00Z'),
        end: new Date('2027-03-27T00:00:00Z'),
        timezone: 'Europe/London',
        summary: 'away',
        recurrence: { rrule: 'FREQ=DAILY;COUNT=5' },
      },
      window,
    );
    expect(stored).toEqual(london24);
    // No minute the union rule holds is lost: the series runs without a break to its last end.
    expect(merged(stored)).toEqual([['2027-03-26T00:00:00.000Z', '2027-03-30T23:00:00.000Z']]);
  });

  it('a weekly seven-day series across the spring change in New York', () => {
    const window = w('2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z');
    const content: CalendarEventContent = {
      start: new Date('2027-03-07T05:00:00Z'),
      end: new Date('2027-03-14T05:00:00Z'),
      timezone: 'America/New_York',
      summary: 'lease',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=3' },
    };
    const expected = [
      ['2027-03-07T05:00:00.000Z', '2027-03-14T05:00:00.000Z'],
      // 168 exact hours from midnight EST end at 01:00 EDT; the next week starts at midnight EDT.
      ['2027-03-14T05:00:00.000Z', '2027-03-21T04:00:00.000Z'],
      ['2027-03-21T04:00:00.000Z', '2027-03-28T04:00:00.000Z'],
    ];
    expect(storeSpans(content, window)).toEqual(expected);
    expect(
      feedSpans(
        series('America/New_York', '20270307T000000', '20270314T000000', 'FREQ=WEEKLY;COUNT=3'),
        window,
      ),
    ).toEqual(expected);
  });

  it.each([
    // The day the clocks go forward is 23 hours long, at local midnight or (Santiago, which skips
    // midnight) from 01:00.
    ['Europe/London', '20270326', '2027-03-28T00:00:00.000Z', '2027-03-28T23:00:00.000Z'],
    ['America/Santiago', '20270903', '2027-09-05T04:00:00.000Z', '2027-09-06T03:00:00.000Z'],
    ['America/New_York', '20270312', '2027-03-14T05:00:00.000Z', '2027-03-15T04:00:00.000Z'],
  ])('a daily all-day series in %s is stored as the feed reads it', (zone, from, day, dayEnd) => {
    const next = new Date(Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6) + 1));
    const to = next.toISOString().slice(0, 10).replace(/-/g, '');
    const text = cal(
      `X-WR-TIMEZONE:${zone}`,
      ...ev(
        'a',
        `DTSTART;VALUE=DATE:${from}`,
        `DTEND;VALUE=DATE:${to}`,
        'RRULE:FREQ=DAILY;COUNT=5',
      ),
    );
    const window = w('2027-03-01T00:00:00Z', '2027-10-01T00:00:00Z');
    const fromFeed = feedSpans(text, window);
    expect(fromFeed).toContainEqual([day, dayEnd]);
    expect(overlaps(fromFeed)).toEqual([]);
    const [event] = parseTrustedICalendarEvents(text, zone);
    const stored = storeSpans(event as CalendarEventContent, window);
    expect(overlaps(stored)).toEqual([]);
    expect(stored).toEqual(fromFeed);
  });

  it('a cancelled next occurrence leaves the one before it its whole union', () => {
    const content: CalendarEventContent = {
      start: new Date('2027-03-26T00:00:00Z'),
      end: new Date('2027-03-27T00:00:00Z'),
      timezone: 'Europe/London',
      summary: 'away',
      recurrence: {
        rrule: 'FREQ=DAILY;COUNT=5',
        exceptions: [{ recurrenceId: new Date('2027-03-28T23:00:00Z'), cancelled: true }],
      },
    };
    expect(storeSpans(content, w('2027-03-27T12:00:00Z', '2027-03-31T00:00:00Z'))).toEqual([
      ['2027-03-27T00:00:00.000Z', '2027-03-28T00:00:00.000Z'],
      ['2027-03-28T00:00:00.000Z', '2027-03-29T00:00:00.000Z'],
      ['2027-03-29T23:00:00.000Z', '2027-03-30T23:00:00.000Z'],
    ]);
  });
});
