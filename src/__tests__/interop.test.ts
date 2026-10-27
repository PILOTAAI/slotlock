import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  emitVAvailability,
  parseVAvailability,
  recurrenceRuleFromRRule,
  SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS,
  toJSCalendarEvent,
} from '../interop.js';
import type { SlotlockCalendarEvent } from '../types.js';

const RULES = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 },
  { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 1_320, durationMinutes: 240 },
];

const calendar = (body: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR', ''].join('\r\n');

const available = (lines: string[], index = 0) =>
  ['BEGIN:AVAILABLE', `UID:a${index}`, 'DTSTAMP:20240101T000000Z', ...lines, 'END:AVAILABLE'].join('\r\n');

const vavailability = (...availables: string[]) =>
  calendar(['BEGIN:VAVAILABILITY', 'UID:v', 'DTSTAMP:20240101T000000Z', ...availables, 'END:VAVAILABILITY'].join('\r\n'));

const refusal = (text: string) => {
  try {
    parseVAvailability(text);
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return null;
};

describe('VAVAILABILITY (RFC 7953)', () => {
  it('writes rules that read back as the same rules and zone', () => {
    const text = emitVAvailability({ rules: RULES, timezone: 'Europe/London', uid: 'resource-1' });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(parseVAvailability(text)).toEqual({ timezone: 'Europe/London', rules: RULES });
  });

  it('starts each AVAILABLE on its first day, as RFC 5545 counts DTSTART as an occurrence', () => {
    const text = emitVAvailability({ rules: RULES, timezone: 'Europe/London', uid: 'r' });
    const root = new ICAL.Component(ICAL.parse(text) as unknown[]);
    const [weekdays, saturday] = root
      .getFirstSubcomponent('vavailability')!
      .getAllSubcomponents('available')
      .map((component) => component.getFirstPropertyValue('dtstart') as InstanceType<typeof ICAL.Time>);
    expect(weekdays!.toString()).toBe('2024-01-08T09:00:00');
    expect(saturday!.toString()).toBe('2024-01-13T22:00:00');
    // Every AVAILABLE carries the properties RFC 7953 requires.
    for (const component of root.getFirstSubcomponent('vavailability')!.getAllSubcomponents('available')) {
      for (const name of ['uid', 'dtstamp', 'dtstart', 'duration', 'rrule']) {
        expect(component.hasProperty(name)).toBe(true);
      }
    }
  });

  it('writes no AVAILABLE for never bookable, and reads that back as no rules', () => {
    const text = emitVAvailability({ rules: [], timezone: 'UTC', uid: 'r' });
    expect(text).not.toContain('AVAILABLE\r\nUID');
    expect(parseVAvailability(text)).toEqual({ timezone: null, rules: [] });
  });

  it("reads RFC 7953's own example: weekdays nine to five with DTEND, a TZID", () => {
    const text = vavailability(
      available([
        'SUMMARY:Monday to Friday from 9:00 to 17:00',
        'DTSTART;TZID=America/Montreal:20111002T090000',
        'DTEND;TZID=America/Montreal:20111002T170000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      ]),
    );
    expect(parseVAvailability(text)).toEqual({
      timezone: 'America/Montreal',
      rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 }],
    });
  });

  it("gives an RRULE without BYDAY its DTSTART's day", () => {
    const text = vavailability(
      available(['DTSTART;TZID=Europe/Paris:20240103T100000', 'DURATION:PT1H30M', 'RRULE:FREQ=WEEKLY']),
    );
    expect(parseVAvailability(text).rules).toEqual([
      { rrule: 'FREQ=WEEKLY;BYDAY=WE', startMinutes: 600, durationMinutes: 90 },
    ]);
  });

  it('reads UTC times as the UTC zone and floating ones as no zone', () => {
    const utc = vavailability(available(['DTSTART:20240101T080000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=MO']));
    expect(parseVAvailability(utc).timezone).toBe('UTC');
    const floating = vavailability(available(['DTSTART:20240101T080000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=MO']));
    expect(parseVAvailability(floating).timezone).toBeNull();
  });

  it.each([
    ['not iCalendar', 'hello'],
    ['no VAVAILABILITY', calendar('BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT')],
    [
      'a bounded VAVAILABILITY',
      calendar('BEGIN:VAVAILABILITY\r\nUID:v\r\nDTSTAMP:20240101T000000Z\r\nDTSTART:20240101T000000Z\r\nEND:VAVAILABILITY'),
    ],
    ['an AVAILABLE without RRULE', vavailability(available(['DTSTART:20240101T080000Z', 'DURATION:PT1H']))],
    [
      'an EXDATE',
      vavailability(
        available(['DTSTART:20240101T080000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY', 'EXDATE:20240108T080000Z']),
      ),
    ],
    ['a whole-day start', vavailability(available(['DTSTART;VALUE=DATE:20240101', 'DURATION:P1D', 'RRULE:FREQ=WEEKLY']))],
    ['seconds', vavailability(available(['DTSTART:20240101T080030Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY']))],
    ['no end', vavailability(available(['DTSTART:20240101T080000Z', 'RRULE:FREQ=WEEKLY']))],
    ['a daily rule', vavailability(available(['DTSTART:20240101T080000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY']))],
    [
      'two zones',
      vavailability(
        available(['DTSTART;TZID=Europe/Paris:20240101T080000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY']),
        available(['DTSTART;TZID=Europe/Rome:20240101T080000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY'], 1),
      ),
    ],
    ['too long', 'X'.repeat(SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS + 1)],
  ])('refuses %s as invalid_availability', (_name, text) => {
    expect(refusal(text)?.code).toBe('invalid_availability');
  });
});

const EVENT: SlotlockCalendarEvent = {
  id: '5e8ff9bf-55ba-4508-9d22-e984129be6b5',
  tenantRef: 't',
  ownerRef: 'o',
  externalRef: 'BK-1',
  resourceId: 'r',
  revision: 3,
  source: null,
  materializationWindow: { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') },
  createdAt: new Date('2026-02-01T10:00:00Z'),
  updatedAt: new Date('2026-02-02T10:00:00Z'),
  // 09:30 in London on 30 March 2026, after the clocks went forward: 08:30 UTC.
  start: new Date('2026-03-30T08:30:00Z'),
  end: new Date('2026-03-30T10:00:45Z'),
  timezone: 'Europe/London',
  summary: 'Van handover',
  description: 'Keys at the desk',
  location: 'Depot 4',
  status: 'tentative',
  transparency: 'transparent',
  organizer: { email: 'ops@example.com', name: 'Ops' },
  attendees: [
    { email: 'a@example.com', role: 'optional', participationStatus: 'needs_action', rsvp: true },
    { email: 'b@example.com', role: 'non_participant' },
  ],
  reminders: [{ action: 'display', minutesBeforeStart: 15 }],
  recurrence: {
    rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260525T083000Z',
    exceptions: [
      { recurrenceId: new Date('2026-04-06T08:30:00Z'), cancelled: true },
      {
        recurrenceId: new Date('2026-04-13T08:30:00Z'),
        start: new Date('2026-04-13T09:30:00Z'),
        end: new Date('2026-04-13T10:30:00Z'),
      },
    ],
  },
};

describe('JSCalendar (RFC 8984)', () => {
  it('writes an Event with a local start, its zone and an exact duration', () => {
    expect(toJSCalendarEvent(EVENT)).toEqual({
      '@type': 'Event',
      uid: EVENT.id,
      updated: '2026-02-02T10:00:00.000Z',
      created: '2026-02-01T10:00:00.000Z',
      sequence: 3,
      prodId: '-//Pylota//Slotlock//EN',
      title: 'Van handover',
      description: 'Keys at the desk',
      start: '2026-03-30T09:30:00',
      timeZone: 'Europe/London',
      duration: 'PT1H30M45S',
      status: 'tentative',
      freeBusyStatus: 'free',
      locations: { l1: { '@type': 'Location', name: 'Depot 4' } },
      participants: {
        p0: {
          '@type': 'Participant',
          name: 'Ops',
          email: 'ops@example.com',
          sendTo: { imip: 'mailto:ops@example.com' },
          roles: { owner: true },
        },
        p1: {
          '@type': 'Participant',
          email: 'a@example.com',
          sendTo: { imip: 'mailto:a@example.com' },
          roles: { attendee: true, optional: true },
          participationStatus: 'needs-action',
          expectReply: true,
        },
        p2: {
          '@type': 'Participant',
          email: 'b@example.com',
          sendTo: { imip: 'mailto:b@example.com' },
          roles: { informational: true },
        },
      },
      alerts: {
        a1: {
          '@type': 'Alert',
          trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
          action: 'display',
        },
      },
      recurrenceRules: [
        {
          '@type': 'RecurrenceRule',
          frequency: 'weekly',
          byDay: [{ '@type': 'NDay', day: 'mo' }],
          until: '2026-05-25T09:30:00',
        },
      ],
      recurrenceOverrides: {
        '2026-04-06T09:30:00': { excluded: true },
        '2026-04-13T09:30:00': { start: '2026-04-13T10:30:00', duration: 'PT1H' },
      },
      'slotlock.pylota.io:rrule': 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260525T083000Z',
    });
  });

  it('writes the defaults for a plain event: confirmed, busy, nothing optional', () => {
    const {
      description: _d,
      location: _l,
      status: _s,
      transparency: _t,
      organizer: _o,
      attendees: _a,
      reminders: _r,
      recurrence: _c,
      ...plain
    } = EVENT;
    const output = toJSCalendarEvent(plain);
    expect(output.status).toBe('confirmed');
    expect(output.freeBusyStatus).toBe('busy');
    expect(Object.keys(output).sort()).toEqual(
      ['@type', 'created', 'duration', 'prodId', 'sequence', 'start', 'status', 'freeBusyStatus', 'timeZone', 'title', 'uid', 'updated'].sort(),
    );
  });

  it('maps RRULE parts to RecurrenceRule, and refuses one it does not know', () => {
    expect(recurrenceRuleFromRRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;BYMONTH=1,7;BYSETPOS=1;COUNT=6;WKST=SU', 'UTC')).toEqual({
      '@type': 'RecurrenceRule',
      frequency: 'monthly',
      interval: 2,
      byDay: [{ '@type': 'NDay', day: 'fr', nthOfPeriod: -1 }],
      byMonth: ['1', '7'],
      bySetPosition: [1],
      count: 6,
      firstDayOfWeek: 'su',
    });
    expect(recurrenceRuleFromRRule('FREQ=DAILY;UNTIL=20261231', 'UTC')?.until).toBe('2026-12-31T23:59:59');
    expect(recurrenceRuleFromRRule('FREQ=DAILY;X-NAME=1', 'UTC')).toBeNull();
    expect(recurrenceRuleFromRRule('FREQ=FORTNIGHTLY', 'UTC')).toBeNull();
  });
});
