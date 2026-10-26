// Fuzzing the iCalendar boundary, where untrusted feeds arrive. Generated feeds (lines from the
// grammar, mutated real feeds, and noise) must parse into well-formed changes or be refused as a
// CalendarContractError: never another exception, never a malformed change. And what Slotlock
// emits, the trusted parser must read back with the same text and times.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  emitICalendar,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from '../sync.js';

const WINDOW = { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-03-01T00:00:00Z') };
const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Slotlock fuzz//EN',
  'BEGIN:VEVENT',
  'UID:busy-1',
  'DTSTAMP:20270101T000000Z',
  'DTSTART:20270102T090000Z',
  'DTEND:20270102T100000Z',
  'SEQUENCE:4',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series-1',
  'DTSTAMP:20270101T000000Z',
  'DTSTART;TZID=Europe/London:20270104T090000',
  'DTEND;TZID=Europe/London:20270104T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=10',
  'EXDATE;TZID=Europe/London:20270107T090000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series-1',
  'RECURRENCE-ID;TZID=Europe/London:20270111T090000',
  'DTSTAMP:20270101T000000Z',
  'DTSTART;TZID=Europe/London:20270111T110000',
  'DTEND;TZID=Europe/London:20270111T120000',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
];
/** Lines a feed is made of, valid and almost valid. */
const LINES = [
  ...FEED,
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'BEGIN:STANDARD',
  'END:STANDARD',
  'END:VTIMEZONE',
  'DTSTART;VALUE=DATE:20270105',
  'DTEND;VALUE=DATE:20270106',
  'DURATION:PT1H',
  'DURATION:-P1D',
  'RRULE:FREQ=DAILY',
  'RRULE:FREQ=SECONDLY;INTERVAL=1',
  'RRULE:FREQ=YEARLY;BYYEARDAY=-366;COUNT=3',
  'RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20280101T000000Z',
  'RDATE:20270120T090000Z,20270121T090000Z',
  'EXDATE:20270102T090000Z',
  'TRANSP:TRANSPARENT',
  'STATUS:TENTATIVE',
  'SEQUENCE:99999999999999999999',
  'SEQUENCE:-1',
  'DTSTART:20270102T090000',
  'DTSTART:99991231T235959Z',
  'DTEND:20270101T000000Z',
  'X-WR-TIMEZONE:Mars/Olympus',
  'X-WR-TIMEZONE:America/New_York',
  'UID:',
  ' folded continuation',
  'SUMMARY:a\\, b\; c\\n d',
];

const isWellFormed = (change: Record<string, unknown>) => {
  expect(typeof change.externalId).toBe('string');
  expect((change.externalId as string).trim()).not.toBe('');
  expect(typeof change.deleted).toBe('boolean');
  expect(typeof change.busy).toBe('boolean');
  expect(Number.isSafeInteger(change.revision) && (change.revision as number) >= 0).toBe(true);
  for (const key of ['start', 'end'] as const) {
    const value = change[key];
    if (value !== null) {
      expect(value).toBeInstanceOf(Date);
      expect(Number.isFinite((value as Date).getTime())).toBe(true);
    }
  }
  if (change.start && change.end) {
    expect((change.start as Date).getTime()).toBeLessThan((change.end as Date).getTime());
  }
  if (change.recurrenceId !== undefined) {
    expect(new Date(change.recurrenceId as string).toISOString()).toBe(change.recurrenceId);
  }
};

/** Run a parser: what it returns, or the CalendarContractError it refuses with. Nothing else. */
function outcome<T>(parse: () => T): T | CalendarContractError {
  try {
    return parse();
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarContractError);
    return error as CalendarContractError;
  }
}

