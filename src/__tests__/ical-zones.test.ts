// Calendars that name a time zone without defining it (RFC 5545 wants a VTIMEZONE for each TZID;
// real feeds, and Slotlock's own stored series, name IANA zones bare), and the other shapes of a
// legal feed the parser must read: PERIOD RDATEs, events without an end, old series, odd roots.
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  expandCalendarEventOccurrences,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';

const calendar = (...lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotlock tests//EN',
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
const event = (uid: string, ...lines: string[]) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20230101T000000Z',
  ...lines,
  'END:VEVENT',
];
const TOKYO = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Tokyo',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0900',
  'TZOFFSETTO:+0900',
  'TZNAME:JST',
  'END:STANDARD',
  'END:VTIMEZONE',
];
const window = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const starts = (changes: { start: Date | null }[]) =>
  changes.map(({ start }) => start?.toISOString());
const spans = (changes: { start: Date | null; end: Date | null }[]) =>
  changes.map(({ start, end }) => [start?.toISOString(), end?.toISOString()]);
const refusal = (parse: () => unknown) => {
  try {
    parse();
    return 'parsed';
  } catch (error) {
    return `${(error as Error).name}: ${(error as CalendarContractError).code}`;
  }
};

describe('a TZID the calendar does not define', () => {
  it('keeps the occurrence a UTC UNTIL names, east of UTC, in a stored series', () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        start: new Date('2027-01-01T08:00:00Z'),
        end: new Date('2027-01-01T09:00:00Z'),
        timezone: 'Europe/Berlin',
        summary: 'Van on hire',
        recurrence: { rrule: 'FREQ=DAILY;UNTIL=20270103T080000Z' },
      },
      window('2026-12-25T00:00:00Z', '2027-01-20T00:00:00Z'),
    );
    expect(starts(occurrences)).toEqual([
      '2027-01-01T08:00:00.000Z',
      '2027-01-02T08:00:00.000Z',
      '2027-01-03T08:00:00.000Z',
    ]);
  });

  it('keeps the last day of an imported all-day series in Tokyo', () => {
    const [series] = parseTrustedICalendarEvents(
      calendar(
        ...event(
          'car-out',
          'SUMMARY:Car out',
          'DTSTART;VALUE=DATE:20270101',
          'DTEND;VALUE=DATE:20270102',
          'RRULE:FREQ=DAILY;UNTIL=20270103',
        ),
      ),
      'Asia/Tokyo',
    );
    const occurrences = expandCalendarEventOccurrences(
      { ...(series as NonNullable<typeof series>), status: 'confirmed' },
      window('2026-12-25T00:00:00Z', '2027-01-20T00:00:00Z'),
    );
    expect(starts(occurrences)).toEqual([
      '2026-12-31T15:00:00.000Z',
      '2027-01-01T15:00:00.000Z',
      '2027-01-02T15:00:00.000Z',
    ]);
  });

  it('reads a feed UNTIL in UTC at its instant, as a VTIMEZONE would', () => {
    const lines = event(
      'tokyo',
      'DTSTART;TZID=Asia/Tokyo:20270101T090000',
      'DTEND;TZID=Asia/Tokyo:20270101T100000',
      'RRULE:FREQ=DAILY;UNTIL=20270103T000000Z',
    );
    const range = window('2026-12-30T00:00:00Z', '2027-01-10T00:00:00Z');
    const bare = parseICalendarChanges(calendar(...lines), undefined, range);
    const defined = parseICalendarChanges(calendar(...TOKYO, ...lines), undefined, range);
    expect(starts(bare)).toEqual([
      '2027-01-01T00:00:00.000Z',
      '2027-01-02T00:00:00.000Z',
      '2027-01-03T00:00:00.000Z',
    ]);
    expect(bare).toEqual(defined);
  });

  it('ends a series west of UTC at its UNTIL, not hours after it', () => {
    // 07:00 New York on 3 January: that day's 09:00 is after it.
    const changes = parseICalendarChanges(
      calendar(
        ...event(
          'new-york',
          'DTSTART;TZID=America/New_York:20270101T090000',
          'DTEND;TZID=America/New_York:20270101T100000',
          'RRULE:FREQ=DAILY;UNTIL=20270103T120000Z',
        ),
      ),
      undefined,
      window('2026-12-30T00:00:00Z', '2027-01-10T00:00:00Z'),
    );
    expect(starts(changes)).toEqual(['2027-01-01T14:00:00.000Z', '2027-01-02T14:00:00.000Z']);
  });

  it('moves the occurrence a RECURRENCE-ID in UTC names', () => {
    const changes = parseICalendarChanges(
      calendar(
        ...event(
          'london',
          'DTSTART;TZID=Europe/London:20270607T090000',
          'DTEND;TZID=Europe/London:20270607T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
        ),
        ...event(
          'london',
          'RECURRENCE-ID:20270608T080000Z',
          'DTSTART:20270608T130000Z',
          'DTEND:20270608T140000Z',
        ),
      ),
      undefined,
      window('2027-06-01T00:00:00Z', '2027-06-30T00:00:00Z'),
    );
    expect(spans(changes)).toEqual([
      ['2027-06-07T08:00:00.000Z', '2027-06-07T09:00:00.000Z'],
      ['2027-06-08T13:00:00.000Z', '2027-06-08T14:00:00.000Z'],
      ['2027-06-09T08:00:00.000Z', '2027-06-09T09:00:00.000Z'],
    ]);
    expect(changes[1]?.recurrenceId).toBe('2027-06-08T08:00:00.000Z');
  });

  it('removes the occurrence an EXDATE in UTC names', () => {
    const changes = parseICalendarChanges(
      calendar(
        ...event(
          'exdate',
          'DTSTART;TZID=America/New_York:20270104T090000',
          'DTEND;TZID=America/New_York:20270104T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
          'EXDATE:20270105T140000Z',
        ),
      ),
      undefined,
      window('2027-01-01T00:00:00Z', '2027-01-10T00:00:00Z'),
    );
    expect(starts(changes)).toEqual(['2027-01-04T14:00:00.000Z', '2027-01-06T14:00:00.000Z']);
  });

  it("reads floating times in the calendar's own zone against a UTC UNTIL", () => {
    const changes = parseICalendarChanges(
      calendar(
        'X-WR-TIMEZONE:Europe/Berlin',
        ...event(
          'floating',
          'DTSTART:20270101T090000',
          'DTEND:20270101T100000',
          'RRULE:FREQ=DAILY;UNTIL=20270103T080000Z',
        ),
      ),
      undefined,
      window('2026-12-30T00:00:00Z', '2027-01-10T00:00:00Z'),
    );
    expect(starts(changes)).toEqual([
      '2027-01-01T08:00:00.000Z',
      '2027-01-02T08:00:00.000Z',
      '2027-01-03T08:00:00.000Z',
    ]);
  });

  it('keeps the last day of an all-day feed series whose UNTIL is a UTC instant', () => {
    // Local midnight on 3 January in Tokyo, written in UTC.
    const changes = parseICalendarChanges(
      calendar(
        ...event(
          'all-day',
          'DTSTART;VALUE=DATE:20270101',
          'DTEND;VALUE=DATE:20270102',
          'RRULE:FREQ=DAILY;UNTIL=20270102T150000Z',
          'EXDATE:20270101T150000Z',
        ),
      ),
      'Asia/Tokyo',
      window('2026-12-25T00:00:00Z', '2027-01-20T00:00:00Z'),
    );
    expect(starts(changes)).toEqual(['2026-12-31T15:00:00.000Z', '2027-01-02T15:00:00.000Z']);
  });
});

