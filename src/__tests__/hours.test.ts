// The hours evaluator (RFC 0004 B1, B2): weekly hours with exceptions that replace whole local days,
// the nearest scope last; and the iCalendar forms closures travel in.
import { describe, expect, it } from 'vitest';
import { fetchHolidayCalendar, parseHolidayCalendar } from '../holidays.js';
import {
  applicableHours,
  coveredByOpenWindows,
  exceptionDays,
  exceptionRanges,
  openWindows,
  parseExceptionDays,
} from '../hours.js';
import { emitVAvailability, parseVAvailability } from '../interop.js';

const EVERY_DAY = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';
const NINE_TO_FIVE = [{ rrule: EVERY_DAY, startMinutes: 9 * 60, durationMinutes: 8 * 60 }];
const iso = (windows: { start: Date; end: Date }[]) => windows.map((w) => [w.start.toISOString(), w.end.toISOString()]);

describe('openWindows', () => {
  const window = { start: new Date('2027-03-01T00:00:00Z'), end: new Date('2027-03-04T00:00:00Z') };

  it('is the weekly hours without exceptions', () => {
    expect(iso(openWindows({ hours: NINE_TO_FIVE, timezone: 'UTC', window }))).toEqual([
      ['2027-03-01T09:00:00.000Z', '2027-03-01T17:00:00.000Z'],
      ['2027-03-02T09:00:00.000Z', '2027-03-02T17:00:00.000Z'],
      ['2027-03-03T09:00:00.000Z', '2027-03-03T17:00:00.000Z'],
    ]);
  });

  it('closes a day, and a nearer exception opens it again with its own hours', () => {
    const closed = { startsOn: '2027-03-02', endsOn: '2027-03-02', outcome: 'closed' as const, rank: 0 };
    const open = {
      startsOn: '2027-03-02',
      endsOn: '2027-03-03',
      outcome: 'open' as const,
      hours: [{ startMinutes: 600, durationMinutes: 60 }],
      rank: 999,
    };
    expect(iso(openWindows({ hours: NINE_TO_FIVE, exceptions: [closed], timezone: 'UTC', window }))).toEqual([
      ['2027-03-01T09:00:00.000Z', '2027-03-01T17:00:00.000Z'],
      ['2027-03-03T09:00:00.000Z', '2027-03-03T17:00:00.000Z'],
    ]);
    // Order given does not matter: rank does.
    expect(iso(openWindows({ hours: NINE_TO_FIVE, exceptions: [open, closed], timezone: 'UTC', window }))).toEqual([
      ['2027-03-01T09:00:00.000Z', '2027-03-01T17:00:00.000Z'],
      ['2027-03-02T10:00:00.000Z', '2027-03-02T11:00:00.000Z'],
      ['2027-03-03T10:00:00.000Z', '2027-03-03T11:00:00.000Z'],
    ]);
  });

  it('reads days in the resource zone, across a clock change', () => {
    // London moves to summer time on 28 March 2027: the day is 23 hours long.
    const spring = { start: new Date('2027-03-27T00:00:00Z'), end: new Date('2027-03-30T00:00:00Z') };
    const closed = { startsOn: '2027-03-28', endsOn: '2027-03-28', outcome: 'closed' as const, rank: 0 };
    const allDay = [{ rrule: EVERY_DAY, startMinutes: 0, durationMinutes: 1_440 }];
    expect(iso(openWindows({ hours: allDay, exceptions: [closed], timezone: 'Europe/London', window: spring }))).toEqual([
      ['2027-03-27T00:00:00.000Z', '2027-03-28T00:00:00.000Z'],
      ['2027-03-28T23:00:00.000Z', '2027-03-30T00:00:00.000Z'],
    ]);
  });

  it('cuts an overnight window at the closed day, and an open day may run past midnight', () => {
    const night = [{ rrule: EVERY_DAY, startMinutes: 22 * 60, durationMinutes: 4 * 60 }];
    const closed = { startsOn: '2027-03-02', endsOn: '2027-03-02', outcome: 'closed' as const, rank: 0 };
    expect(iso(openWindows({ hours: night, exceptions: [closed], timezone: 'UTC', window }))).toEqual([
      ['2027-03-01T00:00:00.000Z', '2027-03-01T02:00:00.000Z'],
      ['2027-03-01T22:00:00.000Z', '2027-03-02T00:00:00.000Z'],
      ['2027-03-03T00:00:00.000Z', '2027-03-03T02:00:00.000Z'],
      ['2027-03-03T22:00:00.000Z', '2027-03-04T00:00:00.000Z'],
    ]);
  });

  it('judges whether an interval lies inside', () => {
    const open = openWindows({ hours: NINE_TO_FIVE, timezone: 'UTC', window });
    expect(coveredByOpenWindows(open, { start: new Date('2027-03-01T09:00:00Z'), end: new Date('2027-03-01T17:00:00Z') })).toBe(true);
    expect(coveredByOpenWindows(open, { start: new Date('2027-03-01T16:00:00Z'), end: new Date('2027-03-01T18:00:00Z') })).toBe(false);
  });
});

