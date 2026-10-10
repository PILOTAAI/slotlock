// Round 2 of #32's review: a feed could still hold the process outside the recurrence budget.
// - Its own time zone with tens of thousands of RDATE values, re-expanded by ical.js for every later
//   year it reads (and appended again each time), ran for 34 seconds and then ran out of memory.
// - An exception for "this and every later occurrence" (RANGE=THISANDFUTURE) made ical.js read a
//   slow zone while the event was built, where only steps were counted, not time: 150 seconds.
// - A TZID no VTIMEZONE defines made ical.js scan every VTIMEZONE for every date value: 31 seconds.
// And ical.js gave every series in a feed the exceptions of every other series (by local time).
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';
import { zonedDateTimeToUtc } from '../timezone.js';

const WINDOW = {
  start: new Date('2026-10-01T00:00:00Z'),
  end: new Date('2027-10-01T00:00:00Z'),
};

const calendar = (...body: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Slotlock tests//EN', ...body, 'END:VCALENDAR'].join(
    '\r\n',
  );
const event = (...properties: string[]) => [
  'BEGIN:VEVENT',
  'DTSTAMP:20261010T000000Z',
  'SUMMARY:Busy',
  ...properties,
  'END:VEVENT',
];

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

const parsers = [
  ['the feed parser', (text: string) => parseICalendarChanges(text, 'UTC', WINDOW)],
  ['the full-content parser', (text: string) => parseTrustedICalendarEvents(text, 'UTC')],
] as const;

describe("one series' exceptions", () => {
  it('are never taken for those of another series at the same local time', () => {
    const london = 'TZID=Europe/London';
    const text = calendar(
      ...event(
        'UID:handover',
        `DTSTART;${london}:20261102T090000`,
        `DTEND;${london}:20261102T100000`,
        'RRULE:FREQ=DAILY;COUNT=4',
      ),
      ...event(
        'UID:inspection',
        `DTSTART;${london}:20261102T090000`,
        `DTEND;${london}:20261102T093000`,
        'RRULE:FREQ=DAILY;COUNT=4',
      ),
      ...event(
        'UID:inspection',
        `RECURRENCE-ID;${london}:20261103T090000`,
        `DTSTART;${london}:20261103T090000`,
        `DTEND;${london}:20261103T093000`,
        'STATUS:CANCELLED',
      ),
      ...event(
        'UID:inspection',
        `RECURRENCE-ID;${london}:20261104T090000`,
        `DTSTART;${london}:20261104T150000`,
        `DTEND;${london}:20261104T153000`,
      ),
    );
    const changes = parseICalendarChanges(text, 'Europe/London', WINDOW);
    const read = (uid: string) =>
      changes
        .filter((change) => change.externalId === uid)
        .map((change) => [change.start?.toISOString().slice(5, 16), change.deleted]);
    // The handover keeps every 09:00: the inspection's cancellation and move are its own.
    expect(read('handover')).toEqual([
      ['11-02T09:00', false],
      ['11-03T09:00', false],
      ['11-04T09:00', false],
      ['11-05T09:00', false],
    ]);
    expect(read('inspection')).toEqual([
      ['11-02T09:00', false],
      ['11-03T09:00', true],
      ['11-04T15:00', false],
      ['11-05T09:00', false],
    ]);
  });
});

