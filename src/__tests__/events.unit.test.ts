import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  emitITipCalendar,
  expandCalendarEventOccurrences,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';

const d = (iso: string) => new Date(iso);

describe('Slotlock trusted event contract', () => {
  it('keeps trusted content parsing separate from privacy-minimised busy parsing', () => {
    const payload = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:agent-meeting-1\r
DTSTART:20270301T100000Z\r
DTEND:20270301T110000Z\r
SUMMARY:Private renter handover\r
DESCRIPTION:Private operational notes\r
LOCATION:Depot 7\r
ORGANIZER;CN=Fleet Desk:mailto:fleet@example.com\r
ATTENDEE;CN=Agent;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:agent@example.com\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
TRIGGER:-PT15M\r
DESCRIPTION:Handover reminder\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR\r
`;

    const [busy] = parseICalendarChanges(payload);
    expect(busy).toEqual({
      externalId: 'agent-meeting-1',
      start: d('2027-03-01T10:00:00Z'),
      end: d('2027-03-01T11:00:00Z'),
      deleted: false,
      busy: true,
      revision: 0,
    });
    expect(JSON.stringify(busy)).not.toContain('renter');
    expect(JSON.stringify(busy)).not.toContain('agent@example.com');

    const [trusted] = parseTrustedICalendarEvents(payload);
    expect(trusted).toMatchObject({
      uid: 'agent-meeting-1',
      summary: 'Private renter handover',
      description: 'Private operational notes',
      location: 'Depot 7',
      organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
      attendees: [
        {
          email: 'agent@example.com',
          name: 'Agent',
          role: 'required',
          participationStatus: 'accepted',
          rsvp: true,
        },
      ],
      reminders: [{ action: 'display', minutesBeforeStart: 15 }],
    });
  });

  it('expands recurring wall time across DST and applies moved/cancelled exceptions', () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        start: d('2027-03-27T09:00:00Z'),
        end: d('2027-03-27T10:00:00Z'),
        timezone: 'Europe/London',
        summary: 'Daily vehicle inspection',
        recurrence: {
          rrule: 'FREQ=DAILY;COUNT=4',
          exceptions: [
            {
              recurrenceId: d('2027-03-28T08:00:00Z'),
              start: d('2027-03-28T11:00:00Z'),
              end: d('2027-03-28T12:00:00Z'),
            },
            { recurrenceId: d('2027-03-29T08:00:00Z'), cancelled: true },
          ],
        },
      },
      { start: d('2027-03-27T00:00:00Z'), end: d('2027-04-01T00:00:00Z') },
    );

    expect(occurrences.map((occurrence) => occurrence.start.toISOString())).toEqual([
      '2027-03-27T09:00:00.000Z',
      '2027-03-28T11:00:00.000Z',
      '2027-03-30T08:00:00.000Z',
    ]);
    expect(occurrences.map((occurrence) => occurrence.recurrenceId)).toEqual([
      '2027-03-27T09:00:00.000Z',
      '2027-03-28T08:00:00.000Z',
      '2027-03-30T08:00:00.000Z',
    ]);
  });

  it('maps EXDATE to a cancellation exception and rejects recurrence constructs it cannot preserve', () => {
    const payload = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:exdate-series\r
DTSTART:20270101T090000Z\r
DTEND:20270101T100000Z\r
SUMMARY:Series\r
RRULE:FREQ=DAILY;COUNT=3\r
EXDATE:20270102T090000Z\r
END:VEVENT\r
END:VCALENDAR\r
`;
    const [trusted] = parseTrustedICalendarEvents(payload);
    expect(trusted?.recurrence?.exceptions).toEqual([
      { recurrenceId: d('2027-01-02T09:00:00Z'), cancelled: true },
    ]);

    expect(() => parseTrustedICalendarEvents(payload.replace('EXDATE:', 'RDATE:'))).toThrowError(
      expect.objectContaining({ code: 'invalid_icalendar' }),
    );
  });

  it('emits a real RFC 5545/iTIP request with participants, RSVP, reminders and exceptions', () => {
    const payload = emitITipCalendar(
      {
        uid: 'handover-42@slotlock.example',
        start: d('2027-06-12T09:15:00Z'),
        end: d('2027-06-12T10:15:00Z'),
        timezone: 'Europe/London',
        summary: 'Vehicle handover',
        description: 'Booking reference BK-42',
        location: 'Depot 7',
        sequence: 3,
        organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
        attendees: [
          {
            email: 'agent@example.com',
            name: 'Booking Agent',
            role: 'required',
            participationStatus: 'needs_action',
            rsvp: true,
          },
        ],
        reminders: [
          { action: 'display', minutesBeforeStart: 30 },
          { action: 'email', minutesBeforeStart: 60 },
        ],
        recurrence: {
          rrule: 'FREQ=DAILY;COUNT=2',
          exceptions: [{ recurrenceId: d('2027-06-13T09:15:00Z'), cancelled: true }],
        },
      },
      'REQUEST',
    );

    const calendar = new ICAL.Component(ICAL.parse(payload));
    expect(calendar.getFirstPropertyValue('method')).toBe('REQUEST');
    const events = calendar.getAllSubcomponents('vevent');
    expect(events).toHaveLength(2);
    const master = events[0];
    expect(master?.getFirstPropertyValue('organizer')).toBe('mailto:fleet@example.com');
    const attendee = master?.getFirstProperty('attendee');
    expect(attendee?.getFirstValue()).toBe('mailto:agent@example.com');
    expect(attendee?.getParameter('partstat')).toBe('NEEDS-ACTION');
    expect(attendee?.getParameter('rsvp')).toBe('TRUE');
    const alarms = master?.getAllSubcomponents('valarm') ?? [];
    expect(alarms).toHaveLength(2);
    const emailAlarm = alarms.find((alarm) => alarm.getFirstPropertyValue('action') === 'EMAIL');
    expect(emailAlarm?.getFirstPropertyValue('summary')).toBe('Vehicle handover');
    expect(emailAlarm?.getFirstPropertyValue('attendee')).toBe('mailto:agent@example.com');
    expect(events[1]?.getFirstPropertyValue('status')).toBe('CANCELLED');
    expect(events[1]?.getFirstProperty('recurrence-id')).toBeDefined();
  });

  it('fails closed before unbounded trusted-event work or cardinality can reach the store', () => {
    const event = {
      start: d('2027-01-01T09:00:00Z'),
      end: d('2027-01-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Bounded series',
      recurrence: { rrule: 'FREQ=MINUTELY' },
    };
    expect(() =>
      expandCalendarEventOccurrences(event, {
        start: d('2027-01-01T00:00:00Z'),
        end: d('2028-01-03T00:00:00Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));

    expect(() =>
      expandCalendarEventOccurrences(event, {
        start: d('2027-01-01T00:00:00Z'),
        end: d('2027-01-04T00:00:00Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));

    expect(() =>
      emitITipCalendar(
        {
          ...event,
          uid: 'too-many-attendees',
          attendees: Array.from({ length: 101 }, (_, index) => ({
            email: `agent-${index}@example.com`,
          })),
        },
        'PUBLISH',
      ),
    ).toThrowError(CalendarContractError);

    expect(() =>
      emitITipCalendar(
        {
          ...event,
          uid: 'email-without-recipient',
          reminders: [{ action: 'email', minutesBeforeStart: 10 }],
        },
        'PUBLISH',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });
});

const vcalendar = (body: string, header = '') => `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
${header}${body}END:VCALENDAR\r
`;
const vevent = (lines: string) => `BEGIN:VEVENT\r
${lines}END:VEVENT\r
`;
const bounds = (event: { start: Date; end: Date } | undefined) => [
  event?.start.toISOString(),
  event?.end.toISOString(),
];

describe('Slotlock all-day import (RFC 5545 DATE values)', () => {
  it('imports an all-day event as local-midnight bounds in the calendar timezone', () => {
    const payload = vcalendar(
      vevent(`UID:rental-1\r
DTSTART;VALUE=DATE:20270301\r
DTEND;VALUE=DATE:20270302\r
SUMMARY:Rental day\r
`),
    );
    const [london] = parseTrustedICalendarEvents(payload, 'Europe/London');
    expect(bounds(london)).toEqual(['2027-03-01T00:00:00.000Z', '2027-03-02T00:00:00.000Z']);
    expect(london?.timezone).toBe('Europe/London');

    // Without an explicit zone the calendar's X-WR-TIMEZONE decides, never the server's clock.
    const [newYork] = parseTrustedICalendarEvents(
      vcalendar(
        vevent(`UID:rental-1\r
DTSTART;VALUE=DATE:20270301\r
DTEND;VALUE=DATE:20270302\r
SUMMARY:Rental day\r
`),
        'X-WR-TIMEZONE:America/New_York\r\n',
      ),
    );
    expect(bounds(newYork)).toEqual(['2027-03-01T05:00:00.000Z', '2027-03-02T05:00:00.000Z']);
    expect(newYork?.timezone).toBe('America/New_York');
  });

  it('gives a DATE start without DTEND one day, and honours a day-based DURATION', () => {
    const [oneDay, threeDays] = parseTrustedICalendarEvents(
      vcalendar(
        `${vevent(`UID:no-end\r
DTSTART;VALUE=DATE:20270301\r
SUMMARY:One day\r
`)}${vevent(`UID:with-duration\r
DTSTART;VALUE=DATE:20270301\r
DURATION:P3D\r
SUMMARY:Three days\r
`)}`,
      ),
      'UTC',
    );
    expect(bounds(oneDay)).toEqual(['2027-03-01T00:00:00.000Z', '2027-03-02T00:00:00.000Z']);
    expect(bounds(threeDays)).toEqual(['2027-03-01T00:00:00.000Z', '2027-03-04T00:00:00.000Z']);
  });

  it('keeps a DST-change day at its real 23 or 25 hours, and starts a day with no midnight at its first instant', () => {
    const [spring, autumn] = parseTrustedICalendarEvents(
      vcalendar(
        `${vevent(`UID:spring\r
DTSTART;VALUE=DATE:20270328\r
DTEND;VALUE=DATE:20270329\r
SUMMARY:Clocks forward\r
`)}${vevent(`UID:autumn\r
DTSTART;VALUE=DATE:20271031\r
DTEND;VALUE=DATE:20271101\r
SUMMARY:Clocks back\r
`)}`,
      ),
      'Europe/London',
    );
    expect(bounds(spring)).toEqual(['2027-03-28T00:00:00.000Z', '2027-03-28T23:00:00.000Z']);
    expect(bounds(autumn)).toEqual(['2027-10-30T23:00:00.000Z', '2027-11-01T00:00:00.000Z']);

    // Cuba moves its clocks at 00:00: 2027-03-14 begins at 01:00 local (05:00Z).
    const [havana] = parseTrustedICalendarEvents(
      vcalendar(
        vevent(`UID:havana\r
DTSTART;VALUE=DATE:20270314\r
DTEND;VALUE=DATE:20270315\r
SUMMARY:No midnight\r
`),
      ),
      'America/Havana',
    );
    expect(bounds(havana)).toEqual(['2027-03-14T05:00:00.000Z', '2027-03-15T04:00:00.000Z']);
  });

  it('imports a multi-month all-day rental and a date-bounded recurring all-day series with exceptions', () => {
    const payload = vcalendar(
      `${vevent(`UID:quarter\r
DTSTART;VALUE=DATE:20270301\r
DTEND;VALUE=DATE:20270530\r
SUMMARY:Quarter rental\r
`)}${vevent(`UID:weekly\r
DTSTART;VALUE=DATE:20270301\r
DTEND;VALUE=DATE:20270302\r
RRULE:FREQ=WEEKLY;UNTIL=20270322\r
EXDATE;VALUE=DATE:20270308\r
SUMMARY:Weekly service day\r
`)}${vevent(`UID:weekly\r
RECURRENCE-ID;VALUE=DATE:20270315\r
DTSTART;VALUE=DATE:20270316\r
DTEND;VALUE=DATE:20270317\r
SUMMARY:Weekly service day (moved)\r
`)}`,
    );
    const events = parseTrustedICalendarEvents(payload, 'Europe/London');
    const quarter = events.find((event) => event.uid === 'quarter');
    expect(bounds(quarter)).toEqual(['2027-03-01T00:00:00.000Z', '2027-05-29T23:00:00.000Z']);

    const weekly = events.find((event) => event.uid === 'weekly');
    // A DATE UNTIL becomes the UTC instant of that day's local midnight (RFC 5545 §3.3.10).
    expect(weekly?.recurrence?.rrule).toBe('FREQ=WEEKLY;UNTIL=20270322T000000Z');
    expect(weekly?.recurrence?.exceptions).toEqual([
      { recurrenceId: d('2027-03-08T00:00:00Z'), cancelled: true },
      {
        recurrenceId: d('2027-03-15T00:00:00Z'),
        start: d('2027-03-16T00:00:00Z'),
        end: d('2027-03-17T00:00:00Z'),
      },
    ]);
    if (!weekly) throw new Error('weekly series missing');
    const occurrences = expandCalendarEventOccurrences(
      { ...weekly, status: 'confirmed' },
      { start: d('2027-02-28T00:00:00Z'), end: d('2027-04-01T00:00:00Z') },
    );
    expect(occurrences.map((occurrence) => occurrence.start.toISOString())).toEqual([
      '2027-03-01T00:00:00.000Z',
      '2027-03-16T00:00:00.000Z',
      '2027-03-22T00:00:00.000Z',
    ]);
  });

  it('rejects mixed DATE/DATE-TIME bounds, time-based durations and a date without any timezone', () => {
    const mixed = vcalendar(
      vevent(`UID:mixed\r
DTSTART;VALUE=DATE:20270301\r
DTEND:20270301T100000Z\r
SUMMARY:Mixed\r
`),
    );
    expect(() => parseTrustedICalendarEvents(mixed, 'UTC')).toThrowError(
      expect.objectContaining({ code: 'invalid_icalendar' }),
    );
    const hourly = vcalendar(
      vevent(`UID:hourly\r
DTSTART;VALUE=DATE:20270301\r
DURATION:PT5H\r
SUMMARY:Hours on a date\r
`),
    );
    expect(() => parseTrustedICalendarEvents(hourly, 'UTC')).toThrowError(
      expect.objectContaining({ code: 'invalid_icalendar' }),
    );
    const floating = vcalendar(
      vevent(`UID:floating-day\r
DTSTART;VALUE=DATE:20270301\r
DTEND;VALUE=DATE:20270302\r
SUMMARY:Which day?\r
`),
    );
    expect(() => parseTrustedICalendarEvents(floating)).toThrowError(
      expect.objectContaining({ code: 'invalid_icalendar' }),
    );
  });
});

describe('Slotlock long one-off events', () => {
  it('expands a one-off event longer than the 367-day recurrence window as one occurrence', () => {
    const lease = {
      start: d('2027-01-01T00:00:00Z'),
      end: d('2028-06-01T00:00:00Z'),
      timezone: 'UTC',
      summary: 'Seventeen-month lease',
    };
    expect(
      expandCalendarEventOccurrences(lease, { start: lease.start, end: lease.end }).map(
        (occurrence) => bounds(occurrence),
      ),
    ).toEqual([['2027-01-01T00:00:00.000Z', '2028-06-01T00:00:00.000Z']]);

    // Recurrence expansion keeps its bound: a 368-day window is still refused for a series.
    expect(() =>
      expandCalendarEventOccurrences(
        {
          start: d('2027-01-01T09:00:00Z'),
          end: d('2027-01-01T10:00:00Z'),
          timezone: 'UTC',
          summary: 'Series',
          recurrence: { rrule: 'FREQ=WEEKLY;COUNT=3' },
        },
        { start: d('2027-01-01T00:00:00Z'), end: d('2028-01-04T00:00:00Z') },
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });
});