describe('hours that apply', () => {
  it('are the resource own, else inherited, else the server', () => {
    expect(applicableHours({ availabilityRules: [] }, NINE_TO_FIVE)).toEqual({ rules: [], source: 'resource' });
    expect(
      applicableHours({ inheritedAvailability: { source: 'location', location: 'depot', rules: NINE_TO_FIVE } }, []),
    ).toEqual({ rules: NINE_TO_FIVE, source: 'location', location: 'depot' });
    expect(applicableHours({}, NINE_TO_FIVE)).toEqual({ rules: NINE_TO_FIVE, source: 'server' });
  });
});

describe('exception days', () => {
  it('refuses what is not a range of real days, and hours exactly when open', () => {
    expect(() => parseExceptionDays({ startsOn: '2027-02-29', outcome: 'closed' })).toThrow(/real days/);
    expect(() => parseExceptionDays({ startsOn: '2027-03-02', endsOn: '2027-03-01', outcome: 'closed' })).toThrow(/before/);
    expect(() => parseExceptionDays({ startsOn: '2027-01-01', endsOn: '2028-01-03', outcome: 'closed' })).toThrow(/367/);
    expect(() => parseExceptionDays({ startsOn: '2027-03-02', outcome: 'open' })).toThrow(/windows/);
    expect(() =>
      parseExceptionDays({ startsOn: '2027-03-02', outcome: 'closed', hours: [{ startMinutes: 0, durationMinutes: 60 }] }),
    ).toThrow(/no hours/);
    expect(parseExceptionDays({ startsOn: '2028-02-29', outcome: 'closed' })).toEqual({
      startsOn: '2028-02-29',
      endsOn: '2028-02-29',
      outcome: 'closed',
    });
  });

  it('resolve by rank day by day, and group back into ranges', () => {
    const days = exceptionDays(
      [
        { startsOn: '2027-12-24', endsOn: '2027-12-27', outcome: 'closed', rank: 0 },
        { startsOn: '2027-12-24', endsOn: '2027-12-24', outcome: 'open', hours: [{ startMinutes: 540, durationMinutes: 180 }], rank: 1000 },
      ],
      '2027-12-01',
      '2027-12-26',
    );
    expect(days).toEqual([
      { date: '2027-12-24', windows: [{ startMinutes: 540, durationMinutes: 180 }] },
      { date: '2027-12-25', windows: [] },
      { date: '2027-12-26', windows: [] },
    ]);
    expect(exceptionRanges(days)).toEqual([
      { startsOn: '2027-12-24', endsOn: '2027-12-24', outcome: 'open', hours: [{ startMinutes: 540, durationMinutes: 180 }] },
      { startsOn: '2027-12-25', endsOn: '2027-12-26', outcome: 'closed' },
    ]);
  });
});

