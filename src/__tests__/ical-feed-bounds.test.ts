// Round 2 of #32's review: a feed could still hold the process outside the recurrence budget.
// - Its own time zone with tens of thousands of RDATE values, re-expanded by ical.js for every later
//   year it reads (and appended again each time), ran for 34 seconds and then ran out of memory.
// - An exception for "this and every later occurrence" (RANGE=THISANDFUTURE) made ical.js read a
//   slow zone while the event was built, where only steps were counted, not time: 150 seconds.
// - A TZID no VTIMEZONE defines made ical.js scan every VTIMEZONE for every date value: 31 seconds.
// And ical.js gave every series in a feed the exceptions of every other series (by local time).
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  icalendarPropertyHead,
  icalendarPropertyHeads,
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

  it.each(parsers)('refuses %s thousands of RRULEs on one event at once', (_name, parse) => {
    // Every step of the expansion compared each rule's next time, uncharged: 16,000 rules took
    // 64 million comparisons and a second and a half to refuse.
    const rules = Array.from({ length: 16_000 }, () => 'RRULE:FREQ=DAILY');
    const text = calendar(
      ...event('UID:fan-out', 'DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', ...rules),
    );
    const compare = ICAL.Time.prototype.compare;
    let compared = 0;
    ICAL.Time.prototype.compare = function (this: ICAL.Time, other: ICAL.Time) {
      compared += 1;
      return compare.call(this, other);
    };
    try {
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(compared).toBeLessThan(10_000);
      expect(ms).toBeLessThan(500);
    } finally {
      ICAL.Time.prototype.compare = compare;
    }
  });

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