/** Property lines an event may hold: every line above that does not open or close a component. */
const PROPERTIES = LINES.filter((line) => !/^(BEGIN|END):/.test(line));
/** Calendars of events whose properties are drawn from the grammar, with some noise. */
const grammarFeed = fc
  .tuple(
    fc.array(fc.constantFrom('X-WR-TIMEZONE:America/New_York', 'X-WR-TIMEZONE:Mars/Olympus', 'METHOD:PUBLISH'), {
      maxLength: 2,
    }),
    fc.array(
      fc.tuple(
        fc.constantFrom('a', 'b', 'series-1', ' ', 'x'.repeat(1_100)),
        // A valid start and end, so a feed gets past its first event more often than not.
        fc.constantFrom(
          ['DTSTART:20270102T090000Z', 'DTEND:20270102T100000Z'],
          ['DTSTART;TZID=Europe/London:20270104T090000', 'DTEND;TZID=Europe/London:20270104T100000'],
          ['DTSTART;VALUE=DATE:20270105', 'DTEND;VALUE=DATE:20270106'],
          ['DTSTART:20270110T120000Z', 'DURATION:PT1H'],
        ),
        fc.array(
          fc.oneof({ weight: 8, arbitrary: fc.constantFrom(...PROPERTIES) }, fc.string({ maxLength: 30 })),
          { maxLength: 3 },
        ),
      ),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([header, events]) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Slotlock fuzz//EN',
      ...header,
      ...events.flatMap(([uid, times, properties]) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'DTSTAMP:20270101T000000Z',
        ...times,
        ...properties,
        'END:VEVENT',
      ]),
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
const mutatedFeed = fc
  .array(
    fc.record({
      at: fc.nat({ max: FEED.length - 1 }),
      kind: fc.constantFrom('delete', 'duplicate', 'replace', 'swap', 'splice'),
      line: fc.constantFrom(...LINES),
      text: fc.string({ maxLength: 12 }),
      offset: fc.nat({ max: 40 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((edits) => {
    const lines = [...FEED];
    for (const { at, kind, line, text, offset } of edits) {
      const index = at % lines.length;
      const current = lines[index] ?? '';
      if (kind === 'delete') lines.splice(index, 1);
      else if (kind === 'duplicate') lines.splice(index, 0, current);
      else if (kind === 'replace') lines[index] = line;
      else if (kind === 'swap') lines.splice(index, 1, line, current);
      else lines[index] = current.slice(0, offset) + text + current.slice(offset);
      if (lines.length === 0) lines.push(line);
    }
    return `${lines.join('\r\n')}\r\n`;
  });

describe('iCalendar parsing of untrusted feeds', () => {
  it('returns well-formed changes or refuses with CalendarContractError, whatever the feed', () => {
    fc.assert(
      fc.property(fc.oneof(grammarFeed, mutatedFeed, fc.string({ maxLength: 400 })), (feed) => {
        const changes = outcome(() => parseICalendarChanges(feed, 'UTC', WINDOW));
        if (Array.isArray(changes)) for (const change of changes) isWellFormed(change as never);
        const events = outcome(() => parseTrustedICalendarEvents(feed, 'UTC'));
        if (Array.isArray(events)) {
          for (const event of events) {
            expect(event.start.getTime()).toBeLessThan(event.end.getTime());
            expect(event.uid.trim()).not.toBe('');
          }
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

/** Text as people and agents type it, with the characters iCalendar has to escape. */
const text = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 4 }) },
      fc.constantFrom(',', ';', ':', '\\', '\n', '\r\n', '\t', '"', ' ', 'é', '漢', '👩‍🔧', '\\n'),
    ),
    { minLength: 1, maxLength: 30 },
  )
  .map((parts) => parts.join(''))
  .filter((value) => value.trim().length > 0 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.replace(/\r\n/g, '')));
/** Text as Slotlock keeps it: trimmed, its line breaks LF. */
const kept = (value: string) => value.replace(/\r\n/g, '\n').trim();

describe('iCalendar written by Slotlock', () => {
  it('reads back with the same text, times and identity', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9@._-]{0,40}$/),
        fc.integer({ min: Date.UTC(2027, 0, 1) / 60_000, max: Date.UTC(2030, 0, 1) / 60_000 }),
        fc.integer({ min: 1, max: 10_080 }),
        text,
        fc.option(text, { nil: undefined }),
        fc.option(text, { nil: undefined }),
        fc.nat({ max: 1_000 }),
        (uid, startMinute, minutes, summary, description, location, sequence) => {
          const start = new Date(startMinute * 60_000);
          const end = new Date(start.getTime() + minutes * 60_000);
          const event = {
            uid,
            start,
            end,
            summary,
            sequence,
            ...(description !== undefined ? { description } : {}),
            ...(location !== undefined ? { location } : {}),
          };
          const [read, ...rest] = parseTrustedICalendarEvents(emitICalendar(event), 'UTC');
          expect(rest).toEqual([]);
          expect(read).toMatchObject({ uid, start, end, sequence, summary: kept(summary) });
          expect(read?.description).toBe(description === undefined ? undefined : kept(description) || undefined);
          expect(read?.location).toBe(location === undefined ? undefined : kept(location) || undefined);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('refuses text with a lone CR or another control character, wherever it is', () => {
    fc.assert(
      fc.property(
        text,
        fc.constantFrom('\r', '\u0000', '\u000b', '\u001b', '\u007f'),
        fc.nat(),
        fc.constantFrom('summary', 'description', 'location'),
        (value, control, at, field) => {
          const index = at % (value.length + 1);
          const hostile = `x${value.slice(0, index)}${control}x${value.slice(index)}`;
          const event = {
            uid: 'control@example.com',
            start: new Date('2027-01-01T09:00:00Z'),
            end: new Date('2027-01-01T10:00:00Z'),
            summary: 'Handover',
            [field]: hostile,
          };
          expect(() => emitICalendar(event)).toThrowError(CalendarContractError);
        },
      ),
      { numRuns: 300 },
    );
  });
});