describe('VAVAILABILITY with RDATE and EXDATE', () => {
  const weekdays = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 }];

  it('round-trips closed and special days', () => {
    const days = [
      { date: '2027-12-24', windows: [{ startMinutes: 540, durationMinutes: 180 }] },
      { date: '2027-12-25', windows: [] },
      { date: '2027-12-31', windows: [{ startMinutes: 540, durationMinutes: 180 }] },
    ];
    const text = emitVAvailability({ rules: weekdays, timezone: 'Europe/London', uid: 'r', days });
    // The 25th is a Saturday: no weekday window to take off, and it stays as the week says.
    expect(text).toContain('EXDATE;TZID=Europe/London:20271224T090000,20271231T090000\r\n');
    expect(text).toContain('RDATE;TZID=Europe/London:20271231T090000\r\n');
    const parsed = parseVAvailability(text);
    expect(parsed.rules).toEqual(weekdays);
    expect(parsed.days).toEqual([days[0], days[2]]);
  });

  it('reads a single AVAILABLE and an RDATE period as days of their own', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//t//EN',
      'BEGIN:VAVAILABILITY',
      'UID:v',
      'DTSTAMP:20270101T000000Z',
      'BEGIN:AVAILABLE',
      'UID:v-1',
      'DTSTAMP:20270101T000000Z',
      'DTSTART;TZID=UTC:20270102T100000',
      'DTEND;TZID=UTC:20270102T120000',
      'RDATE;VALUE=PERIOD;TZID=UTC:20270109T080000/PT30M',
      'END:AVAILABLE',
      'END:VAVAILABILITY',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    expect(parseVAvailability(text)).toEqual({
      timezone: 'UTC',
      rules: [],
      days: [
        { date: '2027-01-02', windows: [{ startMinutes: 600, durationMinutes: 120 }] },
        { date: '2027-01-09', windows: [{ startMinutes: 480, durationMinutes: 30 }] },
      ],
    });
  });

  it('refuses an EXDATE at another time than its window', () => {
    const text = emitVAvailability({ rules: weekdays, timezone: 'UTC', uid: 'r' }).replace(
      'END:AVAILABLE',
      'EXDATE;TZID=UTC:20271224T100000\r\nEND:AVAILABLE',
    );
    expect(() => parseVAvailability(text)).toThrow(/EXDATE at another time/);
  });
});