describe('a feed that would hold the process inside one call (round 3)', () => {
  // One zone at every cap: 2,000 RDATE values in one observance and 999 more observances. ical.js
  // expands all of them again for each later year it reads, appending them each time, and sorting
  // 1,000 EXDATE values in years six apart read 1,000 later years inside one call: 26 to 35 seconds
  // and 650 MB from a 181 KB feed.
  const crowdedZone = [
    'BEGIN:VTIMEZONE',
    'TZID:Custom/Crowded',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    ...Array.from(
      { length: 2_000 },
      (_, index) =>
        `RDATE:${1971 + Math.floor(index / 300)}${String(1 + (index % 12)).padStart(2, '0')}${String(1 + (Math.floor(index / 12) % 25)).padStart(2, '0')}T020000`,
    ),
    'END:STANDARD',
    ...Array.from({ length: 999 }, () => [
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0000',
      'END:STANDARD',
    ]).flat(),
    'END:VTIMEZONE',
  ];
  const laterYears = (count: number) =>
    Array.from({ length: count }, (_, index) => `${2032 + index * 6}0101T090000`).join(',');

  it.each(parsers)(
    'bounds %s a zone re-read for 1,000 later years within one call',
    (_name, parse) => {
      const text = calendar(
        ...crowdedZone,
        ...event(
          'UID:years',
          'DTSTART;TZID=Custom/Crowded:20261102T090000',
          'DTEND;TZID=Custom/Crowded:20261102T100000',
          'RRULE:FREQ=YEARLY;COUNT=2',
          `EXDATE;TZID=Custom/Crowded:${laterYears(1_000)}`,
        ),
      );
      const { ms, error } = timed(() => parse(text));
      if (error !== null) expect(error).toBeInstanceOf(CalendarContractError);
      expect(ms).toBeLessThan(1_500);
    },
    // Without a bound on each re-expansion this runs for half a minute or more.
    600_000,
  );

  it('reads a zone re-read for 300 later years in full, keeping one copy of its changes', () => {
    // Expanded again for each later year, the zone keeps one copy of its 3,000 changes: appending
    // them each time, the sorts alone pass the time limit.
    const text = calendar(
      ...crowdedZone,
      ...event(
        'UID:years',
        'DTSTART;TZID=Custom/Crowded:20261102T090000',
        'DTEND;TZID=Custom/Crowded:20261102T100000',
        'RRULE:FREQ=YEARLY;COUNT=2',
        `EXDATE;TZID=Custom/Crowded:${laterYears(300)}`,
      ),
    );
    const { ms, error } = timed(() => parseICalendarChanges(text, 'UTC', WINDOW));
    expect(error).toBeNull();
    expect(ms).toBeLessThan(1_000);
  }, 600_000);

  it('reads 1,500 events in one crowded zone with one expansion of it', () => {
    // Every time read in the zone asks ical.js for its coverage; only a later year expands it again.
    const text = calendar(
      ...crowdedZone,
      ...Array.from({ length: 1_500 }, (_, index) =>
        event(
          `UID:shift-${index}`,
          `DTSTART;TZID=Custom/Crowded:2026${String(1 + (index % 12)).padStart(2, '0')}${String(1 + (index % 28)).padStart(2, '0')}T090000`,
          `DTEND;TZID=Custom/Crowded:2026${String(1 + (index % 12)).padStart(2, '0')}${String(1 + (index % 28)).padStart(2, '0')}T100000`,
        ),
      ).flat(),
    );
    const { ms, error } = timed(() => parseICalendarChanges(text, 'UTC', WINDOW));
    expect(error).toBeNull();
    expect(ms).toBeLessThan(1_000);
  }, 600_000);

  it("still reads a feed's own zone across far years as Intl reads the same zone", () => {
    const london = [
      'BEGIN:VTIMEZONE',
      'TZID:Custom/London',
      'BEGIN:DAYLIGHT',
      'DTSTART:19810329T010000',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:19961027T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
    ];
    // Each year past the last one read makes ical.js expand the zone again.
    const days = ['20270115', '20270715', '20400115', '20400715', '20600715', '20901101'];
    const text = calendar(
      ...london,
      ...days.flatMap((day) =>
        event(
          `UID:day-${day}`,
          `DTSTART;TZID=Custom/London:${day}T093000`,
          `DTEND;TZID=Custom/London:${day}T103000`,
        ),
      ),
    );
    const starts = parseICalendarChanges(text, 'UTC', {
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    }).map((change) => change.start?.toISOString());
    expect(starts).toEqual(
      days.map((day) =>
        zonedDateTimeToUtc(
          {
            year: Number(day.slice(0, 4)),
            month: Number(day.slice(4, 6)),
            day: Number(day.slice(6, 8)),
            hour: 9,
            minute: 30,
            second: 0,
          },
          'Europe/London',
        ).toISOString(),
      ),
    );
  });

  it('refuses a feed with its own zone if ical.js no longer expands zones as it is bounded', () => {
    const prototype = ICAL.Timezone.prototype as unknown as Record<string, unknown>;
    const ensure = prototype._ensureCoverage;
    prototype._ensureCoverage = undefined;
    try {
      // The event's times are UTC, so ical.js never reads the zone: only the bound refuses it.
      const text = calendar(
        'BEGIN:VTIMEZONE',
        'TZID:Custom/Plain',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0100',
        'END:STANDARD',
        'END:VTIMEZONE',
        ...event('UID:zoned', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z'),
      );
      expect(() => parseICalendarChanges(text, 'UTC', WINDOW)).toThrow(CalendarContractError);
    } finally {
      prototype._ensureCoverage = ensure;
    }
  });

  // ical.js reads a property's parameters by searching from each one to the end of the line for
  // its value: 490,000 of them on one line took 7.9 seconds before anything else ran.
  it.each(parsers)(
    'refuses %s a property with more parameters than any real one',
    (_name, parse) => {
      const text = calendar(
        ...event(
          'UID:parameters',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          `X-A${';A=b'.repeat(490_000)}:v`,
        ),
      );
      expect(text.length).toBeLessThan(2_000_000);
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'refuses %s many properties each with more parameters than any real one, within 8 KB',
    (_name, parse) => {
      // Each line is short enough, but its cost is its parameters times its length.
      const crowded = Array.from({ length: 240 }, () => `X-A${';A=b'.repeat(1_000)}:v`);
      const text = calendar(
        ...event('UID:crowded', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', ...crowded),
      );
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'counts %s the parameters past a quoted `:`, which does not end them',
    (_name, parse) => {
      const text = calendar(
        ...event(
          'UID:quoted',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          `X-A;B="x:y"${';A=b'.repeat(450_000)}:v`,
        ),
      );
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'counts %s the parameters of a folded line as one line',
    (_name, parse) => {
      // ical.js joins the folded line before it reads the parameters.
      const line = `X-A${';A=b'.repeat(450_000)}:v`;
      const folded = line.match(/.{1,74}/g)?.join('\r\n ') ?? line;
      const text = calendar(
        ...event('UID:folded', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', folded),
      );
      expect(text.length).toBeLessThan(2_000_000);
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)('refuses %s a property whose parameters run past 8 KB', (_name, parse) => {
    const text = calendar(
      ...event(
        'UID:long',
        'DTSTART:20261102T090000Z',
        'DTEND:20261102T100000Z',
        `X-A;A="${'b'.repeat(9_000)}":v`,
      ),
    );
    const { error } = timed(() => parse(text));
    expect(error).toBeInstanceOf(CalendarExpansionLimitError);
  });

  it.each(parsers)('still reads %s an attendee with many parameters, folded', (_name, parse) => {
    const members = Array.from({ length: 60 }, (_, index) => `"mailto:crew${index}@example.com"`);
    const attendee =
      'ATTENDEE;CN="Depot crew";CUTYPE=GROUP;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE;LANGUAGE=en;X-NUM-GUESTS=0:mailto:crew@example.com';
    // Quoted values hold `:` and `;`, which do not end the parameters.
    const group = `X-DEPOT-GROUP;X-NOTE="crew; all shifts";MEMBER=${members.join(',')}:crew`;
    // Folded every 74 characters, as calendar servers write long lines.
    const fold = (line: string) => line.match(/.{1,74}/g)?.join('\r\n ') ?? line;
    const text = calendar(
      ...event(
        'UID:attendees',
        'DTSTART:20261102T090000Z',
        'DTEND:20261102T100000Z',
        'ORGANIZER;CN=Depot:mailto:depot@example.com',
        fold(attendee),
        fold(group),
      ),
    );
    expect(() => parse(text)).not.toThrow();
  });
});

/** mulberry32: the same sequence on every run. */
function seeded(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) % below;
  };
}

type ParamSet = { param: Record<string, { multiValue?: string }> };
const designSets = () =>
  [ICAL.design.icalendar, ICAL.design.vcard, ICAL.design.vcard3] as unknown as ParamSet[];

/** Count the parameters ical.js reads: it asks its design set about each one twice (`name in param`). */
function countingParameters<T>(work: (read: () => number) => T): T {
  let asked = 0;
  const sets = designSets();
  const originals = sets.map((set) => set.param);
  for (const set of sets) {
    set.param = new Proxy(set.param, {
      has(target, key) {
        asked += 1;
        return Reflect.has(target, key);
      },
    });
  }
  try {
    return work(() => asked / 2);
  } finally {
    sets.forEach((set, index) => {
      set.param = originals[index] as ParamSet['param'];
    });
  }
}

const LINE_PIECES = [
  ';',
  ':',
  '"',
  '=',
  ',',
  '","',
  'a',
  'mailto:b',
  'CN',
  'MEMBER',
  'DELEGATED-TO',
  'X-P',
  'TYPE',
  ';CN=',
  ';MEMBER="',
  ';DELEGATED-TO="',
  ';X-P=',
  ';TYPE="',
  '";',
  '":',
  '=",',
  ';CN="',
  'constructor',
  ';__proto__=',
  ';toString="',
  ';hasOwnProperty=',
  '\\',
  '^"',
  '^n',
];
const LINE_NAMES = ['X-A', 'ATTENDEE', 'X-A"', 'DESCRIPTION', 'X-A;', 'VERSION:4.0', 'TYPE'];
function randomLine(random: (below: number) => number): string {
  let line = LINE_NAMES[random(LINE_NAMES.length)] as string;
  const length = 1 + random(30);
  for (let piece = 0; piece < length; piece++) line += LINE_PIECES[random(LINE_PIECES.length)];
  return line;
}

describe('a property whose parameters ical.js reads differently from a simple scan (round 4)', () => {
  // ical.js opens a quoted parameter value only straight after `=`; any other `"` is a character.
  // A scan that turned every `"` into an open or close quote read the quoted `:` below as the end of
  // the parameters, while ical.js read all 490,000 of them: 7.9 to 9.1 seconds.
  const flood = ';R=b'.repeat(490_000);
  it.each(parsers)(
    'refuses %s parameters behind a quote inside a value',
    (_name, parse) => {
      const text = calendar(
        ...event(
          'UID:stray-quote',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          `X-A;P=a";Q="x:y"${flood}:v`,
        ),
      );
      expect(text.length).toBeLessThan(2_000_000);
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'refuses %s parameters behind a quote inside a name',
    (_name, parse) => {
      const text = calendar(
        ...event(
          'UID:quoted-name',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          `X-A";Q="x:y"${flood}:v`,
        ),
      );
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'refuses %s parameters behind a list of quoted values for a parameter that takes one',
    (_name, parse) => {
      // MEMBER takes several quoted values ("a","b"); CN takes one, so ical.js ends it at `"a"`.
      const text = calendar(
        ...event(
          'UID:one-value',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          `X-A;CN="a","b${flood}":v`,
        ),
      );
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeInstanceOf(CalendarExpansionLimitError);
      expect(ms).toBeLessThan(200);
    },
    600_000,
  );

  it.each(parsers)(
    'reads %s a feed whose every line is at the limits',
    (_name, parse) => {
      // 100 parameters, each searched from to the line's `:` 8 KB on, is what the limits allow.
      const line = `X-A${';A=b'.repeat(99)};A=${'b'.repeat(7_700)}:v`;
      const lines = Array.from({ length: 230 }, () => line);
      const text = calendar(
        ...event('UID:at-limits', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', ...lines),
      );
      expect(text.length).toBeGreaterThan(1_800_000);
      const { ms, error } = timed(() => parse(text));
      expect(error).toBeNull();
      expect(ms).toBeLessThan(500);
    },
    600_000,
  );

  it('counts the parameters ical.js reads, on lines built from what changes its reading', () => {
    const random = seeded(20261017);
    const params = (ICAL.design.icalendar as unknown as ParamSet).param;
    let withParameters = 0;
    countingParameters((read) => {
      for (let index = 0; index < 4_000; index++) {
        const line = randomLine(random);
        const before = read();
        try {
          ICAL.parse(`BEGIN:VCALENDAR\r\n${line}\r\nEND:VCALENDAR`);
        } catch {
          // ical.js refuses most of these lines; what it read before refusing is what is counted.
        }
        const parameters = read() - before;
        expect(icalendarPropertyHead(line, params).parameters, line).toBe(parameters);
        if (parameters > 1) withParameters += 1;
      }
    });
    expect(withParameters).toBeGreaterThan(500);
  });

  it('reads a whole feed line by line as ical.js does: its folds, breaks, roots and first BEGIN', () => {
    // ical.js's own lines and counts, as it hands each unfolded line to _handleContentLine.
    const parser = ICAL.parse as unknown as {
      _handleContentLine: (line: string, state: unknown) => void;
    };
    const handle = parser._handleContentLine;
    const random = seeded(17102026);
    const firsts = [
      'BEGIN:VCALENDAR',
      'BEGIN:VCARD',
      'begin:vcalendar',
      'BEGIN:',
      'BEGIN',
      'X;A=1',
      'BEGIN;X=1:VCALENDAR',
      '  BEGIN:VCALENDAR',
      '\r\n\r\nBEGIN:VEVENT',
      'VERSION:2.0',
      'BEGIN:VCARD3',
      'BEGIN:constructor',
    ];
    // Components that change ical.js's reading mid-feed, or look as if they might.
    const components = [
      'BEGIN:VCARD',
      'begin:vcard',
      'BEGIN:VCARD3',
      'BEGIN;X=1:VCARD',
      'BEGIN:VCARD;X',
      'VERSION:4.0',
      'FN:x',
      'END:VCARD',
      'BEGIN:VEVENT',
      'END:VEVENT',
    ];
    const breaks = ['\r\n', '\n', '\r\n\r\n', '\n\n', '\r\n \r\n'];
    const folds = ['\r\n ', '\n\t', '\r\n\t', '\r', ' '];
    let feeds = 0;
    let readToTheEnd = 0;
    let vcards = 0;
    countingParameters((read) => {
      for (let index = 0; index < 1_500; index++) {
        let text = firsts[random(firsts.length)] as string;
        const lines = 1 + random(8);
        for (let count = 0; count < lines; count++) {
          let line =
            random(4) === 0
              ? (components[random(components.length)] as string)
              : randomLine(random);
          for (let fold = random(4); fold > 0; fold--) {
            const at = random(line.length + 1);
            line = line.slice(0, at) + folds[random(folds.length)] + line.slice(at);
          }
          text += (breaks[random(breaks.length)] as string) + line;
        }
        if (random(2) === 0) text += '\r\nEND:VCALENDAR';
        const calls: { line: string; parameters: number }[] = [];
        parser._handleContentLine = (line, state) => {
          const before = read();
          try {
            handle(line, state);
          } finally {
            calls.push({ line, parameters: read() - before });
          }
        };
        let threw = false;
        try {
          ICAL.parse(text);
        } catch {
          threw = true;
        } finally {
          parser._handleContentLine = handle;
        }
        const ours = [...icalendarPropertyHeads(text)];
        // From a VCARD on, ical.js may read with vCard 3's parameters: Slotlock refuses the feed.
        const vcard = ours.findIndex((head) => head.begins === 'vcard');
        if (vcard !== -1) {
          vcards += 1;
          for (const [, parse] of parsers) {
            expect(() => parse(text), text).toThrow(CalendarContractError);
          }
        }
        for (const [at, call] of calls.entries()) {
          if (vcard !== -1 && at > vcard) break;
          const head = ours[at];
          if (head === undefined) {
            // Only a line before the first BEGIN, where ical.js throws having read nothing.
            expect(at, text).toBe(calls.length - 1);
            expect(ours.length, text).toBe(at);
            expect(call.parameters, text).toBe(0);
            continue;
          }
          expect(head.line, text).toBe(call.line);
          expect(head.parameters, text).toBe(call.parameters);
        }
        if (!threw && vcard === -1) {
          expect(ours.length, text).toBe(calls.length);
          readToTheEnd += 1;
        }
        feeds += 1;
      }
    });
    expect(feeds).toBe(1_500);
    expect(readToTheEnd).toBeGreaterThan(50);
    expect(vcards).toBeGreaterThan(50);
  });

  // Round 6: a VCARD anywhere in a feed moves ical.js to vCard 3's parameters for the rest of it,
  // where TYPE takes several quoted values. `TYPE="a",":"` then hid 490,000 parameters behind a
  // quoted `:` from a count made with iCalendar's: 7.7 to 24.7 seconds.
  const vcardFeeds = [
    [
      'nested in the calendar',
      ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VCARD', 'FN:x', 'END:VCARD'],
    ],
    [
      'between two calendars',
      ['BEGIN:VCALENDAR', 'END:VCALENDAR', 'BEGIN:VCARD', 'FN:x', 'END:VCARD', 'BEGIN:VCALENDAR'],
    ],
  ] as const;
  it.each(vcardFeeds)(
    'refuses a feed with a VCARD %s, whose reading changes',
    (_where, before) => {
      const flood = `X-A;TYPE="a",":"${';P=b'.repeat(490_000)}:v`;
      const text = [
        ...before,
        ...event('UID:vcard', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', flood),
        'END:VCALENDAR',
      ].join('\r\n');
      expect(text.length).toBeLessThan(2_000_000);
      for (const [, parse] of parsers) {
        const { ms, error } = timed(() => parse(text));
        expect(error).toBeInstanceOf(CalendarContractError);
        expect(ms).toBeLessThan(200);
      }
      // The refusal is what bounds it: ical.js reads all those parameters, the count only one.
      const small = text.replace(';P=b'.repeat(490_000), ';P=b'.repeat(300));
      const counted = [...icalendarPropertyHeads(small)].find((head) =>
        head.line.startsWith('X-A'),
      );
      expect(counted?.parameters).toBe(1);
      const read = countingParameters((parameters) => {
        try {
          ICAL.parse(small);
        } catch {
          // Only the parameters read matter here.
        }
        return parameters();
      });
      expect(read).toBeGreaterThanOrEqual(301);
    },
    120_000,
  );

  it.each([
    ['one line folded at every character', `X-A:${'a\r\n '.repeat(500_000)}`],
    ['290,000 short lines', 'X-A:b\r\n'.repeat(290_000)],
    ['one line of quotes', `X-A:${'"'.repeat(1_900_000)}`],
    ['one line of parameters that each open a quote', `X-A${';A="'.repeat(500_000)}:v`],
  ])(
    'reads %s within its time, the line reading itself in a fraction of it',
    (_name, body) => {
      const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
      expect(text.length).toBeLessThan(2_100_000);
      const scan = timed(() => {
        // The feed's own limits, as boundPropertyHeads reads each line.
        for (const _head of icalendarPropertyHeads(text, { parameters: 100, end: 8_192 })) {
          // Read every line.
        }
      });
      expect(scan.error).toBeNull();
      expect(scan.ms).toBeLessThan(150);
      for (const [, parse] of parsers) expect(timed(() => parse(text)).ms).toBeLessThan(1_200);
    },
    60_000,
  );
});
