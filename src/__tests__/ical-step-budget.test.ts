// ical.js looks for a SECONDLY to WEEKLY rule's next occurrence one step at a time with no limit
// (RecurIterator.next; MONTHLY and YEARLY give up only when whole months or years fail), so a rule
// that never occurs held the whole process. Every expansion now has a budget of steps, a count of
// ical.js's work that reads no clock: a rule that needs more is refused as invalid_icalendar,
// quickly and the same way however loaded the machine, whether it came from a feed, a library call
// or the store.
import ICAL from 'ical.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CalendarExpansionLimitError,
  expandCalendarEventOccurrences,
  expandStoredCalendarEventOccurrences,
  parseICalendarChanges,
  parseICalendarFeed,
  parseTrustedICalendarEvents,
} from '../sync.js';

const WINDOW = {
  start: new Date('2026-10-01T00:00:00Z'),
  end: new Date('2027-10-01T00:00:00Z'),
};

function feed(...events: { uid: string; start: string; rule: string }[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotlock tests//EN',
    ...events.flatMap(({ uid, start, rule }) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261010T000000Z',
      `DTSTART:${start}`,
      `DTEND:${start.replace(/T(\d\d)/, (_, hour: string) => `T${String(Number(hour) + 1).padStart(2, '0')}`)}`,
      `RRULE:${rule}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

/** How long `work` ran, and what it threw. */
function timed(work: () => unknown): { ms: number; error: unknown } {
  const started = performance.now();
  try {
    work();
    return { ms: performance.now() - started, error: null };
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
}

const refused = expect.objectContaining({ code: 'invalid_icalendar' });
const ordinary = feed({
  uid: 'standup',
  start: '20260105T090000Z',
  rule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
});

describe('the step budget on recurrence expansion', () => {
  it('refuses a rule whose next occurrence is further away than the budget allows', () => {
    // Without a budget this finishes, after about 720,000 one-minute steps to 29 February 2028.
    const { error } = timed(() =>
      parseICalendarChanges(
        feed({
          uid: 'sparse',
          start: '20261020T090000Z',
          rule: 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=29',
        }),
        'UTC',
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
  });

  // Each of these never occurs; ical.js searched for it forever.
  it.each([
    ['30 February, daily', '20261020T090000Z', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['31 April, hourly', '20261020T090000Z', 'FREQ=HOURLY;BYMONTH=4;BYMONTHDAY=31'],
    ['31 April, every minute', '20261020T090000Z', 'FREQ=MINUTELY;BYMONTH=4;BYMONTHDAY=31'],
    ['30 February, every second', '20261020T090000Z', 'FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'],
    ['the fifth Monday, daily', '20261020T090000Z', 'FREQ=DAILY;BYDAY=5MO'],
    ['Tuesdays every 7 days from a Monday', '20261019T090000Z', 'FREQ=DAILY;INTERVAL=7;BYDAY=TU'],
    // BYHOUR=8 puts ical.js's first candidate an hour before the 09:00 start, so it searches for the
    // first occurrence while it builds the iterator, before the expansion is handed back.
    [
      '30 February from an hour after its only hour',
      '20261020T090000Z',
      'FREQ=DAILY;BYHOUR=8;BYMONTH=2;BYMONTHDAY=30',
    ],
  ])('refuses %s in a feed promptly', (_name, start, rule) => {
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'never', start, rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    // The step count stops it in about a tenth of a second; on a loaded machine the feed's
    // one-second limit does, so the bound sits above that limit rather than on it.
    expect(ms).toBeLessThan(2_500);
  });

  it('bounds a library expansion the same way, which the store and the confirmation use', () => {
    const { ms, error } = timed(() =>
      expandCalendarEventOccurrences(
        {
          start: new Date('2026-10-19T09:00:00Z'),
          end: new Date('2026-10-19T10:00:00Z'),
          timezone: 'Europe/London',
          summary: 'Busy',
          recurrence: { rrule: 'FREQ=DAILY;INTERVAL=7;BYDAY=TU' },
        },
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeLessThan(1_000);
  });

  it('shares one budget among all the events of a feed', () => {
    // A yearly date written as a daily rule takes three steps a day, and an eighth of one for the
    // day it walks: from 1950 that is about 89,000 steps, so five fit the budget of 500,000 and six
    // do not. (A COUNT is counted from DTSTART, so each is searched from there.)
    const yearly = (uid: string) => ({
      uid,
      start: '19500101T090000Z',
      rule: 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=1;COUNT=1000',
    });
    const many = (count: number) =>
      feed(...Array.from({ length: count }, (_, index) => yearly(`yearly-${index}`)));
    expect(parseICalendarChanges(many(5), 'UTC', WINDOW)).toHaveLength(5);
    expect(timed(() => parseICalendarChanges(many(6), 'UTC', WINDOW)).error).toEqual(refused);
  });

  it('reads a busy feed: thirty series on the fifth Monday of the month since 2000', () => {
    const fifthMondays = Array.from({ length: 30 }, (_, index) => ({
      uid: `fifth-${index}`,
      start: `20000131T${String(index % 24).padStart(2, '0')}0000Z`,
      rule: 'FREQ=MONTHLY;BYDAY=5MO',
    }));
    // 2026-10-01 to 2027-10-01 has four months with a fifth Monday.
    expect(parseICalendarChanges(feed(...fifthMondays), 'UTC', WINDOW)).toHaveLength(120);
  });

  // ical.js moves a MINUTELY to WEEKLY rule a day at a time within one step, so a step may move at
  // most a century: FREQ=DAILY;INTERVAL=1000000000 spent 97 seconds in one step. (FREQ=SECONDLY is
  // refused whatever its interval: ical-rrule-shapes.test.ts.)
  it.each([
    ['MINUTELY', 52_704_000],
    ['HOURLY', 878_400],
    ['DAILY', 36_600],
    ['WEEKLY', 5_228],
  ])('allows a %s step of up to a century (INTERVAL=%i) and refuses a longer one', (freq, max) => {
    const parse = (interval: number) =>
      timed(() =>
        parseICalendarChanges(
          feed({
            uid: 'far',
            start: '20261020T090000Z',
            rule: `FREQ=${freq};INTERVAL=${interval}`,
          }),
          'UTC',
          WINDOW,
        ),
      );
    expect(parse(max).error).toBeNull();
    const longer = parse(max + 1);
    expect(longer.error).toEqual(refused);
    expect(longer.ms).toBeLessThan(100);
    expect(parse(max * 1_000).error).toEqual(refused);
  });

  it('does not cap MONTHLY or YEARLY steps, which ical.js adds in one go', () => {
    // A thousand years at a step, ten times the century the other frequencies may move.
    for (const rule of ['FREQ=MONTHLY;INTERVAL=12000', 'FREQ=YEARLY;INTERVAL=1000']) {
      let changes: unknown = null;
      const { ms, error } = timed(() => {
        changes = parseICalendarChanges(
          feed({ uid: 'far', start: '20261020T090000Z', rule }),
          'UTC',
          WINDOW,
        );
      });
      expect(error).toBeNull();
      expect(ms).toBeLessThan(100);
      expect(changes).toHaveLength(1);
    }
  });

  // These take few search steps but slow ones, walked a day at a time: about 4 ms for a century.
  // Each day walked is charged, so they are refused within the budget: about 0.4 s for a feed (and a
  // stored series as the roll expands it), 0.04 s for one event as it is written or asked about.
  const slow = [
    ['29 February a century at a time', 'FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=29'],
    ['29 February every 9,999 days', 'FREQ=DAILY;INTERVAL=9999;BYMONTH=2;BYMONTHDAY=29'],
  ];

  it.each(slow)('refuses %s in a feed within its budget', (_name, rule) => {
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'slow', start: '20261020T090000Z', rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeLessThan(2_500);
  });

  it('refuses any weekday on 30 February, yearly, by its shape, at once', () => {
    // ical.js scanned every day of every year for it, to the year 20000.
    const rule = 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU';
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'slow', start: '20261020T090000Z', rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeLessThan(100);
  });

  it.each(slow)('refuses %s as one event within a few hundredths of a second', (_name, rule) => {
    const { ms, error } = timed(() =>
      expandCalendarEventOccurrences(
        {
          start: new Date('2026-10-20T09:00:00Z'),
          end: new Date('2026-10-20T10:00:00Z'),
          timezone: 'UTC',
          summary: 'Busy',
          recurrence: { rrule: rule },
        },
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeLessThan(250);
  });

  it('writes a monthly series on a weekday that began in 1990', () => {
    // Each month compares every day with the rule's weekday: about 36 steps, 16,500 since 1990.
    const board = {
      start: new Date('1990-01-26T09:00:00Z'),
      end: new Date('1990-01-26T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Board meeting',
      recurrence: { rrule: 'FREQ=MONTHLY;BYDAY=-1FR' },
    };
    expect(expandCalendarEventOccurrences(board, WINDOW)).toHaveLength(12);
  });

  it('gives one event a tenth of the steps of a feed, so a series written today keeps rolling', () => {
    // A yearly date written as a daily rule from 1950: about 89,000 steps, over the 50,000 one event
    // may take as it is written, within the 500,000 the roll expands a stored series with.
    const series = {
      start: new Date('1950-01-01T09:00:00Z'),
      end: new Date('1950-01-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Busy',
      recurrence: { rrule: 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=1' },
    };
    expect(timed(() => expandCalendarEventOccurrences(series, WINDOW)).error).toEqual(refused);
    expect(expandStoredCalendarEventOccurrences(series, WINDOW)).toHaveLength(1);
    // From 1990, about 43,000 steps: written.
    const later = {
      ...series,
      start: new Date('1990-01-01T09:00:00Z'),
      end: new Date('1990-01-01T10:00:00Z'),
    };
    expect(expandCalendarEventOccurrences(later, WINDOW)).toHaveLength(1);
  });

  describe('spans and date lists', () => {
    // ical.js adds a span to a time a month at a time (Time#adjust) and sorts RDATE and EXDATE
    // values in one by one, so these are bounded before anything reads an end.
    const single = (lines: string[]) =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slotlock tests//EN',
        'BEGIN:VEVENT',
        'UID:span',
        'DTSTAMP:20261010T000000Z',
        'SUMMARY:Handover',
        ...lines,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
    // Every other day from 3 November: ical.js gives up after 500 excluded occurrences in a row.
    const days = (count: number) =>
      Array.from({ length: count }, (_, day) =>
        new Date(Date.UTC(2026, 10, 3 + 2 * day, 9))
          .toISOString()
          .replace(/[-:]/g, '')
          .replace('.000', ''),
      ).join(',');
    const start = 'DTSTART:20261102T090000Z';

    it.each([
      ['a DURATION of a billion weeks', [start, 'DURATION:P999999999W']],
      ['a DURATION of 10^20 seconds', [start, 'DURATION:PT99999999999999999999S']],
      ['a negative DURATION of a billion weeks', [start, 'DURATION:-P999999999W']],
      [
        'a repeating DURATION of 10^15 seconds',
        [start, 'DURATION:PT999999999999999S', 'RRULE:FREQ=DAILY;COUNT=20'],
      ],
      [
        'a repeating event that ends 7,973 years after it starts',
        [start, 'DTEND:99991231T090000Z', 'RRULE:FREQ=DAILY;COUNT=20'],
      ],
      [
        '1,001 EXDATE values',
        [start, 'DTEND:20261102T100000Z', 'RRULE:FREQ=DAILY', `EXDATE:${days(1_001)}`],
      ],
    ])('refuses %s, in both parsers, before reading it', (_name, lines) => {
      for (const parse of [
        () => parseICalendarChanges(single(lines), 'UTC', WINDOW),
        () => parseTrustedICalendarEvents(single(lines), 'UTC'),
      ]) {
        const { ms, error } = timed(parse);
        expect(error).toEqual(refused);
        expect(ms).toBeLessThan(100);
      }
    });

    it('refuses an occurrence moved more than a century later', () => {
      const feedText = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slotlock tests//EN',
        'BEGIN:VEVENT',
        'UID:moved',
        'DTSTAMP:20261010T000000Z',
        start,
        'DTEND:20261102T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:moved',
        'DTSTAMP:20261010T000000Z',
        'RECURRENCE-ID:20261103T090000Z',
        'DTSTART:21300101T090000Z',
        'DTEND:21300101T100000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      expect(timed(() => parseICalendarChanges(feedText, 'UTC', WINDOW)).error).toEqual(refused);
    });

    it('still reads a five-year span, a year-long repeating one and 1,000 EXDATE values', () => {
      const [lease] = parseICalendarChanges(single([start, 'DURATION:P1826D']), 'UTC', WINDOW);
      expect(lease?.end?.toISOString()).toBe('2031-11-02T09:00:00.000Z');
      const yearly = parseICalendarChanges(
        single([start, 'DTEND:20271102T090000Z', 'RRULE:FREQ=YEARLY;COUNT=2']),
        'UTC',
        WINDOW,
      );
      expect(yearly).toHaveLength(1);
      const daily = parseICalendarChanges(
        single([start, 'DTEND:20261102T100000Z', 'RRULE:FREQ=DAILY', `EXDATE:${days(1_000)}`]),
        'UTC',
        WINDOW,
      );
      // 2026-11-02 to 2027-10-01 is 333 days, and every other one from the second is excluded.
      expect(daily).toHaveLength(167);
    });
  });

  it('leaves ical.js itself as it was', () => {
    const methods = Object.getOwnPropertyNames(ICAL.RecurIterator.prototype);
    const before = methods.map(
      (name) => (ICAL.RecurIterator.prototype as unknown as Record<string, unknown>)[name],
    );
    const iterator = ICAL.Recur.prototype.iterator;
    expect(() =>
      parseICalendarChanges(
        feed({
          uid: 'never',
          start: '20261020T090000Z',
          rule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
        }),
        'UTC',
        WINDOW,
      ),
    ).toThrow();
    expect(
      methods.map(
        (name) => (ICAL.RecurIterator.prototype as unknown as Record<string, unknown>)[name],
      ),
    ).toEqual(before);
    expect(ICAL.Recur.prototype.iterator).toBe(iterator);
  });

  it('refuses every recurring event if ical.js no longer has a method it charges', () => {
    const prototype = ICAL.RecurIterator.prototype as unknown as Record<string, unknown>;
    const expandYearDays = prototype.expand_year_days;
    prototype.expand_year_days = undefined;
    try {
      expect(timed(() => parseICalendarChanges(ordinary, 'UTC', WINDOW)).error).toEqual(refused);
    } finally {
      prototype.expand_year_days = expandYearDays;
    }
    expect(parseICalendarChanges(ordinary, 'UTC', WINDOW)).toHaveLength(261);
  });

  it('refuses every recurring event if ical.js stops building its iterators from the event rules', () => {
    const eventIterator = ICAL.Event.prototype.iterator;
    ICAL.Event.prototype.iterator = function (this: ICAL.Event, start?: ICAL.Time) {
      const copy = new ICAL.Component(this.component.toJSON());
      return new ICAL.RecurExpansion({ component: copy, dtstart: start ?? this.startDate });
    };
    try {
      expect(timed(() => parseICalendarChanges(ordinary, 'UTC', WINDOW)).error).toEqual(refused);
    } finally {
      ICAL.Event.prototype.iterator = eventIterator;
    }
  });

  describe("a feed's own time zone", () => {
    // ical.js expands a VTIMEZONE's rules whenever it reads a time in a zone Intl does not know, so
    // the zone's rules get the same budget as the events'.
    const zoned = (standard: string, start: string, eventRule?: string) =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slotlock tests//EN',
        'BEGIN:VTIMEZONE',
        'TZID:Custom/Fleet',
        'BEGIN:STANDARD',
        'DTSTART:19701025T020000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0000',
        `RRULE:${standard}`,
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T010000',
        'TZOFFSETFROM:+0000',
        'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:zoned',
        'DTSTAMP:20261010T000000Z',
        'SUMMARY:Handover',
        `DTSTART;TZID=Custom/Fleet:${start}`,
        `DTEND;TZID=Custom/Fleet:${start.replace('T09', 'T10')}`,
        ...(eventRule ? [`RRULE:${eventRule}`] : []),
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
    const london = 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU';
    const never = 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30';

    it('still reads a time in it, by its rules', () => {
      for (const [start, utc] of [
        ['20261102T090000', '2026-11-02T09:00:00.000Z'],
        ['20270701T090000', '2027-07-01T08:00:00.000Z'],
      ] as const) {
        const [change] = parseICalendarChanges(zoned(london, start), undefined, WINDOW);
        expect(change?.start?.toISOString()).toBe(utc);
      }
    });

    it.each([
      [
        'a one-off event',
        () => parseICalendarChanges(zoned(never, '20261102T090000'), undefined, WINDOW),
      ],
      [
        'a repeating event',
        () =>
          parseICalendarChanges(
            zoned(never, '20261102T090000', 'FREQ=DAILY;COUNT=3'),
            undefined,
            WINDOW,
          ),
      ],
      ['full event content', () => parseTrustedICalendarEvents(zoned(never, '20261102T090000'))],
    ])('refuses a zone whose rule never occurs, read for %s, promptly', (_name, parse) => {
      const { ms, error } = timed(parse);
      expect(error).toEqual(refused);
      expect(ms).toBeLessThan(2_500);
    });

    it('refuses a zone whose rule takes slow steps, within the budget, in both parsers', () => {
      // ical.js lists every weekday of every year for this rule, which never occurs, to the year
      // 20000: each year's 365 days are charged as about 190 steps, so the budget stops it.
      const slowZone = zoned(
        'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU',
        '20261102T090000',
      );
      for (const parse of [
        () => parseICalendarChanges(slowZone, undefined, WINDOW),
        () => parseTrustedICalendarEvents(slowZone),
      ]) {
        const { ms, error } = timed(parse);
        // Refused by the budget itself: without it ical.js finishes its scan in seconds, and the
        // full-content parser then refuses the private zone name instead.
        expect(error).toBeInstanceOf(CalendarExpansionLimitError);
        expect(ms).toBeLessThan(2_500);
      }
    });

    it('reads a zone named like an IANA zone as Intl does, never by its own rule, promptly', () => {
      // A name Intl knows is read through Intl everywhere, ical.js's comparisons included, so the
      // feed's own rule, which never occurs, is never expanded.
      let changes: { start: Date | null }[] = [];
      const { ms, error } = timed(() => {
        changes = parseICalendarChanges(
          zoned(never, '20261102T090000', 'FREQ=DAILY;COUNT=3').replaceAll(
            'Custom/Fleet',
            'Europe/London',
          ),
          undefined,
          WINDOW,
        );
      });
      expect(error).toBeNull();
      expect(changes.map((change) => change.start?.toISOString())).toEqual([
        '2026-11-02T09:00:00.000Z',
        '2026-11-03T09:00:00.000Z',
        '2026-11-04T09:00:00.000Z',
      ]);
      expect(ms).toBeLessThan(2_500);
    });

    it('refuses a zone whose rule changes the clocks every minute, promptly', () => {
      const { ms, error } = timed(() =>
        parseICalendarChanges(zoned('FREQ=MINUTELY', '20261102T090000'), undefined, WINDOW),
      );
      expect(error).toEqual(refused);
      expect(ms).toBeLessThan(2_500);
    });

    it('reads an Outlook feed with twenty Windows zones defined from 1601 (ENG-17)', () => {
      // Outlook and Exchange write each zone's observances from 1 January 1601. ical.js expands
      // them from there to five years past this one, a year at a time, for every zone the feed
      // reads a time in: a few microseconds a year for a rule like these.
      const outlookZone = (name: string, hours: number) => [
        'BEGIN:VTIMEZONE',
        `TZID:${name}`,
        'BEGIN:STANDARD',
        'DTSTART:16010101T030000',
        `TZOFFSETFROM:+${String(hours + 1).padStart(2, '0')}00`,
        `TZOFFSETTO:+${String(hours).padStart(2, '0')}00`,
        'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:16010101T020000',
        `TZOFFSETFROM:+${String(hours).padStart(2, '0')}00`,
        `TZOFFSETTO:+${String(hours + 1).padStart(2, '0')}00`,
        'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
      ];
      const zones = Array.from({ length: 20 }, (_, i) => `Fleet ${i} Standard Time`);
      const outlook = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
        ...zones.flatMap((name, i) => outlookZone(name, i % 10)),
        ...zones.flatMap((name, i) => [
          'BEGIN:VEVENT',
          `UID:weekly-${i}`,
          'DTSTAMP:20261010T000000Z',
          `DTSTART;TZID=${name}:20150105T090000`,
          `DTEND;TZID=${name}:20150105T100000`,
          'RRULE:FREQ=WEEKLY;BYDAY=TU',
          'END:VEVENT',
          'BEGIN:VEVENT',
          `UID:monthly-${i}`,
          'DTSTAMP:20261010T000000Z',
          `DTSTART;TZID=${name}:20150105T110000`,
          `DTEND;TZID=${name}:20150105T120000`,
          'RRULE:FREQ=MONTHLY;BYDAY=1MO',
          'END:VEVENT',
        ]),
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      const changes = parseICalendarChanges(outlook, undefined, WINDOW);
      const count = (prefix: string) =>
        changes.filter((change) => change.externalId.startsWith(prefix)).length;
      // 2026-10-01 to 2027-10-01: 52 Tuesdays and 12 first Mondays, in each of the twenty zones.
      expect([count('weekly-'), count('monthly-')]).toEqual([20 * 52, 20 * 12]);
      // In its zone, a Tuesday 09:00 in winter is 09:00 less the zone's standard offset.
      const first = changes.find((change) => change.externalId === 'weekly-3');
      expect(first?.start?.toISOString()).toBe('2026-10-06T05:00:00.000Z');
    });

    it('refuses a zone whose step is longer than a century', () => {
      const { ms, error } = timed(() =>
        parseICalendarChanges(
          zoned('FREQ=DAILY;INTERVAL=1000000000', '20261102T090000'),
          undefined,
          WINDOW,
        ),
      );
      expect(error).toEqual(refused);
      expect(ms).toBeLessThan(100);
    });
  });

  describe('a budget that counts work, not time', () => {
    const event = (rrule: string) => ({
      start: new Date('2026-10-20T09:00:00Z'),
      end: new Date('2026-10-20T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Busy',
      recurrence: { rrule },
    });
    // Each write of this rule walked 9,999 days a step, charged once, until the half-second limit
    // stopped it: fifty of them from one tenant held a hosted server for 23 seconds (SEC-3).
    const walker = 'FREQ=DAILY;INTERVAL=9999;BYMONTH=2;BYMONTHDAY=29';

    it('reads or refuses the same calendar however slow the clock runs (D21)', () => {
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
        now += 1_000;
        return now;
      });
      try {
        expect(parseICalendarChanges(ordinary, 'UTC', WINDOW)).toHaveLength(261);
        expect(
          expandCalendarEventOccurrences(event('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'), WINDOW),
        ).toHaveLength(248);
        const titled = ordinary.replace('UID:standup', 'UID:standup\r\nSUMMARY:Standup');
        expect(parseTrustedICalendarEvents(titled)).toHaveLength(1);
        expect(timed(() => expandCalendarEventOccurrences(event(walker), WINDOW)).error).toEqual(
          refused,
        );
      } finally {
        clock.mockRestore();
      }
    });

    it('refuses a rule that walks far between occurrences promptly with the clock stopped', () => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      try {
        const started = Date.now();
        let error: unknown = null;
        try {
          expandCalendarEventOccurrences(event(walker), WINDOW);
        } catch (thrown) {
          error = thrown;
        }
        expect(error).toBeInstanceOf(CalendarExpansionLimitError);
        expect(Date.now() - started).toBeLessThan(250);
      } finally {
        clock.mockRestore();
      }
    });

    it('refuses fifty writes of it from one tenant within a few seconds in all (SEC-3)', () => {
      const started = performance.now();
      for (let write = 0; write < 50; write++) {
        expect(timed(() => expandCalendarEventOccurrences(event(walker), WINDOW)).error).toEqual(
          refused,
        );
      }
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });

  describe('a series in a named time zone (SEC-3)', () => {
    // Every occurrence of a series in an IANA zone is read through the zone's offsets. Each read
    // built an Intl formatter to check the zone's name and asked Intl for four to six offsets, and
    // none of it was charged: forty daily London series from 2016 held a feed for 35 seconds and
    // were read, and one written as a single event took half a second to be refused.
    const daily = (zone: string, series: number) =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slotlock tests//EN',
        ...Array.from({ length: series }, (_, index) => {
          const minute = String(index % 60).padStart(2, '0');
          return [
            'BEGIN:VEVENT',
            `UID:daily-${index}`,
            'DTSTAMP:20261010T000000Z',
            `DTSTART;TZID=${zone}:20160105T09${minute}00`,
            `DTEND;TZID=${zone}:20160105T10${minute}00`,
            'RRULE:FREQ=DAILY;COUNT=3990',
            'END:VEVENT',
          ];
        }).flat(),
        'END:VCALENDAR',
      ].join('\r\n');
    // The verifier's window: 46 occurrences of each series fall in it, 1,840 in all, fewer than a
    // feed may hold, so only the budget can refuse the feed.
    const feedWindow = {
      start: new Date('2026-10-23T00:00:00Z'),
      end: new Date('2027-10-23T00:00:00Z'),
    };
    const since = (start: string, timezone: string, rrule = 'FREQ=DAILY') => ({
      start: new Date(start),
      end: new Date(new Date(start).getTime() + 30 * 60_000),
      timezone,
      summary: 'Busy',
      recurrence: { rrule },
    });

    /** How many Intl formatters `work` builds, how many instants it asks them to read, how long. */
    function intlWork(work: () => unknown) {
      const Formatter = Intl.DateTimeFormat;
      let built = 0;
      const counting = new Proxy(Formatter, {
        construct(target, args, newTarget) {
          built += 1;
          return Reflect.construct(target, args, newTarget);
        },
      });
      const read = vi.spyOn(Formatter.prototype, 'formatToParts');
      Object.defineProperty(Intl, 'DateTimeFormat', { value: counting, configurable: true });
      try {
        const { ms, error } = timed(work);
        return { built, read: read.mock.calls.length, ms, error };
      } finally {
        Object.defineProperty(Intl, 'DateTimeFormat', { value: Formatter, configurable: true });
        read.mockRestore();
      }
    }

    it.each(['UTC', 'Europe/London'])(
      'refuses forty daily series from 2016 in %s as a feed, promptly, reading Intl a bounded number of times',
      (zone) => {
        const work = intlWork(() => parseICalendarChanges(daily(zone, 40), undefined, feedWindow));
        expect(work.error).toBeInstanceOf(CalendarExpansionLimitError);
        // A month of a zone's offsets is read from Intl once: about 35 instants. From 2016 to 2026
        // that is a few thousand, however many occurrences convert a time in it.
        expect(work.built).toBeLessThan(10);
        expect(work.read).toBeLessThan(20_000);
        expect(work.ms).toBeLessThan(2_500);
      },
      120_000,
    );

    it('refuses a daily London series from 2016 as one write, reading Intl a bounded number of times', () => {
      const work = intlWork(() =>
        expandCalendarEventOccurrences(since('2016-02-01T09:00:00Z', 'Europe/London'), WINDOW),
      );
      expect(work.error).toEqual(refused);
      expect(work.built).toBeLessThan(10);
      expect(work.read).toBeLessThan(20_000);
    }, 120_000);

    it('refuses fifty writes of it within a few seconds in all', () => {
      const started = performance.now();
      for (let write = 0; write < 50; write++) {
        const series = since('2016-02-01T09:00:00Z', 'Europe/London');
        expect(timed(() => expandCalendarEventOccurrences(series, WINDOW)).error).toEqual(refused);
      }
      expect(performance.now() - started).toBeLessThan(5_000);
    }, 120_000);

    it('refuses a feed of yearly series in 100 zones from 1700 having read Intl at most 80,000 times', () => {
      // Each instant Intl reads takes about five microseconds and its parts as long again on a CI
      // runner. Charged two and a half steps, a feed read 107,000 of them, 1.6 to 1.9 seconds there,
      // before the budget refused it: twice what the same budget allows a feed in UTC.
      const zones = Intl.supportedValuesOf('timeZone').filter((zone) => !zone.startsWith('Etc/'));
      const text = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slotlock tests//EN',
        ...Array.from({ length: 100 }, (_, index) => {
          const zone = zones[(index * 7) % zones.length] as string;
          return [
            'BEGIN:VEVENT',
            `UID:yearly-${index}`,
            'DTSTAMP:20261010T000000Z',
            `DTSTART;TZID=${zone}:17000105T090000`,
            `DTEND;TZID=${zone}:17000105T100000`,
            'RRULE:FREQ=YEARLY',
            'END:VEVENT',
          ];
        }).flat(),
        'END:VCALENDAR',
      ].join('\r\n');
      const work = intlWork(() => parseICalendarChanges(text, undefined, feedWindow));
      expect(work.error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(work.read).toBeLessThan(80_000);
    }, 120_000);

    it('still writes a daily London series from 2020, and every weekday since 2016', () => {
      expect(
        expandCalendarEventOccurrences(since('2020-02-03T09:00:00Z', 'Europe/London'), WINDOW),
      ).toHaveLength(365);
      const weekdays = since(
        '2016-02-01T09:00:00Z',
        'Europe/London',
        'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      );
      expect(expandCalendarEventOccurrences(weekdays, WINDOW)).toHaveLength(261);
    });

    it('reads or refuses a London feed the same way whether its offsets were read before or not', async () => {
      // The months of offsets a parse reads are charged whether or not an earlier parse in the
      // process has read them already, so what is refused never depends on what came before.
      const text = daily('Europe/London', 40);
      const refusedUids = (read: typeof parseICalendarFeed) =>
        read(text, undefined, feedWindow).refused.map((refusal) => refusal.uid);
      vi.resetModules();
      const fresh = await import('../sync.js');
      const cold = refusedUids(fresh.parseICalendarFeed);
      expect(cold.length).toBeGreaterThan(0);
      expect(cold.length).toBeLessThan(40);
      expect(refusedUids(parseICalendarFeed)).toEqual(cold);
      expect(refusedUids(fresh.parseICalendarFeed)).toEqual(cold);
    }, 120_000);
  });

  it('still reads an ordinary feed in full', () => {
    const changes = parseICalendarChanges(
      feed(
        { uid: 'standup', start: '20250106T090000Z', rule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR' },
        { uid: 'review', start: '20200106T140000Z', rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' },
        { uid: 'payroll', start: '20180126T100000Z', rule: 'FREQ=MONTHLY;BYDAY=-1FR' },
        { uid: 'service', start: '20100301T080000Z', rule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1' },
        { uid: 'leap', start: '20080229T080000Z', rule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29' },
      ),
      'UTC',
      WINDOW,
    );
    const count = (uid: string) => changes.filter((change) => change.externalId === uid).length;
    // 2026-10-01 to 2027-10-01: 261 weekdays, 26 fortnightly Mondays, 12 last Fridays, one 1 March,
    // and no 29 February.
    expect([
      count('standup'),
      count('review'),
      count('payroll'),
      count('service'),
      count('leap'),
    ]).toEqual([261, 26, 12, 1, 0]);
  });
});
