// Recurrence rules ical.js 2.2.1 expands wrongly are refused (ENG-4), on every path: the agent's
// validator, a stored event, the trusted importer, and per series in a feed. Every rule Slotlock
// still accepts expands as RFC 5545 §3.3.10 says: the RFC's own §3.8.5.3 examples, and random rules
// of every accepted shape against a brute-force oracle (helpers/rrule-oracle.ts) that the same
// examples check first.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  expandCalendarEventOccurrences,
  isBookableRecurrenceRule,
  parseICalendarChanges,
  parseICalendarFeed,
  parseTrustedICalendarEvents,
  recurrenceRuleProblem,
} from '../sync.js';
import { oracleOccurrences } from './helpers/rrule-oracle.js';

const DAY = 86_400_000;
const NY = 'America/New_York';
const stamp = (ms: number) => `${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
const frame = (text: string) =>
  Date.UTC(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8)),
    Number(text.slice(9, 11)),
    Number(text.slice(11, 13)),
    Number(text.slice(13, 15)),
  );
/** `YYYY-MM-DDTHH:MM` of a UTC frame. */
const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const nyWall = (instant: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: NY,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const days = (from: string, to: string, step = 1, time = '09:00') => {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += step * DAY
  ) {
    out.push(`${new Date(t).toISOString().slice(0, 10)}T${time}`);
  }
  return out;
};
const at = (date: string, ...list: number[]) =>
  list.map((day) => `${date}-${String(day).padStart(2, '0')}T09:00`);

interface Example {
  name: string;
  /** DTSTART as written, in New York (or floating, for `utc`). */
  start: string;
  rule: string;
  /** The RFC's listing, as New York wall times; for an endless rule, the part up to `until`. */
  expected: string[];
  /** Where the listing stops (exclusive), for an endless rule. */
  until?: string;
  exdate?: string;
  /** Read in UTC: the sub-daily examples, whose listings are wall times whatever the zone. */
  utc?: boolean;
}

// RFC 5545 §3.8.5.3, "Examples" (rfc-editor.org/rfc/rfc5545.txt, fetched 2026-10-24, sha256
// c256f809...cbfcb). The Monday of week 20 example is left out: Slotlock refuses BYWEEKNO.
const EXAMPLES: Example[] = [
  {
    name: 'daily for 10',
    start: '19970902T090000',
    rule: 'FREQ=DAILY;COUNT=10',
    expected: days('1997-09-02', '1997-09-11'),
  },
  {
    name: 'daily until 1997-12-24',
    start: '19970902T090000',
    rule: 'FREQ=DAILY;UNTIL=19971224T000000Z',
    expected: days('1997-09-02', '1997-12-23'),
  },
  {
    name: 'every other day',
    start: '19970902T090000',
    rule: 'FREQ=DAILY;INTERVAL=2',
    expected: days('1997-09-02', '1997-12-31', 2),
    until: '19980101T000000',
  },
  {
    name: 'every 10 days, 5',
    start: '19970902T090000',
    rule: 'FREQ=DAILY;INTERVAL=10;COUNT=5',
    expected: [...at('1997-09', 2, 12, 22), ...at('1997-10', 2, 12)],
  },
  {
    name: 'every day in January (yearly)',
    start: '19980101T090000',
    rule: 'FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA',
    expected: days('1998-01-01', '1998-01-31'),
    until: '19980201T000000',
  },
  {
    name: 'every day in January (daily)',
    start: '19980101T090000',
    rule: 'FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1',
    expected: days('1998-01-01', '1998-01-31'),
    until: '19980201T000000',
  },
  {
    name: 'weekly for 10',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;COUNT=10',
    expected: days('1997-09-02', '1997-11-04', 7),
  },
  {
    name: 'weekly until 1997-12-24',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;UNTIL=19971224T000000Z',
    expected: days('1997-09-02', '1997-12-23', 7),
  },
  {
    name: 'every other week',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;INTERVAL=2;WKST=SU',
    expected: days('1997-09-02', '1998-02-17', 14),
    until: '19980218T000000',
  },
  {
    name: 'Tuesday and Thursday for five weeks (until)',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH',
    expected: [...at('1997-09', 2, 4, 9, 11, 16, 18, 23, 25, 30), ...at('1997-10', 2)],
  },
  {
    name: 'Tuesday and Thursday for five weeks (count)',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH',
    expected: [...at('1997-09', 2, 4, 9, 11, 16, 18, 23, 25, 30), ...at('1997-10', 2)],
  },
  {
    name: 'every other week on MO,WE,FR',
    start: '19970901T090000',
    rule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR',
    expected: [
      ...at('1997-09', 1, 3, 5, 15, 17, 19, 29),
      ...at('1997-10', 1, 3, 13, 15, 17, 27, 29, 31),
      ...at('1997-11', 10, 12, 14, 24, 26, 28),
      ...at('1997-12', 8, 10, 12, 22),
    ],
  },
  {
    name: 'every other week on TU,TH for 8',
    start: '19970902T090000',
    rule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH',
    expected: [...at('1997-09', 2, 4, 16, 18, 30), ...at('1997-10', 2, 14, 16)],
  },
  {
    name: 'first Friday for 10',
    start: '19970905T090000',
    rule: 'FREQ=MONTHLY;COUNT=10;BYDAY=1FR',
    expected: [
      ...at('1997-09', 5),
      ...at('1997-10', 3),
      ...at('1997-11', 7),
      ...at('1997-12', 5),
      ...at('1998-01', 2),
      ...at('1998-02', 6),
      ...at('1998-03', 6),
      ...at('1998-04', 3),
      ...at('1998-05', 1),
      ...at('1998-06', 5),
    ],
  },
  {
    name: 'first Friday until 1997-12-24',
    start: '19970905T090000',
    rule: 'FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR',
    expected: [...at('1997-09', 5), ...at('1997-10', 3), ...at('1997-11', 7), ...at('1997-12', 5)],
  },
  {
    name: 'every other month, first and last Sunday',
    start: '19970907T090000',
    rule: 'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU',
    expected: [
      ...at('1997-09', 7, 28),
      ...at('1997-11', 2, 30),
      ...at('1998-01', 4, 25),
      ...at('1998-03', 1, 29),
      ...at('1998-05', 3, 31),
    ],
  },
  {
    name: 'second-to-last Monday for 6',
    start: '19970922T090000',
    rule: 'FREQ=MONTHLY;COUNT=6;BYDAY=-2MO',
    expected: [
      ...at('1997-09', 22),
      ...at('1997-10', 20),
      ...at('1997-11', 17),
      ...at('1997-12', 22),
      ...at('1998-01', 19),
      ...at('1998-02', 16),
    ],
  },
  {
    name: 'third-to-last day',
    start: '19970928T090000',
    rule: 'FREQ=MONTHLY;BYMONTHDAY=-3',
    expected: [
      ...at('1997-09', 28),
      ...at('1997-10', 29),
      ...at('1997-11', 28),
      ...at('1997-12', 29),
      ...at('1998-01', 29),
      ...at('1998-02', 26),
    ],
    until: '19980301T000000',
  },
  {
    name: '2nd and 15th for 10',
    start: '19970902T090000',
    rule: 'FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15',
    expected: [
      ...at('1997-09', 2, 15),
      ...at('1997-10', 2, 15),
      ...at('1997-11', 2, 15),
      ...at('1997-12', 2, 15),
      ...at('1998-01', 2, 15),
    ],
  },
  {
    name: 'first and last day for 10',
    start: '19970930T090000',
    rule: 'FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1',
    expected: [
      ...at('1997-09', 30),
      ...at('1997-10', 1, 31),
      ...at('1997-11', 1, 30),
      ...at('1997-12', 1, 31),
      ...at('1998-01', 1, 31),
      ...at('1998-02', 1),
    ],
  },
  {
    name: 'every 18 months, 10th-15th',
    start: '19970910T090000',
    rule: 'FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15',
    expected: at('1997-09', 10, 11, 12, 13, 14, 15),
    until: '19980901T000000',
  },
  {
    name: 'every Tuesday, every other month',
    start: '19970902T090000',
    rule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=TU',
    expected: [
      ...at('1997-09', 2, 9, 16, 23, 30),
      ...at('1997-11', 4, 11, 18, 25),
      ...at('1998-01', 6, 13, 20, 27),
      ...at('1998-03', 3, 10, 17, 24, 31),
    ],
    until: '19980401T000000',
  },
  {
    name: 'June and July for 10',
    start: '19970610T090000',
    rule: 'FREQ=YEARLY;COUNT=10;BYMONTH=6,7',
    expected: [...at('1997-06', 10), ...at('1997-07', 10), ...at('1998-06', 10)],
    until: '19980611T000000',
  },
  {
    name: 'every other year, Jan-Mar',
    start: '19970310T090000',
    rule: 'FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3',
    expected: [...at('1997-03', 10), ...at('1999-01', 10), ...at('1999-02', 10)],
    until: '19990301T000000',
  },
  {
    name: 'every third year, days 1, 100, 200',
    start: '19970101T090000',
    rule: 'FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200',
    expected: [...at('1997-01', 1), ...at('1997-04', 10), ...at('1997-07', 19)],
    until: '19980101T000000',
  },
  {
    name: 'every 20th Monday',
    start: '19970519T090000',
    rule: 'FREQ=YEARLY;BYDAY=20MO',
    expected: [...at('1997-05', 19), ...at('1998-05', 18)],
    until: '19980519T000000',
  },
  {
    name: 'every Thursday in March',
    start: '19970313T090000',
    rule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=TH',
    expected: [...at('1997-03', 13, 20, 27), ...at('1998-03', 5, 12)],
    until: '19980313T000000',
  },
  {
    name: 'every Thursday in June-August',
    start: '19970605T090000',
    rule: 'FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8',
    expected: [
      ...at('1997-06', 5, 12, 19, 26),
      ...at('1997-07', 3, 10, 17, 24, 31),
      ...at('1997-08', 7, 14, 21, 28),
      ...at('1998-06', 4),
    ],
    until: '19980605T000000',
  },
  {
    name: 'Friday the 13th',
    start: '19970902T090000',
    rule: 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
    exdate: '19970902T090000',
    expected: [...at('1998-02', 13), ...at('1998-03', 13)],
    until: '19980901T000000',
  },
  {
    name: 'first Saturday after the first Sunday',
    start: '19970913T090000',
    rule: 'FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13',
    expected: [
      ...at('1997-09', 13),
      ...at('1997-10', 11),
      ...at('1997-11', 8),
      ...at('1997-12', 13),
      ...at('1998-01', 10),
      ...at('1998-02', 7),
      ...at('1998-03', 7),
      ...at('1998-04', 11),
      ...at('1998-05', 9),
      ...at('1998-06', 13),
    ],
    until: '19980701T000000',
  },
  {
    name: 'US presidential election day',
    start: '19961105T090000',
    rule: 'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8',
    expected: at('1996-11', 5),
    until: '19971105T000000',
  },
  {
    name: 'third TU/WE/TH for 3 months',
    start: '19970904T090000',
    rule: 'FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3',
    expected: [...at('1997-09', 4), ...at('1997-10', 7), ...at('1997-11', 6)],
  },
  {
    name: 'second-to-last weekday',
    start: '19970929T090000',
    rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2',
    expected: [
      ...at('1997-09', 29),
      ...at('1997-10', 30),
      ...at('1997-11', 27),
      ...at('1997-12', 30),
      ...at('1998-01', 29),
      ...at('1998-02', 26),
      ...at('1998-03', 30),
    ],
    until: '19980401T000000',
  },
  {
    name: 'every 3 hours, 09:00-17:00',
    start: '19970902T090000',
    rule: 'FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z',
    utc: true,
    expected: ['1997-09-02T09:00', '1997-09-02T12:00', '1997-09-02T15:00'],
  },
  {
    name: 'every 15 minutes for 6',
    start: '19970902T090000',
    rule: 'FREQ=MINUTELY;INTERVAL=15;COUNT=6',
    utc: true,
    expected: ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15'].map((t) => `1997-09-02T${t}`),
  },
  {
    name: 'every hour and a half for 4',
    start: '19970902T090000',
    rule: 'FREQ=MINUTELY;INTERVAL=90;COUNT=4',
    utc: true,
    expected: ['09:00', '10:30', '12:00', '13:30'].map((t) => `1997-09-02T${t}`),
  },
  {
    name: 'every 20 minutes 9-16:40 (daily)',
    start: '19970902T090000',
    rule: 'FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40',
    utc: true,
    expected: twentyMinutes(),
    until: '19970904T000000',
  },
  {
    name: 'every 20 minutes 9-16:40 (minutely)',
    start: '19970902T090000',
    rule: 'FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16',
    utc: true,
    expected: twentyMinutes(),
    until: '19970904T000000',
  },
  {
    name: 'WKST=MO',
    start: '19970805T090000',
    rule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO',
    expected: at('1997-08', 5, 10, 19, 24),
  },
  {
    name: 'WKST=SU',
    start: '19970805T090000',
    rule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU',
    expected: at('1997-08', 5, 17, 19, 31),
  },
  {
    name: 'February 30 ignored',
    start: '20070115T090000',
    rule: 'FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5',
    expected: [...at('2007-01', 15, 30), ...at('2007-02', 15), ...at('2007-03', 15, 30)],
  },
];

function twentyMinutes(): string[] {
  const out: string[] = [];
  for (const date of ['1997-09-02', '1997-09-03']) {
    for (let hour = 9; hour <= 16; hour++) {
      for (const minute of ['00', '20', '40'])
        out.push(`${date}T${String(hour).padStart(2, '0')}:${minute}`);
    }
  }
  return out;
}

const feed = (start: string, rule: string, zone: string | null, ...extra: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    'UID:r',
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:r',
    zone ? `DTSTART;TZID=${zone}:${start}` : `DTSTART:${start}Z`,
    'DURATION:PT1M',
    `RRULE:${rule}`,
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

/** The rules ical.js 2.2.1 gets wrong, with the shape Slotlock names for each. */
const MIS_EXPANDED = [
  'FREQ=MONTHLY;BYMONTH=10,3;BYDAY=SU',
  'FREQ=MONTHLY;BYMONTH=11,5;BYMONTHDAY=2,29,30',
  'FREQ=MONTHLY;BYMONTH=12,8;BYMONTHDAY=1,2',
  'FREQ=YEARLY;BYMONTHDAY=29,-1',
  'FREQ=DAILY;BYMONTHDAY=-2,31',
  'FREQ=YEARLY;BYMONTHDAY=-1;BYDAY=TH',
  'FREQ=YEARLY;BYWEEKNO=20',
  'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO',
  'FREQ=YEARLY;BYDAY=20MO',
  'FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=1',
  'FREQ=HOURLY;INTERVAL=2;BYHOUR=8,9',
  'FREQ=MINUTELY;BYMINUTE=0,15',
  'FREQ=MINUTELY;BYSECOND=0,30',
  'FREQ=MONTHLY;BYHOUR=9,17',
  'FREQ=YEARLY;BYMONTH=6,12;BYHOUR=17;BYMINUTE=15,30',
  'FREQ=YEARLY;BYMONTH=2,3,6;BYYEARDAY=1,32',
  'FREQ=YEARLY;BYMONTHDAY=1,13,28;BYYEARDAY=32',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1,2;BYDAY=1WE,-1MO,3TH',
  'FREQ=YEARLY;BYMONTH=4,5;BYMONTHDAY=30,31;BYDAY=WE',
];

describe('the oracle', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))('reads RFC 5545 example: %s', (_name, e) => {
    const start = frame(e.start);
    const to = e.until ? frame(e.until) : start + 3_000 * DAY;
    let got = oracleOccurrences(e.rule, start, to);
    if (e.exdate) got = got.filter((t) => t !== frame(e.exdate as string));
    expect(got.map(wall)).toEqual(e.expected);
  });
});

describe('Slotlock and the RFC 5545 §3.8.5.3 examples', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    '%s: expanded as listed, or refused',
    (_name, e) => {
      const start = frame(e.start);
      const window = {
        start: new Date(start - DAY),
        end: new Date(
          Math.min(e.until ? frame(e.until) : Number.POSITIVE_INFINITY, start + 366 * DAY),
        ),
      };
      const extra = e.exdate
        ? [e.utc ? `EXDATE:${e.exdate}Z` : `EXDATE;TZID=${NY}:${e.exdate}`]
        : [];
      const text = feed(e.start, e.rule, e.utc ? null : NY, ...extra);
      if (recurrenceRuleProblem(e.rule) !== null) {
        expect(() => parseICalendarChanges(text, undefined, window)).toThrow(CalendarContractError);
        return;
      }
      const got = parseICalendarChanges(text, undefined, window).map((change) =>
        e.utc ? wall((change.start as Date).getTime()) : nyWall(change.start as Date),
      );
      const listed = e.expected.filter((t) => Date.parse(`${t}:00Z`) < window.end.getTime() + DAY);
      expect(got.slice(0, listed.length)).toEqual(listed);
    },
  );

  it('accepts all but the shapes ical.js gets wrong', () => {
    const refused = EXAMPLES.filter((e) => recurrenceRuleProblem(e.rule) !== null).map(
      (e) => e.name,
    );
    expect(refused).toEqual(['every 20th Monday']);
  });
});

describe('a shape ical.js 2.2.1 expands wrongly (ENG-4)', () => {
  it.each(MIS_EXPANDED)('%s is refused on every path, with its reason', (rule) => {
    expect(recurrenceRuleProblem(rule)).toMatch(/\S/);
    expect(isBookableRecurrenceRule(rule)).toBe(false);
    expect(() =>
      expandCalendarEventOccurrences(
        {
          start: new Date('2027-05-17T09:00:00Z'),
          end: new Date('2027-05-17T10:00:00Z'),
          timezone: 'UTC',
          summary: 'x',
          recurrence: { rrule: rule },
        },
        { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-12-31T00:00:00Z') },
      ),
    ).toThrow(CalendarContractError);
    const text = feed('20270517T090000', rule, null);
    expect(() => parseTrustedICalendarEvents(text)).toThrow(CalendarContractError);
    const window = {
      start: new Date('2027-01-01T00:00:00Z'),
      end: new Date('2027-12-31T00:00:00Z'),
    };
    expect(parseICalendarFeed(text, undefined, window)).toEqual({
      changes: [],
      refused: [{ uid: 'r', code: 'invalid_icalendar' }],
    });
  });
});

/** A rule of a shape Slotlock accepts, with a DTSTART the rule itself produces. */
const acceptedRule = fc
  .record({
    freq: fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'HOURLY', 'MINUTELY'),
    interval: fc.constantFrom(1, 1, 2, 3, 5),
    bymonth: fc.option(
      fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 4 }),
    ),
    bymonthday: fc.option(
      fc.uniqueArray(fc.constantFrom(1, 2, 13, 15, 28, 29, 30, 31, -1, -2, -3), {
        minLength: 1,
        maxLength: 3,
      }),
    ),
    byday: fc.option(
      fc.uniqueArray(fc.constantFrom('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'), {
        minLength: 1,
        maxLength: 3,
      }),
    ),
    nth: fc.option(fc.constantFrom(1, 2, 3, -1, -2)),
    byhour: fc.option(
      fc.uniqueArray(fc.constantFrom(8, 9, 13, 17), { minLength: 1, maxLength: 2 }),
    ),
    byminute: fc.option(fc.uniqueArray(fc.constantFrom(0, 15, 30), { minLength: 1, maxLength: 2 })),
    bysetpos: fc.option(fc.constantFrom(1, 2, -1)),
    byyearday: fc.option(
      fc.uniqueArray(fc.constantFrom(1, 32, 100, 200, 365, -1), { minLength: 1, maxLength: 3 }),
    ),
    wkst: fc.option(fc.constantFrom('SU', 'MO', 'WE')),
    count: fc.option(fc.constantFrom(3, 7, 15)),
    from: fc.integer({ min: 0, max: 700 }),
  })
  .map((r) => {
    const parts = [`FREQ=${r.freq}`];
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
    if (r.bymonth) parts.push(`BYMONTH=${r.bymonth.join(',')}`);
    if (r.bymonthday && r.freq !== 'WEEKLY') parts.push(`BYMONTHDAY=${r.bymonthday.join(',')}`);
    if (r.byday) {
      const numbered = r.nth !== null && (r.freq === 'MONTHLY' || r.freq === 'YEARLY');
      parts.push(`BYDAY=${r.byday.map((d) => (numbered ? `${r.nth}${d}` : d)).join(',')}`);
    }
    if (r.byyearday && r.freq === 'YEARLY') parts.push(`BYYEARDAY=${r.byyearday.join(',')}`);
    if (r.byhour) parts.push(`BYHOUR=${r.byhour.join(',')}`);
    if (r.byminute) parts.push(`BYMINUTE=${r.byminute.join(',')}`);
    if (r.bysetpos !== null && (r.byday || r.bymonthday)) parts.push(`BYSETPOS=${r.bysetpos}`);
    if (r.wkst) parts.push(`WKST=${r.wkst}`);
    if (r.count) parts.push(`COUNT=${r.count}`);
    return { rule: parts.join(';'), from: Date.UTC(2026, 0, 1, 9) + r.from * DAY };
  })
  .filter(({ rule }) => recurrenceRuleProblem(rule) === null);

describe('every accepted shape', () => {
  it('expands as the RFC 5545 oracle does', () => {
    fc.assert(
      fc.property(acceptedRule, ({ rule, from }) => {
        // Few enough occurrences for one feed's 2,000: a day of a MINUTELY rule, three of HOURLY.
        const days = rule.includes('FREQ=MINUTELY') ? 1 : rule.includes('FREQ=HOURLY') ? 3 : 360;
        // A DTSTART the rule produces (RFC 5545 leaves an unsynchronised one undefined).
        const first = oracleOccurrences(rule.replace(/;COUNT=\d+/, ''), from, from + 800 * DAY)[1];
        if (first === undefined) return;
        const to = first + days * DAY;
        const expected = oracleOccurrences(rule, first, to).map(stamp);
        const got = parseICalendarChanges(feed(stamp(first).slice(0, 15), rule, null), undefined, {
          start: new Date(first),
          end: new Date(to),
        }).map((change) => stamp((change.start as Date).getTime()));
        expect(got, rule).toEqual(expected);
      }),
      { seed: 20261024, numRuns: 1500 },
    );
    // 1,500 rules, each expanded twice: about four seconds on a fast laptop, six on a CI runner.
  }, 60_000);

  it('includes the shapes agents use', () => {
    for (const rule of [
      'FREQ=DAILY',
      'FREQ=DAILY;INTERVAL=2;COUNT=10',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20271231T235959Z',
      'FREQ=MONTHLY;BYMONTHDAY=15',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
      'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1',
      'FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU',
      'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1',
      'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
    ]) {
      expect(recurrenceRuleProblem(rule), rule).toBeNull();
      expect(isBookableRecurrenceRule(rule), rule).toBe(true);
    }
  });
});

describe('a DATE UNTIL on a timed series (ENG-7)', () => {
  const W = { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-01-20T00:00:00Z') };

  it.each([
    ['Asia/Tokyo', '003000'],
    ['Asia/Tokyo', '090000'],
    ['Europe/Berlin', '003000'],
    ['Europe/Berlin', '090000'],
    ['Europe/London', '090000'],
    ['America/Los_Angeles', '003000'],
    ['Pacific/Auckland', '090000'],
    ['UTC', '090000'],
  ])('includes its whole local day: %s %s gives three', (zone, time) => {
    const text = feed(
      `20270104T${time}`,
      'FREQ=DAILY;UNTIL=20270106',
      zone === 'UTC' ? null : zone,
    );
    expect(parseICalendarChanges(text, undefined, W)).toHaveLength(3);
    const [event] = parseTrustedICalendarEvents(text);
    expect(
      expandCalendarEventOccurrences(
        event as Parameters<typeof expandCalendarEventOccurrences>[0],
        W,
      ),
    ).toHaveLength(3);
  });

  it('is stored as the UTC instant its local day ends', () => {
    const stored = expandCalendarEventOccurrences(
      {
        start: new Date('2027-01-04T08:00:00Z'),
        end: new Date('2027-01-04T09:00:00Z'),
        timezone: 'Europe/Berlin',
        summary: 'x',
        recurrence: { rrule: 'FREQ=DAILY;UNTIL=20270106' },
      },
      W,
    );
    expect(stored.map((o) => o.start.toISOString())).toEqual([
      '2027-01-04T08:00:00.000Z',
      '2027-01-05T08:00:00.000Z',
      '2027-01-06T08:00:00.000Z',
    ]);
  });
});

describe('a yearly day some years lack (ENG-4)', () => {
  // RFC 5545 §3.3.10 ignores a date a year does not have: a 29 February birthday occurs in leap
  // years only. ical.js 2.2.1 moves it into the next month (1 March) instead.
  const year = (from: number) => ({
    start: new Date(Date.UTC(from, 0, 1)),
    end: new Date(Date.UTC(from + 1, 0, 1)),
  });
  const starts = (rule: string, start: string, window: { start: Date; end: Date }) => {
    const fromFeed = parseICalendarChanges(feed(start, rule, null), undefined, window).map(
      (change) => wall((change.start as Date).getTime()),
    );
    const stored = expandCalendarEventOccurrences(
      {
        start: new Date(frame(start)),
        end: new Date(frame(start) + 60_000),
        timezone: 'UTC',
        summary: 'x',
        recurrence: { rrule: rule },
      },
      window,
    ).map((occurrence) => wall(occurrence.start.getTime()));
    expect(stored).toEqual(fromFeed);
    return fromFeed;
  };

  it.each([
    ['FREQ=YEARLY', '20280229T090000'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '20280229T090000'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;UNTIL=20400101T000000Z', '20280229T090000'],
  ])('%s from 29 February 2028 occurs in leap years only', (rule, start) => {
    expect(recurrenceRuleProblem(rule)).toBeNull();
    expect(starts(rule, start, year(2028))).toEqual(['2028-02-29T09:00']);
    expect(starts(rule, start, year(2029))).toEqual([]);
    expect(starts(rule, start, year(2031))).toEqual([]);
    expect(starts(rule, start, year(2032))).toEqual(['2032-02-29T09:00']);
  });

  it('a 31st in a list of months occurs in the months that have one', () => {
    const rule = 'FREQ=YEARLY;BYMONTH=4,5,6,7;BYMONTHDAY=31';
    expect(starts(rule, '20270531T090000', year(2028))).toEqual([
      '2028-05-31T09:00',
      '2028-07-31T09:00',
    ]);
    expect(starts('FREQ=YEARLY;BYMONTH=1,4', '20270131T090000', year(2028))).toEqual([
      '2028-01-31T09:00',
    ]);
  });

  it('a feed with a 29 February birthday is read whole', () => {
    const birthday = feed('20240229T090000', 'FREQ=YEARLY', null);
    expect(parseICalendarChanges(birthday, undefined, year(2028))).toHaveLength(1);
  });

  it('with COUNT, which ical.js spends on the days it moves, it is refused on every path', () => {
    const rule = 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=3';
    expect(recurrenceRuleProblem(rule)).toMatch(/COUNT/);
    expect(isBookableRecurrenceRule(rule)).toBe(false);
    for (const counted of [rule, 'FREQ=YEARLY;COUNT=3']) {
      const text = feed('20280229T090000', counted, null);
      expect(() => parseICalendarChanges(text, undefined, year(2028))).toThrow(
        CalendarContractError,
      );
      expect(() => parseTrustedICalendarEvents(text)).toThrow(CalendarContractError);
      expect(() =>
        expandCalendarEventOccurrences(
          {
            start: new Date('2028-02-29T09:00:00Z'),
            end: new Date('2028-02-29T10:00:00Z'),
            timezone: 'UTC',
            summary: 'x',
            recurrence: { rrule: counted },
          },
          year(2028),
        ),
      ).toThrow(CalendarContractError);
    }
  });

  it('with an RDATE or a second RRULE, which ical.js mixes in, it is refused as a series', () => {
    for (const extra of ['RDATE:20290301T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1']) {
      const text = feed('20280229T090000', 'FREQ=YEARLY', null, extra);
      expect(parseICalendarFeed(text, undefined, year(2029))).toEqual({
        changes: [],
        refused: [{ uid: 'r', code: 'invalid_icalendar' }],
      });
    }
  });

  it('a day none of its months has is refused, so no year is searched for it', () => {
    expect(recurrenceRuleProblem('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30')).toMatch(/none/);
    expect(recurrenceRuleProblem('FREQ=YEARLY;BYMONTH=4,6;BYMONTHDAY=31;BYDAY=MO')).toMatch(/none/);
  });
});

/** A FREQ=YEARLY rule naming a day one of its months can lack, with no COUNT. */
const lackingYearlyRule = fc
  .record({
    months: fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 4 }),
    monthDays: fc.option(
      fc.uniqueArray(fc.constantFrom(1, 15, 28, 29, 30, 31), { minLength: 1, maxLength: 3 }),
    ),
    byMonth: fc.boolean(),
    byDay: fc.option(
      fc.uniqueArray(fc.constantFrom('MO', 'WE', 'SA'), { minLength: 1, maxLength: 2 }),
    ),
    interval: fc.constantFrom(1, 1, 2),
    until: fc.boolean(),
    from: fc.integer({ min: 0, max: 3_000 }),
  })
  .map((r) => {
    const parts = ['FREQ=YEARLY'];
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
    if (r.monthDays || r.byMonth) parts.push(`BYMONTH=${r.months.join(',')}`);
    if (r.monthDays) parts.push(`BYMONTHDAY=${r.monthDays.join(',')}`);
    if (r.byDay && r.monthDays) parts.push(`BYDAY=${r.byDay.join(',')}`);
    if (r.until) parts.push('UNTIL=20400101T000000Z');
    return { rule: parts.join(';'), from: Date.UTC(2024, 0, 1, 9) + r.from * DAY };
  });

describe('a yearly day some years lack, drawn at random', () => {
  it('expands as the RFC 5545 oracle does, in leap years and common ones', () => {
    let lacking = 0;
    fc.assert(
      fc.property(lackingYearlyRule, ({ rule, from }) => {
        // DTSTART on a day the rule names (the first the oracle finds), or a 29th, 30th or 31st of
        // one of its months for a rule that takes its day from DTSTART.
        const first = oracleOccurrences(rule, from, from + 3_000 * DAY)[0];
        if (first === undefined) return;
        if (recurrenceRuleProblem(rule) !== null) return;
        const recur = rule.split(';');
        const dayOf = new Date(first).getUTCDate();
        if (
          !rule.includes('BYMONTHDAY') &&
          !(dayOf >= 29 || recur.some((part) => part === 'BYMONTH=2'))
        ) {
          return;
        }
        lacking += 1;
        const start = first + DAY * 365 * 2;
        const window = { start: new Date(start), end: new Date(start + 366 * DAY) };
        const expected = oracleOccurrences(rule, first, window.end.getTime())
          .filter((t) => t >= start)
          .map(stamp);
        const text = feed(stamp(first).slice(0, 15), rule, null);
        const got = parseICalendarChanges(text, undefined, window)
          .map((change) => stamp((change.start as Date).getTime()))
          .filter((t) => t !== stamp(first));
        expect(got, rule).toEqual(expected);
      }),
      { seed: 20261027, numRuns: 800 },
    );
    expect(lacking).toBeGreaterThanOrEqual(200);
  });
});