describe('the rest of a legal feed', () => {
  it('reads PERIOD RDATEs, with an end or a duration, in order with the rule', () => {
    const changes = parseICalendarChanges(
      calendar(
        ...event(
          'periods',
          'DTSTART:20270104T090000Z',
          'DTEND:20270104T100000Z',
          'RRULE:FREQ=DAILY;COUNT=3',
          'RDATE;VALUE=PERIOD:20270105T130000Z/20270105T150000Z',
          'RDATE;VALUE=PERIOD;TZID=Europe/London:20270708T090000/PT3H',
        ),
      ),
      undefined,
      window('2027-01-01T00:00:00Z', '2027-08-01T00:00:00Z'),
    );
    expect(spans(changes)).toEqual([
      ['2027-01-04T09:00:00.000Z', '2027-01-04T10:00:00.000Z'],
      ['2027-01-05T09:00:00.000Z', '2027-01-05T10:00:00.000Z'],
      ['2027-01-05T13:00:00.000Z', '2027-01-05T15:00:00.000Z'],
      ['2027-01-06T09:00:00.000Z', '2027-01-06T10:00:00.000Z'],
      ['2027-07-08T08:00:00.000Z', '2027-07-08T11:00:00.000Z'],
    ]);
  });

  it('leaves out an event with no length and reads the rest of the feed', () => {
    // RFC 5545 §3.6.1: a DATE-TIME DTSTART without DTEND or DURATION ends when it starts.
    const changes = parseICalendarChanges(
      calendar(
        ...event('busy', 'DTSTART:20270102T090000Z', 'DTEND:20270102T100000Z'),
        ...event('reminder', 'DTSTART:20270103T090000Z'),
        ...event('daily-reminder', 'DTSTART:20270104T090000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
      ),
      undefined,
      window('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z'),
    );
    expect(changes.map(({ externalId }) => externalId)).toEqual(['busy']);
  });

  it('refuses an event that ends before it starts as an invalid calendar', () => {
    expect(
      refusal(() =>
        parseICalendarChanges(
          calendar(...event('backwards', 'DTSTART:20270102T100000Z', 'DTEND:20270102T090000Z')),
        ),
      ),
    ).toBe('CalendarContractError: invalid_icalendar');
  });

  it('reads series begun years before the window', () => {
    const series = ['a', 'b', 'c'].flatMap((uid) =>
      event(uid, 'DTSTART:20230102T090000Z', 'DTEND:20230102T091500Z', 'RRULE:FREQ=DAILY'),
    );
    const changes = parseICalendarChanges(
      calendar(...series),
      undefined,
      window('2026-10-23T00:00:00Z', '2026-11-23T00:00:00Z'),
    );
    expect(changes).toHaveLength(93);
  });

  it('still refuses a search before the window that runs past the step budget', () => {
    expect(
      refusal(() =>
        parseICalendarChanges(
          calendar(
            ...event(
              'minutely',
              'DTSTART:20260101T000000Z',
              'DTEND:20260101T000030Z',
              'RRULE:FREQ=MINUTELY',
            ),
          ),
          undefined,
          window('2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z'),
        ),
      ),
    ).toBe('CalendarExpansionLimitError: invalid_icalendar');
    expect(CalendarExpansionLimitError).toBeDefined();
  });

  it('refuses a document whose root is not a VCALENDAR', () => {
    const bare = `${event('bare', 'SUMMARY:Bare', 'DTSTART:20270102T090000Z', 'DTEND:20270102T100000Z').join('\r\n')}\r\n`;
    expect(refusal(() => parseICalendarChanges(bare))).toBe(
      'CalendarContractError: invalid_icalendar',
    );
    expect(refusal(() => parseTrustedICalendarEvents(bare, 'UTC'))).toBe(
      'CalendarContractError: invalid_icalendar',
    );
  });
});