describe('holiday calendars', () => {
  const calendar = (...events: string[]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');

  it('closes all-day events and each occurrence in the span, skipping timed and cancelled ones', () => {
    const parsed = parseHolidayCalendar(
      calendar(
        'BEGIN:VEVENT\r\nUID:may\r\nDTSTART;VALUE=DATE:20270503\r\nRRULE:FREQ=YEARLY;BYMONTH=5;BYDAY=1MO\r\nSUMMARY:Early May\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20271225\r\nDTEND;VALUE=DATE:20271227\r\nSUMMARY:Christmas\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:c\r\nDTSTART;VALUE=DATE:20270101\r\nSTATUS:CANCELLED\r\nSUMMARY:Off\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:t\r\nDTSTART:20270101T100000Z\r\nSUMMARY:Timed\r\nEND:VEVENT',
      ),
      { from: '2027-01-01', to: '2028-12-31' },
    );
    expect(parsed).toEqual({
      holidays: [
        { uid: 'may:2027-05-03', startsOn: '2027-05-03', endsOn: '2027-05-03', label: 'Early May' },
        { uid: 'may:2028-05-01', startsOn: '2028-05-01', endsOn: '2028-05-01', label: 'Early May' },
        { uid: 'x', startsOn: '2027-12-25', endsOn: '2027-12-26', label: 'Christmas' },
      ],
      skipped: 2,
    });
  });

  it('refuses text that is not a calendar', () => {
    expect(() => parseHolidayCalendar('hello', { from: '2027-01-01', to: '2027-12-31' })).toThrow(/not iCalendar/);
  });

  // ical.js steps a DAILY rule day by day until it finds a day of the month that may never come, and
  // never returns: 129 bytes held a server for good. Such rules, and rules more often than daily, are
  // refused before they are expanded.
  it('refuses at once a rule ical.js would follow forever, or one more often than daily', () => {
    const span = { from: '2027-01-01', to: '2028-12-31' };
    for (const rule of [
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=DAILY;INTERVAL=2;BYMONTHDAY=31;BYMONTH=6',
      'FREQ=DAILY;BYDAY=MO;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=MINUTELY',
    ]) {
      const started = performance.now();
      expect(() =>
        parseHolidayCalendar(calendar(`BEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20270101\r\nRRULE:${rule}\r\nEND:VEVENT`), span),
      ).toThrow(expect.objectContaining({ code: 'invalid_holiday_calendar' }));
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    // Monthly and yearly rules, and daily ones on days of the week, are read as before.
    const read = parseHolidayCalendar(
      calendar(
        'BEGIN:VEVENT\r\nUID:t\r\nDTSTART;VALUE=DATE:20271125\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\r\nSUMMARY:Thanksgiving\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:f\r\nDTSTART;VALUE=DATE:20270129\r\nRRULE:FREQ=MONTHLY;BYDAY=5FR;COUNT=2\r\nSUMMARY:Fifth Friday\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:m\r\nDTSTART;VALUE=DATE:20270104\r\nRRULE:FREQ=DAILY;BYDAY=MO;COUNT=2\r\nSUMMARY:Mondays\r\nEND:VEVENT',
      ),
      span,
    );
    expect(read.holidays.map((holiday) => holiday.startsOn)).toEqual([
      '2027-11-25',
      '2028-11-23',
      '2027-01-29',
      '2027-04-30',
      '2027-01-04',
      '2027-01-11',
    ]);
  });

  it('reads a calendar of many events in time, and refuses one that repeats too much to read', () => {
    const span = { from: '2027-01-01', to: '2027-12-31' };
    const many = Array.from(
      { length: 15_000 },
      (_, index) => `BEGIN:VEVENT\r\nUID:e${index}\r\nDTSTART:20270101T100000Z\r\nEND:VEVENT`,
    );
    let started = performance.now();
    // Each event once: ical.js looked through every event for each one (13 seconds for these).
    expect(parseHolidayCalendar(calendar(...many), span).skipped).toBe(15_000);
    expect(performance.now() - started).toBeLessThan(5_000);
    // Weekly series from 1900, each stepping thousands of times before the span.
    const old = Array.from(
      { length: 100 },
      (_, index) => `BEGIN:VEVENT\r\nUID:w${index}\r\nDTSTART;VALUE=DATE:19000101\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT`,
    );
    started = performance.now();
    expect(() => parseHolidayCalendar(calendar(...old), span)).toThrow(/repeats too much/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  // A YEARLY rule that never occurs made ical.js walk every year to 20000 while it built the
  // iterator, before the first occurrence the step caps counted: 3.5 seconds for each 150-byte
  // event, and hours for a megabyte of them, on the thread serving every tenant. Building and
  // stepping are now charged to one budget for the whole calendar.
  it('refuses in bounded time a calendar whose rules ical.js would search for years', () => {
    const span = { from: '2027-01-01', to: '2028-12-31' };
    const never = (uid: string) =>
      `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:20000101\r\nSUMMARY:x\r\nRRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYMONTH=2;BYMONTHDAY=30,31\r\nEND:VEVENT`;
    const refusedQuickly = (text: string, message: RegExp) => {
      const started = performance.now();
      expect(() => parseHolidayCalendar(text, span)).toThrow(
        expect.objectContaining({ code: 'invalid_holiday_calendar', message: expect.stringMatching(message) }),
      );
      expect(performance.now() - started).toBeLessThan(2_000);
    };
    refusedQuickly(calendar(never('a'), never('b'), never('c'), never('d')), /repeats too much/);
    // The same rule in a time zone the calendar defines, expanded when an exception is compared.
    refusedQuickly(
      calendar(
        'BEGIN:VTIMEZONE\r\nTZID:Own\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0000\r\nRRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYMONTH=2;BYMONTHDAY=30,31\r\nEND:STANDARD\r\nEND:VTIMEZONE',
        'BEGIN:VEVENT\r\nUID:z\r\nDTSTART;VALUE=DATE:20270101\r\nRRULE:FREQ=YEARLY;COUNT=2\r\nEXDATE;TZID=Own:20280101T000000\r\nEND:VEVENT',
      ),
      /repeats too much/,
    );
    // ical.js adds a DURATION a month at a time, and sorts each EXDATE in as it reads it.
    refusedQuickly(
      calendar('BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20270101\r\nDURATION:P99999999W\r\nEND:VEVENT'),
      /too much work/,
    );
    const days = Array.from({ length: 1_001 }, (_, day) => new Date(Date.UTC(2030, 0, 1 + day)).toISOString().slice(0, 10).replace(/-/g, ''));
    refusedQuickly(
      calendar(`BEGIN:VEVENT\r\nUID:e\r\nDTSTART;VALUE=DATE:20270101\r\nRRULE:FREQ=YEARLY\r\nEXDATE;VALUE=DATE:${days.join(',')}\r\nEND:VEVENT`),
      /too much work/,
    );
    // A thousand recurring events at most: each costs ical.js work the budget does not see.
    const cheap = Array.from(
      { length: 1_001 },
      (_, index) => `BEGIN:VEVENT\r\nUID:r${index}\r\nDTSTART;VALUE=DATE:20200101\r\nRRULE:FREQ=YEARLY;COUNT=1\r\nEND:VEVENT`,
    );
    refusedQuickly(calendar(...cheap), /more than 1000 recurring events/);
    expect(parseHolidayCalendar(calendar(...cheap.slice(1)), span).holidays).toEqual([]);
  });

  // The dashboard Worker passes its runtime's fetch, which checks no address: the URL itself is
  // checked whatever fetch is given.
  it('refuses a calendar URL naming this machine or a private network, before any fetch', async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    }) as typeof fetch;
    for (const url of [
      'https://127.0.0.1/h.ics',
      'https://127.1/h.ics',
      'https://0x7f000001/h.ics',
      'https://10.0.0.1/h.ics',
      'https://192.168.1.1/h.ics',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/h.ics',
      'https://[::1]/h.ics',
      'https://[fe80::1]/h.ics',
      'https://[fd00::1]/h.ics',
      'https://[::ffff:127.0.0.1]/h.ics',
      'https://localhost/h.ics',
      'https://LOCALHOST./h.ics',
      'https://calendar.localhost/h.ics',
    ]) {
      await expect(fetchHolidayCalendar(fetcher, url), url).rejects.toMatchObject({
        code: 'invalid_holiday_calendar',
        message: 'The calendar URL names a private address',
      });
    }
    expect(asked).toEqual([]);
    await expect(fetchHolidayCalendar(fetcher, 'https://203.0.113.9/h.ics')).resolves.toContain('VCALENDAR');
    await expect(fetchHolidayCalendar(fetcher, 'https://calendar.example.com/h.ics')).resolves.toContain('VCALENDAR');
    expect(asked).toEqual(['https://203.0.113.9/h.ics', 'https://calendar.example.com/h.ics']);
  });

  // Outlook writes its zones from 1601 and its holidays as yearly rules from long ago: within the
  // budget, read as before.
  it('reads a calendar of yearly rules from 1970 in a zone it defines', () => {
    const zone = [
      'BEGIN:VTIMEZONE',
      'TZID:GMT Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16011028T020000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0000',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010325T010000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0100',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ].join('\r\n');
    const rules = [
      ['new-year', 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1', 'New Year'],
      ['early-may', 'FREQ=YEARLY;BYMONTH=5;BYDAY=1MO', 'Early May'],
      ['spring', 'FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO', 'Spring'],
      ['summer', 'FREQ=YEARLY;BYMONTH=8;BYDAY=-1MO', 'Summer'],
      ['christmas', 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', 'Christmas'],
    ];
    const events = rules.map(
      ([uid, rule, summary]) =>
        `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=GMT Standard Time;VALUE=DATE:19700101\r\nRRULE:${rule}\r\nEXDATE;TZID=GMT Standard Time:19990101T000000\r\nSUMMARY:${summary}\r\nEND:VEVENT`,
    );
    const read = parseHolidayCalendar(calendar(zone, ...events), { from: '2027-01-01', to: '2028-12-31' });
    expect(read.holidays.map((holiday) => `${holiday.label} ${holiday.startsOn}`)).toEqual([
      'New Year 2027-01-01',
      'New Year 2028-01-01',
      'Early May 2027-05-03',
      'Early May 2028-05-01',
      'Spring 2027-05-31',
      'Spring 2028-05-29',
      'Summer 2027-08-30',
      'Summer 2028-08-28',
      'Christmas 2027-12-25',
      'Christmas 2028-12-25',
    ]);
  });
});
