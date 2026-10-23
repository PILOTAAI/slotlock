// ical.js looks for a SECONDLY to WEEKLY rule's next occurrence one step at a time with no limit
// (RecurIterator.next; MONTHLY and YEARLY give up only when whole months or years fail), so a rule
// that never occurs held the whole process. Every expansion now has a step and time budget: a rule
// that needs more is refused as invalid_icalendar, quickly, whether it came from a feed, a library
// call or the store.
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  CalendarExpansionLimitError,
  expandCalendarEventOccurrences,
  expandStoredCalendarEventOccurrences,
  parseICalendarChanges,
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
    // A yearly date written as a daily rule takes a step a day: from 1950 that is about 28,400
    // steps, so one fits the budget of 50,000 and two do not.
    const yearly = (uid: string) => ({
      uid,
      start: '19500101T090000Z',
      rule: 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=1',
    });
    expect(parseICalendarChanges(feed(yearly('one')), 'UTC', WINDOW)).toHaveLength(1);
    const { error } = timed(() =>
      parseICalendarChanges(feed(yearly('a'), yearly('b')), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
  });

  // ical.js moves a SECONDLY to WEEKLY rule a day at a time within one step, uncharged, so a step
  // may move at most a century: FREQ=DAILY;INTERVAL=1000000000 spent 97 seconds in one step.
  it.each([
    ['SECONDLY', 3_162_240_000],
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

  // These take few steps but slow ones, so the count alone would let them run for minutes. The time
  // limit stops them: a second for a feed (and a stored series as the roll expands it), half of one
  // for a single event as it is written or asked about.
  const slow = [
    // A step of a century, the most allowed, walked a day at a time: about 4 ms each.
    ['29 February a century at a time', 'FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=29'],
    // ical.js expands every year's days for each yearly step.
    [
      'any weekday on 30 February, yearly',
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU',
    ],
  ];

  it.each(slow)('refuses %s in a feed after a second', (_name, rule) => {
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'slow', start: '20261020T090000Z', rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(2_500);
  });

  it.each(slow)('refuses %s as one event after half a second', (_name, rule) => {
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
    expect(ms).toBeGreaterThanOrEqual(500);
    // The time limit is wall-clock time, so it stops here however loaded the machine is.
    expect(ms).toBeLessThan(1_000);
  });

  it('gives one event half the steps of a feed, so a series written today keeps rolling', () => {
    // A yearly date written as a daily rule from 1950: about 28,400 steps, over the 25,000 one event
    // may take as it is written, within the 50,000 the roll expands a stored series with.
    const series = {
      start: new Date('1950-01-01T09:00:00Z'),
      end: new Date('1950-01-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Busy',
      recurrence: { rrule: 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=1' },
    };
    expect(timed(() => expandCalendarEventOccurrences(series, WINDOW)).error).toEqual(refused);
    expect(expandStoredCalendarEventOccurrences(series, WINDOW)).toHaveLength(1);
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

    it('refuses a zone whose rule takes slow steps, after the time limit, in both parsers', () => {
      // Reading a time is timed like a search: ical.js expands every year's days for each of this
      // rule's yearly steps, so the step count alone would let it run for seconds.
      const slowZone = zoned(
        'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU',
        '20261102T090000',
      );
      for (const parse of [
        () => parseICalendarChanges(slowZone, undefined, WINDOW),
        () => parseTrustedICalendarEvents(slowZone),
      ]) {
        const { ms, error } = timed(parse);
        // Refused by the time limit itself: without it ical.js finishes its scan in seconds, and the
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
