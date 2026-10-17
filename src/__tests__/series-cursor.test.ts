// A stored series is expanded again each time maintenance rolls its window forward. From its start,
// that search grows with the series' age until the limits refuse it (a daily series after about 11
// years). Each expansion now leaves a cursor where ical.js stopped, and the next one resumes there.
// A cursor is only a shortcut: whatever it resumes must be exactly what a search from the start
// finds, and anything it cannot vouch for is searched from the start.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  ICAL_JS_VERSION,
  expandCalendarEventSeries,
  expandStoredCalendarEventOccurrences,
} from '../sync.js';
import { zonedDateTimeToUtc } from '../timezone.js';
import type { CalendarEventContent, CalendarRecurrenceException } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const d = (iso: string) => new Date(iso);
const windowFrom = (start: Date, days = 367) => ({
  start,
  end: new Date(start.getTime() + days * DAY),
});

function fromStart(event: CalendarEventContent, window: { start: Date; end: Date }) {
  try {
    return expandStoredCalendarEventOccurrences(event, window);
  } catch (error) {
    if (error instanceof CalendarExpansionLimitError) return null;
    throw error;
  }
}

/** The search from the start, or why it refused: `limit`, or another contract code. */
function fromStartOrCode(event: CalendarEventContent, window: { start: Date; end: Date }) {
  try {
    return expandStoredCalendarEventOccurrences(event, window);
  } catch (error) {
    if (error instanceof CalendarExpansionLimitError) return 'limit';
    if (error instanceof CalendarContractError) return error.code;
    throw error;
  }
}

/** Roll `event` through `windows` as the store does, keeping the cursor a refusal leaves alone. */
function roll(event: CalendarEventContent, windows: { start: Date; end: Date }[], cursor: unknown) {
  const results = [];
  const codes: (string | null)[] = [];
  for (const window of windows) {
    try {
      const expanded = expandCalendarEventSeries(event, window, { cursor, stored: true });
      cursor = expanded.cursor;
      results.push(expanded);
      codes.push(null);
    } catch (error) {
      if (!(error instanceof CalendarContractError)) throw error;
      results.push(null);
      codes.push(error instanceof CalendarExpansionLimitError ? 'limit' : error.code);
    }
  }
  return { results, codes, cursor };
}

const london = (date: string, time: string) =>
  zonedDateTimeToUtc(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3, 5)),
      second: 0,
    },
    'Europe/London',
  );

const dailySince2011: CalendarEventContent = {
  start: london('2011-03-01', '09:00'),
  end: london('2011-03-01', '10:00'),
  timezone: 'Europe/London',
  summary: 'Morning handover',
  recurrence: { rrule: 'FREQ=DAILY' },
};
const yearly = (from: Date, years: number) =>
  Array.from({ length: years + 1 }, (_, year) =>
    windowFrom(new Date(from.getTime() + year * 365 * DAY)),
  );

