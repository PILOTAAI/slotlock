import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { emitICalendar, normalizeExternalCalendarChange, parseICalendarChanges } from '../sync.js';

describe('Slotlock external calendar change contract', () => {
  it('normalizes provider identity, intervals, recurrence and cancellation without carrying payloads', () => {
    expect(
      normalizeExternalCalendarChange({
        externalId: ' evt-1 ',
        recurrenceId: ' 20270102T090000Z ',
        start: '2027-01-02T09:00:00Z',
        end: '2027-01-02T10:00:00Z',
        status: 'cancelled',
        title: 'Customer name must not be retained',
      }),
    ).toEqual({
      externalId: 'evt-1',
      recurrenceId: '20270102T090000Z',
      start: new Date('2027-01-02T09:00:00Z'),
      end: new Date('2027-01-02T10:00:00Z'),
      deleted: true,
      busy: false,
      revision: 0,
    });
  });

  it('rejects empty identities and invalid or zero-length windows', () => {
    expect(() =>
      normalizeExternalCalendarChange({
        externalId: ' ',
        start: '2027-01-02T09:00:00Z',
        end: '2027-01-02T10:00:00Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_external_identity' }));
    expect(() =>
      normalizeExternalCalendarChange({
        externalId: 'evt-1',
        start: '2027-01-02T10:00:00Z',
        end: '2027-01-02T10:00:00Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_external_interval' }));
  });

  it('parses recurring instances, transparent events and cancellations with ical.js', () => {
    const changes = parseICalendarChanges(`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:busy-1\r
DTSTAMP:20270101T000000Z\r
DTSTART:20270102T090000Z\r
DTEND:20270102T100000Z\r
SEQUENCE:4\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:free-1\r
DTSTAMP:20270101T000000Z\r
DTSTART:20270103T090000Z\r
DTEND:20270103T100000Z\r
TRANSP:TRANSPARENT\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:series-1\r
RECURRENCE-ID:20270104T090000Z\r
DTSTAMP:20270101T000000Z\r
DTSTART:20270104T110000Z\r
DTEND:20270104T120000Z\r
STATUS:CANCELLED\r
SEQUENCE:2\r
END:VEVENT\r
END:VCALENDAR\r
`);

    expect(changes).toEqual([
      expect.objectContaining({ externalId: 'busy-1', busy: true, deleted: false, revision: 4 }),
      expect.objectContaining({ externalId: 'free-1', busy: false, deleted: false }),
      expect.objectContaining({
        externalId: 'series-1',
        recurrenceId: '2027-01-04T09:00:00.000Z',
        deleted: true,
        revision: 2,
      }),
    ]);
  });

  it('resolves floating times against X-WR-TIMEZONE instead of the server timezone', () => {
    const [change] = parseICalendarChanges(`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
X-WR-TIMEZONE:America/New_York\r
BEGIN:VEVENT\r
UID:floating-1\r
DTSTART:20270102T090000\r
DTEND:20270102T100000\r
END:VEVENT\r
END:VCALENDAR\r
`);
    expect(change?.start?.toISOString()).toBe('2027-01-02T14:00:00.000Z');
    expect(change?.end?.toISOString()).toBe('2027-01-02T15:00:00.000Z');
  });

  it('uses an embedded VTIMEZONE definition with a private TZID', () => {
    const [change] = parseICalendarChanges(`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VTIMEZONE\r
TZID:Custom/Eastern\r
BEGIN:STANDARD\r
DTSTART:19701101T020000\r
TZOFFSETFROM:-0400\r
TZOFFSETTO:-0500\r
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r
END:STANDARD\r
BEGIN:DAYLIGHT\r
DTSTART:19700308T020000\r
TZOFFSETFROM:-0500\r
TZOFFSETTO:-0400\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r
END:DAYLIGHT\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:custom-zone\r
DTSTART;TZID=Custom/Eastern:20270102T090000\r
DTEND;TZID=Custom/Eastern:20270102T100000\r
END:VEVENT\r
END:VCALENDAR\r
`);
    expect(change?.start?.toISOString()).toBe('2027-01-02T14:00:00.000Z');
  });

  it('fails closed for floating times when no calendar timezone is available', () => {
    expect(() =>
      parseICalendarChanges(`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:floating-unknown\r
DTSTART:20270102T090000\r
DTEND:20270102T100000\r
END:VEVENT\r
END:VCALENDAR\r
`),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });

  it('expands finite recurrence rules inside the authoritative coverage window', () => {
    const changes = parseICalendarChanges(
      `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:daily-rental-block\r
DTSTART:20270101T090000Z\r
DTEND:20270101T100000Z\r
RRULE:FREQ=DAILY;COUNT=3\r
END:VEVENT\r
END:VCALENDAR\r
`,
      undefined,
      { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-01-05T00:00:00Z') },
    );
    expect(changes.map((change) => change.start?.toISOString())).toEqual([
      '2027-01-01T09:00:00.000Z',
      '2027-01-02T09:00:00.000Z',
      '2027-01-03T09:00:00.000Z',
    ]);
    expect(changes.map((change) => change.recurrenceId)).toEqual([
      '2027-01-01T09:00:00.000Z',
      '2027-01-02T09:00:00.000Z',
      '2027-01-03T09:00:00.000Z',
    ]);
  });

  it('requires a bounded expansion window for recurrence rules', () => {
    expect(() =>
      parseICalendarChanges(`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:unbounded-series\r
DTSTART:20270101T090000Z\r
DTEND:20270101T100000Z\r
RRULE:FREQ=DAILY\r
END:VEVENT\r
END:VCALENDAR\r
`),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });

  it('includes a recurrence exception moved backward into the coverage window', () => {
    const changes = parseICalendarChanges(
      `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock fixture//EN\r
BEGIN:VEVENT\r
UID:moved-series\r
DTSTART:20270110T090000Z\r
DTEND:20270110T100000Z\r
RRULE:FREQ=DAILY;COUNT=3\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:moved-series\r
RECURRENCE-ID:20270110T090000Z\r
DTSTART:20270105T090000Z\r
DTEND:20270105T100000Z\r
END:VEVENT\r
END:VCALENDAR\r
`,
      undefined,
      { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-01-06T00:00:00Z') },
    );
    expect(changes).toEqual([
      expect.objectContaining({
        recurrenceId: '2027-01-10T09:00:00.000Z',
        start: new Date('2027-01-05T09:00:00.000Z'),
        end: new Date('2027-01-05T10:00:00.000Z'),
      }),
    ]);
  });

  it('applies one bounded recurrence work budget across a hostile multi-series payload', () => {
    const series = Array.from(
      { length: 3 },
      (_, index) => `BEGIN:VEVENT\r
UID:hostile-${index}\r
DTSTART:19000101T090000Z\r
DTEND:19000101T100000Z\r
RRULE:FREQ=DAILY\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:hostile-${index}\r
RECURRENCE-ID:20271231T090000Z\r
DTSTART:20270102T090000Z\r
DTEND:20270102T100000Z\r
END:VEVENT\r
`,
    ).join('');
    expect(() =>
      parseICalendarChanges(
        `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock hostile fixture//EN\r
${series}END:VCALENDAR\r
`,
        undefined,
        { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-01-05T00:00:00Z') },
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });

  it('rejects an adversarial payload with duplicate recurring master UIDs', () => {
    const duplicateMasters = Array.from(
      { length: 5_000 },
      (_, index) => `BEGIN:VEVENT\r
UID:duplicate-master\r
DTSTART:202701${String((index % 28) + 1).padStart(2, '0')}T090000Z\r
DTEND:202701${String((index % 28) + 1).padStart(2, '0')}T100000Z\r
RRULE:FREQ=DAILY;COUNT=2\r
END:VEVENT\r
`,
    ).join('');
    expect(() =>
      parseICalendarChanges(
        `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Slotlock hostile fixture//EN\r
${duplicateMasters}END:VCALENDAR\r
`,
        undefined,
        { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-02-01T00:00:00Z') },
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_icalendar' }));
  });

  it('emits deterministic, escaped, cancellation-aware RFC 5545 parsed by the real library', () => {
    const input = {
      uid: 'booking-42@calendar.example.com',
      start: new Date('2027-06-12T09:15:00.000Z'),
      end: new Date('2027-06-12T11:45:00.000Z'),
      summary: 'Rental, vehicle; A\\B\nCollection',
      description: 'Agent-safe booking reference only',
      sequence: 3,
      status: 'cancelled' as const,
      updatedAt: new Date('2027-05-01T12:00:00.000Z'),
    };

    const first = emitICalendar(input);
    expect(emitICalendar(input)).toBe(first);
    expect(first).toContain('METHOD:CANCEL');
    expect(first).toContain('STATUS:CANCELLED');

    const calendar = new ICAL.Component(ICAL.parse(first));
    const eventComponent = calendar.getFirstSubcomponent('vevent');
    expect(eventComponent).not.toBeNull();
    const event = new ICAL.Event(eventComponent ?? undefined);
    expect(event.uid).toBe(input.uid);
    expect(event.startDate.toJSDate().toISOString()).toBe(input.start.toISOString());
    expect(event.endDate.toJSDate().toISOString()).toBe(input.end.toISOString());
    expect(event.summary).toBe(input.summary);
    expect(event.component.getFirstPropertyValue('sequence')).toBe(3);
  });
});
