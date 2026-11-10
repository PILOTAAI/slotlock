// The hours evaluator (RFC 0004 B1, B2): weekly hours with exceptions that replace whole local days,
// the nearest scope last; and the iCalendar forms closures travel in.
import { describe, expect, it } from 'vitest';
import { parseHolidayCalendar } from '../holidays.js';
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
});