describe('expanding a stored series from where the last expansion left off', () => {
  it('pins the ical.js the cursor format was written for', () => {
    const installed = JSON.parse(
      readFileSync(new URL('../../node_modules/ical.js/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    // A cursor is ical.js's own iterator state. Upgrading ical.js means checking that state again:
    // until then every cursor an older version wrote is ignored.
    expect(ICAL_JS_VERSION).toBe(installed.version);
  });

  it('keeps rolling a daily series started 15 years ago', { timeout: 60_000 }, () => {
    const today = windowFrom(d('2026-10-09T00:00:00Z'));
    // From its start, the search is past what Slotlock expands.
    expect(() => expandStoredCalendarEventOccurrences(dailySince2011, today)).toThrow(
      CalendarExpansionLimitError,
    );

    const windows = yearly(d('2011-02-28T00:00:00Z'), 15);
    const { results } = roll(dailySince2011, windows, null);
    expect(results.every((result) => result !== null)).toBe(true);
    // The first window starts before the series, so nothing is behind it to leave a cursor for the
    // second; every later one resumes.
    expect(results.slice(2).every((result) => result?.resumed)).toBe(true);
    const last = results.at(-1);
    const lastWindow = windows.at(-1) as { start: Date; end: Date };
    expect(last?.occurrences).toHaveLength(367);
    for (const occurrence of last?.occurrences ?? []) {
      const day = occurrence.start.toISOString().slice(0, 10);
      expect(occurrence.start).toEqual(london(day, '09:00'));
      expect(occurrence.end.getTime() - occurrence.start.getTime()).toBe(60 * 60 * 1000);
      expect(occurrence.recurrenceId).toBe(occurrence.start.toISOString());
    }
    expect(last?.occurrences[0]?.start.getTime()).toBeGreaterThanOrEqual(
      lastWindow.start.getTime(),
    );
    // Each year's expansion matches the search from the start for as long as that search fits.
    for (const [index, window] of windows.entries()) {
      const expected = fromStart(dailySince2011, window);
      if (expected) expect(results[index]?.occurrences).toEqual(expected);
    }
  });

  it('counts a COUNT series to its end across cursors', { timeout: 60_000 }, () => {
    const event = { ...dailySince2011, recurrence: { rrule: 'FREQ=DAILY;COUNT=5000' } };
    const windows = yearly(d('2011-02-28T00:00:00Z'), 15);
    const { results } = roll(event, windows, null);
    const all = new Map<string, Date>();
    for (const result of results) {
      for (const occurrence of result?.occurrences ?? []) {
        all.set(occurrence.recurrenceId, occurrence.start);
      }
    }
    expect(all.size).toBe(5000);
    const lastStart = [...all.values()].sort((a, b) => a.getTime() - b.getTime()).at(-1);
    expect(lastStart).toEqual(london('2024-11-06', '09:00'));
  });

  it('counts a COUNT series with several times a day to its end, resuming among its times', () => {
    // ical.js keeps its place in BYHOUR as an index: resumed elsewhere in the list, it would
    // revisit a time it has passed and count it again, ending the series early.
    const event: CalendarEventContent = {
      start: d('2027-01-04T09:00:00Z'),
      end: d('2027-01-04T09:30:00Z'),
      timezone: 'UTC',
      summary: 'Inspection',
      recurrence: { rrule: 'FREQ=DAILY;BYHOUR=9,13,17;COUNT=300' },
    };
    const windows = Array.from({ length: 12 }, (_, step) =>
      windowFrom(new Date(d('2027-01-03T14:00:00Z').getTime() + step * 10 * DAY), 10),
    );
    const { results } = roll(event, windows, null);
    expect(results.slice(1).some((result) => result?.resumed)).toBe(true);
    const all = new Map<string, Date>();
    for (const [index, window] of windows.entries()) {
      expect(results[index]?.occurrences, `window ${index}`).toEqual(fromStart(event, window));
      for (const occurrence of results[index]?.occurrences ?? []) {
        all.set(occurrence.recurrenceId, occurrence.start);
      }
    }
    expect(all.size).toBe(300);
  });

  it('resumes a yearly rule within its year, where ical.js keeps its place among the days', () => {
    const event: CalendarEventContent = {
      ...dailySince2011,
      recurrence: { rrule: 'FREQ=YEARLY;BYYEARDAY=1,60,100,200,300,-1' },
    };
    // Windows that start mid-year, so a cursor stands between two of the year's days.
    const windows = [0, 1, 2, 3, 4, 5].map((step) =>
      windowFrom(new Date(d('2011-05-01T00:00:00Z').getTime() + step * 130 * DAY), 200),
    );
    const { results } = roll(event, windows, null);
    expect(results.slice(1).some((result) => result?.resumed)).toBe(true);
    for (const [index, window] of windows.entries()) {
      expect(results[index]?.occurrences).toEqual(fromStart(event, window));
    }
  });

  it('keeps an occurrence the clocks going back stretch into the window', () => {
    // Two hours from 00:30 on the night London's clocks go back (02:00 BST is 01:00 GMT): ical.js
    // adds the length in wall-clock time, so that occurrence runs from 23:30Z to 02:30Z, three hours,
    // and reaches a window starting at 02:00Z although its start plus its length does not.
    const event: CalendarEventContent = {
      start: london('2026-10-20', '00:30'),
      end: london('2026-10-20', '02:30'),
      timezone: 'Europe/London',
      summary: 'Night shift handover',
      recurrence: { rrule: 'FREQ=DAILY' },
    };
    const window = windowFrom(d('2026-10-25T02:00:00Z'), 30);
    const first = expandCalendarEventSeries(event, window, { cursor: null, stored: true });
    const again = expandCalendarEventSeries(event, window, { cursor: first.cursor, stored: true });
    expect(again.resumed).toBe(true);
    expect(again.occurrences).toEqual(fromStart(event, window));
    expect(again.occurrences[0]).toEqual({
      recurrenceId: '2026-10-24T23:30:00.000Z',
      start: d('2026-10-24T23:30:00Z'),
      end: d('2026-10-25T02:30:00Z'),
    });
  });

  it('ends a series that has ended, and stays ended', () => {
    const event = { ...dailySince2011, recurrence: { rrule: 'FREQ=DAILY;UNTIL=20120101T000000Z' } };
    const windows = yearly(d('2011-02-28T00:00:00Z'), 4);
    const { results } = roll(event, windows, null);
    expect(results[0]?.occurrences.length).toBeGreaterThan(300);
    expect(results.slice(1).map((result) => result?.occurrences.length)).toEqual([0, 0, 0, 0]);
    expect(results.slice(2).every((result) => result?.resumed)).toBe(true);
  });

  describe('searches from the start whenever a cursor cannot vouch for what it skips', () => {
    const windows = yearly(d('2011-02-28T00:00:00Z'), 2);
    const cursor = () => roll(dailySince2011, windows.slice(0, 2), null).cursor;
    const third = windows[2] as { start: Date; end: Date };

    it('uses a cursor that can', () => {
      const resumed = expandCalendarEventSeries(dailySince2011, third, {
        cursor: cursor(),
        stored: true,
      });
      expect(resumed.resumed).toBe(true);
      expect(resumed.occurrences).toEqual(fromStart(dailySince2011, third));
    });

    it.each<[string, (event: CalendarEventContent) => CalendarEventContent]>([
      [
        'the rule changed',
        (event) => ({ ...event, recurrence: { rrule: 'FREQ=DAILY;INTERVAL=2' } }),
      ],
      [
        'the series starts at another time',
        (event) => ({
          ...event,
          start: new Date(event.start.getTime() + 60 * 60 * 1000),
          end: new Date(event.end.getTime() + 60 * 60 * 1000),
        }),
      ],
      ['the series is in another zone', (event) => ({ ...event, timezone: 'Europe/Dublin' })],
    ])('%s', (_name, change) => {
      const event = change(dailySince2011);
      const expanded = expandCalendarEventSeries(event, third, { cursor: cursor(), stored: true });
      expect(expanded.resumed).toBe(false);
      expect(expanded.occurrences).toEqual(fromStart(event, third));
    });

    it('a window starting before the cursor', () => {
      const earlier = windows[0] as { start: Date; end: Date };
      const expanded = expandCalendarEventSeries(dailySince2011, earlier, {
        cursor: cursor(),
        stored: true,
      });
      expect(expanded.resumed).toBe(false);
      expect(expanded.occurrences).toEqual(fromStart(dailySince2011, earlier));
    });

    it('a longer event, which an occurrence before the cursor may now reach into the window', () => {
      const event = {
        ...dailySince2011,
        end: new Date(dailySince2011.start.getTime() + 400 * DAY),
      };
      const expanded = expandCalendarEventSeries(event, third, { cursor: cursor(), stored: true });
      expect(expanded.resumed).toBe(false);
    });

    it('an occurrence before the cursor moved into the window', () => {
      const moved: CalendarRecurrenceException = {
        recurrenceId: london('2011-06-01', '09:00'),
        start: d('2013-03-10T15:00:00Z'),
        end: d('2013-03-10T16:00:00Z'),
      };
      const event = { ...dailySince2011, recurrence: { rrule: 'FREQ=DAILY', exceptions: [moved] } };
      const expanded = expandCalendarEventSeries(event, third, { cursor: cursor(), stored: true });
      expect(expanded.resumed).toBe(false);
      expect(expanded.occurrences).toEqual(fromStart(event, third));
      expect(expanded.occurrences.map((occurrence) => occurrence.start)).toContainEqual(
        moved.start,
      );
    });

    it('but not an occurrence before it that was cancelled, or moved and still before the window', () => {
      const exceptions: CalendarRecurrenceException[] = [
        { recurrenceId: london('2011-06-01', '09:00'), cancelled: true },
        {
          recurrenceId: london('2011-06-02', '09:00'),
          start: d('2011-07-02T15:00:00Z'),
          end: d('2011-07-02T16:00:00Z'),
        },
      ];
      const event = { ...dailySince2011, recurrence: { rrule: 'FREQ=DAILY', exceptions } };
      const expanded = expandCalendarEventSeries(event, third, { cursor: cursor(), stored: true });
      expect(expanded.resumed).toBe(true);
      expect(expanded.occurrences).toEqual(fromStart(event, third));
    });

    it.each<[string, (cursor: Record<string, unknown>) => unknown]>([
      ['another ical.js wrote it', (c) => ({ ...c, ical: '2.2.0' })],
      ['another cursor format', (c) => ({ ...c, v: 2 })],
      ['it is not an object', () => 'cursor'],
      ['its iterator is missing', ({ iterator: _, ...c }) => c],
      ['its position is not a time', (c) => ({ ...c, position: 'soon' })],
      [
        'its iterator state is malformed',
        (c) => ({ ...c, iterator: { ...(c.iterator as object), days_index: -1 } }),
      ],
      [
        'its place among the days is past them',
        (c) => ({ ...c, iterator: { ...(c.iterator as object), days_index: 5 } }),
      ],
      [
        'a time in it is malformed',
        (c) => ({
          ...c,
          iterator: { ...(c.iterator as object), last: [2013, 13, 1, 9, 0, 0, false] },
        }),
      ],
    ])('%s', (_name, corrupt) => {
      const expanded = expandCalendarEventSeries(dailySince2011, third, {
        cursor: corrupt(cursor() as Record<string, unknown>),
        stored: true,
      });
      expect(expanded.resumed).toBe(false);
      expect(expanded.occurrences).toEqual(fromStart(dailySince2011, third));
    });
  });

  it('leaves a cursor that a fresh expansion would leave, so either can be stored', () => {
    const windows = yearly(d('2011-02-28T00:00:00Z'), 3);
    const resumed = roll(dailySince2011, windows, null).cursor;
    const fresh = expandCalendarEventSeries(
      dailySince2011,
      windows[3] as { start: Date; end: Date },
      {
        cursor: null,
        stored: true,
      },
    ).cursor;
    expect(resumed).toEqual(fresh);
    // It is plain JSON, as a jsonb column returns it.
    expect(JSON.parse(JSON.stringify(resumed))).toEqual(resumed);
  });
});

/** mulberry32: a small seeded generator, so a failure names its case. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RULES = [
  'FREQ=DAILY;BYHOUR=1,2,3;COUNT=1500',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=400',
  'FREQ=MONTHLY;BYMONTHDAY=1,10,20;COUNT=200',
  'FREQ=DAILY',
  'FREQ=DAILY;INTERVAL=3',
  'FREQ=DAILY;BYDAY=MO,WE,FR',
  'FREQ=DAILY;BYMONTH=1,7',
  'FREQ=DAILY;BYHOUR=9,17',
  'FREQ=DAILY;COUNT=900',
  'FREQ=WEEKLY;BYDAY=TU,TH',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA;WKST=MO',
  'FREQ=WEEKLY;INTERVAL=3;COUNT=300',
  'FREQ=MONTHLY;BYMONTHDAY=31',
  'FREQ=MONTHLY;BYMONTHDAY=-1',
  'FREQ=MONTHLY;BYDAY=-1FR',
  'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU',
  'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
  'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=250',
  'FREQ=YEARLY',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
  'FREQ=YEARLY;BYYEARDAY=1,100,200,-1',
  'FREQ=YEARLY;BYWEEKNO=1,20;BYDAY=MO',
  'FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU',
  'FREQ=YEARLY;BYMONTH=6;BYDAY=MO,FR;BYSETPOS=1,-1',
  'FREQ=HOURLY;INTERVAL=7',
  'FREQ=HOURLY;BYHOUR=1,2,3',
  'FREQ=DAILY;UNTIL=20190601T000000Z',
];
const ZONES = [
  'UTC',
  'Europe/London',
  'America/New_York',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'America/Sao_Paulo',
];
const TIMES = ['00:30', '01:30', '02:30', '09:00', '23:30'];
const LENGTHS_MS = [30 * 60 * 1000, 60 * 60 * 1000, 25 * 60 * 60 * 1000, 3 * DAY];
const STEPS_DAYS = [1, 7, 30, 180, 365, 900];

/** One seeded case: a series, its exceptions, and the windows it is rolled through. */
function seededCase(seed: number) {
  const next = random(seed + 1);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
  const timezone = pick(ZONES);
  const time = pick(TIMES);
  const year = 2005 + Math.floor(next() * 18);
  const month = 1 + Math.floor(next() * 12);
  const day = 1 + Math.floor(next() * 28);
  const start = zonedDateTimeToUtc(
    {
      year,
      month,
      day,
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3)),
      second: 0,
    },
    timezone,
  );
  const rrule = pick(RULES);
  const length = pick(LENGTHS_MS);
  const event: CalendarEventContent = {
    start,
    end: new Date(start.getTime() + length),
    timezone,
    summary: 'Busy',
    recurrence: { rrule },
  };
  const span = next() < 0.5 ? 367 : 60 + Math.floor(next() * 300);
  let at = new Date(start.getTime() - Math.floor(next() * 40) * DAY);
  const windows = [windowFrom(at, span)];
  for (let step = 0; step < 6; step++) {
    at = new Date(at.getTime() + pick(STEPS_DAYS) * DAY);
    windows.push(windowFrom(at, span));
  }

  // Exceptions on real occurrences: cancelled, moved later (perhaps past several windows), or
  // moved a little earlier.
  const exceptions: CalendarRecurrenceException[] = [];
  const seen = new Set<number>();
  for (const window of [windows[0], windows[3]]) {
    // A series refused for any reason (a 30-minute occurrence in a clock change's gap ends before
    // it starts) offers no occurrences to change.
    const listed = window ? fromStartOrCode(event, window) : [];
    const occurrences = Array.isArray(listed) ? listed : [];
    for (let count = Math.floor(next() * 3); count > 0 && occurrences.length > 0; count--) {
      const occurrence = pick(occurrences);
      if (seen.has(Date.parse(occurrence.recurrenceId))) continue;
      seen.add(Date.parse(occurrence.recurrenceId));
      const recurrenceId = new Date(occurrence.recurrenceId);
      const shape = next();
      if (shape < 0.3) {
        exceptions.push({ recurrenceId, cancelled: true });
      } else {
        const shift = shape < 0.8 ? pick([1, 40, 200, 500]) * DAY : -DAY / 2;
        exceptions.push({
          recurrenceId,
          start: new Date(occurrence.start.getTime() + shift),
          end: new Date(occurrence.end.getTime() + shift),
        });
      }
    }
  }
  if (exceptions.length > 0) event.recurrence = { rrule, exceptions };
  return { event, windows, rrule, timezone };
}

describe('a resumed expansion is the search from the start (seeded cases)', () => {
  const cases = Array.from({ length: 160 }, (_, seed) => seed);
  let resumedWindows = 0;
  let rescuedWindows = 0;

  it.each(cases)('case %i', { timeout: 60_000 }, (seed) => {
    const { event, windows, rrule, timezone } = seededCase(seed);
    const { results, codes } = roll(event, windows, null);
    for (const [index, window] of windows.entries()) {
      const expected = fromStartOrCode(event, window);
      if (expected === 'limit') {
        if (results[index]) rescuedWindows += 1;
        continue;
      }
      if (typeof expected === 'string') {
        expect(codes[index], `window ${index} of ${rrule} in ${timezone}`).toBe(expected);
        continue;
      }
      expect(results[index], `window ${index} of ${rrule} in ${timezone}`).not.toBeNull();
      expect(results[index]?.occurrences, `window ${index} of ${rrule} in ${timezone}`).toEqual(
        expected,
      );
      if (results[index]?.resumed) resumedWindows += 1;
    }
  });

  it('resumed most windows, and rolled some the search from the start refuses', () => {
    expect(resumedWindows).toBeGreaterThan(cases.length * 3);
    expect(rescuedWindows).toBeGreaterThan(0);
  });
});