describe('a feed that would hold the process outside the recurrence budget', () => {
  const slowZone = [
    'BEGIN:VTIMEZONE',
    'TZID:Custom/Slow',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0100',
    // Allowed (a step of a century), never occurs, and each step walks 36,600 days: about 3 ms.
    'RRULE:FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=30',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  it.each(parsers)(
    'refuses %s an exception for every later occurrence that reads a slow zone as the series is built, promptly',
    (_name, parse) => {
      const text = calendar(
        ...slowZone,
        ...event(
          'UID:series',
          'DTSTART;TZID=Custom/Slow:20261102T090000',
          'DTEND;TZID=Custom/Slow:20261102T100000',
          'RRULE:FREQ=DAILY',
        ),
        ...event(
          'UID:series',
          'RECURRENCE-ID;TZID=Custom/Slow;RANGE=THISANDFUTURE:20261109T090000',
          'DTSTART;TZID=Custom/Slow:20261109T100000',
          'DTEND;TZID=Custom/Slow:20261109T110000',
        ),
      );
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(2_500);
    },
    // Without a clock on the whole parse this runs for minutes before it is refused.
    300_000,
  );

  const rdates = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `RDATE:${String(1971 + Math.floor(index / 300)).padStart(4, '0')}${String(1 + (index % 12)).padStart(2, '0')}${String(1 + (Math.floor(index / 12) % 25)).padStart(2, '0')}T020000`,
    );
  const floodZone = (count: number) => [
    'BEGIN:VTIMEZONE',
    'TZID:Custom/Flood',
    'BEGIN:STANDARD',
    'DTSTART:19700101T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    ...rdates(count),
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  // One-off events six years apart: ical.js expands the zone again for each, appending every change.
  const farEvents = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const year = 2032 + index * 6;
      return event(
        `UID:far-${index}`,
        `DTSTART;TZID=Custom/Flood:${year}0101T090000`,
        `DTEND;TZID=Custom/Flood:${year}0101T100000`,
      );
    }).flat();

  it.each(parsers)(
    'refuses %s a time zone with more RDATE values than any real zone has, before reading it',
    (_name, parse) => {
      const { ms, error } = timed(() => parse(calendar(...floodZone(2_001), ...farEvents(1))));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(500);
    },
  );

  it.each(parsers)(
    'bounds %s re-reading a zone of 2,000 RDATE values for every later year, promptly',
    (_name, parse) => {
      const { ms, error } = timed(() => parse(calendar(...floodZone(2_000), ...farEvents(300))));
      // Read, or refused (the full-content parser refuses a zone name Intl does not know).
      if (error !== null) expect(error).toBeInstanceOf(CalendarContractError);
      expect(ms).toBeLessThan(2_500);
    },
    300_000,
  );

  const stubZones = (count: number) =>
    Array.from({ length: count }, (_, index) => [
      'BEGIN:VTIMEZONE',
      `TZID:Stub/${index}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0000',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]).flat();
  const exdates = (uid: string, zone: string, count: number) =>
    event(
      `UID:${uid}`,
      'DTSTART:20261102T090000Z',
      'DTEND:20261102T100000Z',
      'RRULE:FREQ=DAILY;COUNT=2',
      `EXDATE;TZID=${zone}:${Array.from({ length: count }, (_, day) => {
        const date = new Date(Date.UTC(2001, 0, 1 + day * 2));
        return `${date.toISOString().slice(0, 10).replaceAll('-', '')}T090000`;
      }).join(',')}`,
    );

  it.each(parsers)('refuses %s more time zones than a feed has any use for', (_name, parse) => {
    const { ms, error } = timed(() =>
      parse(calendar(...stubZones(101), ...exdates('x', 'UTC', 1))),
    );
    expect(error).toBeInstanceOf(CalendarExpansionLimitError);
    expect(ms).toBeLessThan(500);
  });

  it.each(parsers)(
    'counts %s the time zones its text hides by folding their lines',
    (_name, parse) => {
      // ical.js unfolds `BEGIN:VTIME` + CRLF + space + `ZONE` into one line, which a count of the
      // raw text does not see: the parsed tree is what is counted.
      const folded = stubZones(101).map((line) =>
        line === 'BEGIN:VTIMEZONE' ? 'BEGIN:VTIME\r\n ZONE' : line,
      );
      const { error } = timed(() => parse(calendar(...folded, ...exdates('x', 'UTC', 1))));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
    },
  );

  it.each(parsers)(
    'refuses %s a feed of 20,000 time zones before ical.js parses it',
    (_name, parse) => {
      const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Slotlock tests//EN']
        .concat(
          Array.from({ length: 20_000 }, (_, index) => [
            'BEGIN:VTIMEZONE',
            `TZID:z${index}`,
            'END:VTIMEZONE',
          ]).flat(),
          exdates('x', 'UTC', 1),
          ['END:VCALENDAR'],
        )
        .join('\r\n');
      expect(text.length).toBeLessThan(2_000_000);
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      // Parsing it takes ical.js a few hundred milliseconds.
      expect(ms).toBeLessThan(50);
    },
  );

  it.each(parsers)(
    'refuses %s more RDATE and EXDATE values than a feed has any use for',
    (_name, parse) => {
      const many = Array.from({ length: 21 }, (_, index) =>
        exdates(`series-${index}`, 'Europe/London', 1_000),
      ).flat();
      const { ms, error } = timed(() => parse(calendar(...many)));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(500);
    },
  );

  it.each(parsers)(
    'bounds %s a zone no VTIMEZONE defines, looked up among them for every date value',
    (_name, parse) => {
      const many = Array.from({ length: 20 }, (_, index) =>
        exdates(`series-${index}`, 'Nowhere/Zone', 1_000),
      ).flat();
      const { ms } = timed(() => parse(calendar(...stubZones(100), ...many)));
      expect(ms).toBeLessThan(2_500);
    },
    300_000,
  );

  it.each(parsers)('still reads %s with 100 time zones and 20,000 date values', (_name, parse) => {
    const many = Array.from({ length: 20 }, (_, index) =>
      exdates(`series-${index}`, 'Europe/London', 1_000),
    ).flat();
    expect(() => parse(calendar(...stubZones(100), ...many))).not.toThrow();
  });
});

describe('converting a wall-clock time in a zone', () => {
  it('builds one formatter per zone, however many times a feed converts in it', () => {
    const built = { count: 0 };
    const Original = Intl.DateTimeFormat;
    // Count constructions without changing what they return.
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Original>) {
      built.count += 1;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = Object.assign(Counting, Original);
    try {
      for (let day = 1; day <= 28; day++) {
        zonedDateTimeToUtc(
          { year: 2026, month: 11, day, hour: 9, minute: 0, second: 0 },
          'Asia/Tokyo',
        );
      }
    } finally {
      Intl.DateTimeFormat = Original;
    }
    expect(built.count).toBeLessThanOrEqual(1);
    expect(
      zonedDateTimeToUtc(
        { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 },
        'Asia/Tokyo',
      ),
    ).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  it('still converts in any spelling Intl accepts once many spellings have been used', () => {
    const spellings = Array.from({ length: 600 }, (_, index) =>
      [...'europe/london']
        .map((letter, at) => ((index >> (at % 9)) & 1 ? letter.toUpperCase() : letter))
        .join(''),
    );
    for (const zone of spellings) {
      expect(
        zonedDateTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, zone),
      ).toEqual(new Date('2026-07-01T08:00:00Z'));
    }
  });
});
