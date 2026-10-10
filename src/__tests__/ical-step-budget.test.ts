// ical.js looks for a SECONDLY to WEEKLY rule's next occurrence one step at a time with no limit
// (RecurIterator.next; MONTHLY and YEARLY give up only when whole months or years fail), so a rule
// that never occurs held the whole process. Every expansion now has a step and time budget: a rule
// that needs more is refused as invalid_icalendar, quickly, whether it came from a feed, a library
// call or the store.
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { expandCalendarEventOccurrences, parseICalendarChanges } from '../sync.js';

const WINDOW = {
  start: new Date('2026-10-01T00:00:00Z'),
  end: new Date('2027-10-01T00:00:00Z'),
};

function feed(...events: { uid: string; start: string; rule: string }[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotlock tests//EN',
    ...events.flatMap(({ uid, start, rule }) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261010T000000Z',
      `DTSTART:${start}`,
      `DTEND:${start.replace(/T(\d\d)/, (_, hour: string) => `T${String(Number(hour) + 1).padStart(2, '0')}`)}`,
      `RRULE:${rule}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

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

const refused = expect.objectContaining({ code: 'invalid_icalendar' });
const ordinary = feed({
  uid: 'standup',
  start: '20260105T090000Z',
  rule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
});

describe('the step budget on recurrence expansion', () => {
  it('refuses a rule whose next occurrence is further away than the budget allows', () => {
    // Without a budget this finishes, after about 720,000 one-minute steps to 29 February 2028.
    const { error } = timed(() =>
      parseICalendarChanges(
        feed({
          uid: 'sparse',
          start: '20261020T090000Z',
          rule: 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=29',
        }),
        'UTC',
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
  });

  // Each of these never occurs; ical.js searched for it forever.
  it.each([
    ['30 February, daily', '20261020T090000Z', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['31 April, hourly', '20261020T090000Z', 'FREQ=HOURLY;BYMONTH=4;BYMONTHDAY=31'],
    ['31 April, every minute', '20261020T090000Z', 'FREQ=MINUTELY;BYMONTH=4;BYMONTHDAY=31'],
    ['30 February, every second', '20261020T090000Z', 'FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'],
    ['the fifth Monday, daily', '20261020T090000Z', 'FREQ=DAILY;BYDAY=5MO'],
    ['Tuesdays every 7 days from a Monday', '20261019T090000Z', 'FREQ=DAILY;INTERVAL=7;BYDAY=TU'],
    // BYHOUR=8 puts ical.js's first candidate an hour before the 09:00 start, so it searches for the
    // first occurrence while it builds the iterator, before the expansion is handed back.
    [
      '30 February from an hour after its only hour',
      '20261020T090000Z',
      'FREQ=DAILY;BYHOUR=8;BYMONTH=2;BYMONTHDAY=30',
    ],
  ])('refuses %s in a feed promptly', (_name, start, rule) => {
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'never', start, rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    // The step count stops it in about a tenth of a second; on a loaded machine the feed's
    // one-second limit does, so the bound sits above that limit rather than on it.
    expect(ms).toBeLessThan(2_500);
  });

  it('bounds a library expansion the same way, which the store and the confirmation use', () => {
    const { ms, error } = timed(() =>
      expandCalendarEventOccurrences(
        {
          start: new Date('2026-10-19T09:00:00Z'),
          end: new Date('2026-10-19T10:00:00Z'),
          timezone: 'Europe/London',
          summary: 'Busy',
          recurrence: { rrule: 'FREQ=DAILY;INTERVAL=7;BYDAY=TU' },
        },
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeLessThan(1_000);
  });

  it('shares one budget among all the events of a feed', () => {
    // A yearly date written as a daily rule takes a step a day: from 1950 that is about 28,400
    // steps, so one fits the budget of 50,000 and two do not.
    const yearly = (uid: string) => ({
      uid,
      start: '19500101T090000Z',
      rule: 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=1',
    });
    expect(parseICalendarChanges(feed(yearly('one')), 'UTC', WINDOW)).toHaveLength(1);
    const { error } = timed(() =>
      parseICalendarChanges(feed(yearly('a'), yearly('b')), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
  });

  // ical.js moves a SECONDLY to WEEKLY rule a day at a time within one step, uncharged, so a step
  // may move at most a century: FREQ=DAILY;INTERVAL=1000000000 spent 97 seconds in one step.
  it.each([
    ['SECONDLY', 3_162_240_000],
    ['MINUTELY', 52_704_000],
    ['HOURLY', 878_400],
    ['DAILY', 36_600],
    ['WEEKLY', 5_228],
  ])('allows a %s step of up to a century (INTERVAL=%i) and refuses a longer one', (freq, max) => {
    const parse = (interval: number) =>
      timed(() =>
        parseICalendarChanges(
          feed({
            uid: 'far',
            start: '20261020T090000Z',
            rule: `FREQ=${freq};INTERVAL=${interval}`,
          }),
          'UTC',
          WINDOW,
        ),
      );
    expect(parse(max).error).toBeNull();
    const longer = parse(max + 1);
    expect(longer.error).toEqual(refused);
    expect(longer.ms).toBeLessThan(100);
    expect(parse(max * 1_000).error).toEqual(refused);
  });

  it('does not cap MONTHLY or YEARLY steps, which ical.js adds in one go', () => {
    // A thousand years at a step, ten times the century the other frequencies may move.
    for (const rule of ['FREQ=MONTHLY;INTERVAL=12000', 'FREQ=YEARLY;INTERVAL=1000']) {
      let changes: unknown = null;
      const { ms, error } = timed(() => {
        changes = parseICalendarChanges(
          feed({ uid: 'far', start: '20261020T090000Z', rule }),
          'UTC',
          WINDOW,
        );
      });
      expect(error).toBeNull();
      expect(ms).toBeLessThan(100);
      expect(changes).toHaveLength(1);
    }
  });

  // These take few steps but slow ones, so the count alone would let them run for minutes. The time
  // limit stops them: a second for a feed, a quarter of one for a single event (a stored series,
  // or an agent's).
  const slow = [
    // A step of a century, the most allowed, walked a day at a time: about 4 ms each.
    ['29 February a century at a time', 'FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=29'],
    // ical.js expands every year's days for each yearly step.
    [
      'any weekday on 30 February, yearly',
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU',
    ],
  ];

  it.each(slow)('refuses %s in a feed after a second', (_name, rule) => {
    const { ms, error } = timed(() =>
      parseICalendarChanges(feed({ uid: 'slow', start: '20261020T090000Z', rule }), 'UTC', WINDOW),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(2_500);
  });

  it.each(slow)('refuses %s as one event after a quarter of a second', (_name, rule) => {
    const { ms, error } = timed(() =>
      expandCalendarEventOccurrences(
        {
          start: new Date('2026-10-20T09:00:00Z'),
          end: new Date('2026-10-20T10:00:00Z'),
          timezone: 'UTC',
          summary: 'Busy',
          recurrence: { rrule: rule },
        },
        WINDOW,
      ),
    );
    expect(error).toEqual(refused);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1_000);
  });

  it('leaves ical.js itself as it was', () => {
    const methods = Object.getOwnPropertyNames(ICAL.RecurIterator.prototype);
    const before = methods.map(
      (name) => (ICAL.RecurIterator.prototype as unknown as Record<string, unknown>)[name],
    );
    const iterator = ICAL.Recur.prototype.iterator;
    expect(() =>
      parseICalendarChanges(
        feed({
          uid: 'never',
          start: '20261020T090000Z',
          rule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
        }),
        'UTC',
        WINDOW,
      ),
    ).toThrow();
    expect(
      methods.map(
        (name) => (ICAL.RecurIterator.prototype as unknown as Record<string, unknown>)[name],
      ),
    ).toEqual(before);
    expect(ICAL.Recur.prototype.iterator).toBe(iterator);
  });

  it('refuses every recurring event if ical.js no longer has a method it charges', () => {
    const prototype = ICAL.RecurIterator.prototype as unknown as Record<string, unknown>;
    const expandYearDays = prototype.expand_year_days;
    prototype.expand_year_days = undefined;
    try {
      expect(timed(() => parseICalendarChanges(ordinary, 'UTC', WINDOW)).error).toEqual(refused);
    } finally {
      prototype.expand_year_days = expandYearDays;
    }
    expect(parseICalendarChanges(ordinary, 'UTC', WINDOW)).toHaveLength(261);
  });

  it('refuses every recurring event if ical.js stops building its iterators from the event rules', () => {
    const eventIterator = ICAL.Event.prototype.iterator;
    ICAL.Event.prototype.iterator = function (this: ICAL.Event, start?: ICAL.Time) {
      const copy = new ICAL.Component(this.component.toJSON());
      return new ICAL.RecurExpansion({ component: copy, dtstart: start ?? this.startDate });
    };
    try {
      expect(timed(() => parseICalendarChanges(ordinary, 'UTC', WINDOW)).error).toEqual(refused);
    } finally {
      ICAL.Event.prototype.iterator = eventIterator;
    }
  });

  it('still reads an ordinary feed in full', () => {
    const changes = parseICalendarChanges(
      feed(
        { uid: 'standup', start: '20250106T090000Z', rule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR' },
        { uid: 'review', start: '20200106T140000Z', rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' },
        { uid: 'payroll', start: '20180126T100000Z', rule: 'FREQ=MONTHLY;BYDAY=-1FR' },
        { uid: 'service', start: '20100301T080000Z', rule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1' },
        { uid: 'leap', start: '20080229T080000Z', rule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29' },
      ),
      'UTC',
      WINDOW,
    );
    const count = (uid: string) => changes.filter((change) => change.externalId === uid).length;
    // 2026-10-01 to 2027-10-01: 261 weekdays, 26 fortnightly Mondays, 12 last Fridays, one 1 March,
    // and no 29 February.
    expect([
      count('standup'),
      count('review'),
      count('payroll'),
      count('service'),
      count('leap'),
    ]).toEqual([261, 26, 12, 1, 0]);
  });
});
