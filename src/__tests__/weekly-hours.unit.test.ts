// Bookable hours as people edit them (a week of windows) and as Slotlock stores them (weekly
// rules), and the one validator every writer of rules goes through.
import { describe, expect, it } from 'vitest';
import { expandRules } from '../rules.js';
import {
  SLOTLOCK_MAX_AVAILABILITY_RULES,
  type WeeklyHours,
  availabilityRuleProblem,
  parseAvailabilityRules,
  rulesToWeeklyHours,
  weeklyHoursToRules,
} from '../weekly-hours.js';

const closedWeek = (): WeeklyHours => ({ MO: [], TU: [], WE: [], TH: [], FR: [], SA: [], SU: [] });
const at = (hours: number, minutes = 0) => hours * 60 + minutes;

describe('availability rule validation', () => {
  it('accepts a weekly rule with BYDAY, a start in the day and a length up to a week', () => {
    expect(
      availabilityRuleProblem({
        rrule: 'FREQ=WEEKLY;BYDAY=MO,FR',
        startMinutes: 540,
        durationMinutes: 480,
      }),
    ).toBeNull();
    expect(
      availabilityRuleProblem({
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        startMinutes: 0,
        durationMinutes: 10_080,
      }),
    ).toBeNull();
  });

  it.each([
    ['not an object', 'MO'],
    [
      'an extra key',
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 60, zone: 'UTC' },
    ],
    ['no rrule', { startMinutes: 0, durationMinutes: 60 }],
    ['an empty rrule', { rrule: '', startMinutes: 0, durationMinutes: 60 }],
    [
      'a 501-character rrule',
      { rrule: `FREQ=WEEKLY;BYDAY=MO;${'X'.repeat(480)}`, startMinutes: 0, durationMinutes: 60 },
    ],
    [
      'a start before midnight',
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: -1, durationMinutes: 60 },
    ],
    [
      'a start past the day',
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 1_440, durationMinutes: 60 },
    ],
    [
      'a fractional start',
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 1.5, durationMinutes: 60 },
    ],
    ['no length', { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 0 }],
    [
      'more than a week',
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 10_081 },
    ],
  ])('refuses the shape of %s', (_name, candidate) => {
    expect(availabilityRuleProblem(candidate)).toBe('shape');
  });

  it.each([
    ['a daily rule', 'FREQ=DAILY'],
    ['no BYDAY', 'FREQ=WEEKLY'],
    ['a COUNT', 'FREQ=WEEKLY;BYDAY=MO;COUNT=3'],
    ['every other week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['nonsense', 'FREQ=WEEKLY;BYDAY=XX'],
    // Outside SPEC.md's subset: each of these evaluates on another day or at another cost.
    [
      'a DTSTART with a zone',
      'DTSTART;TZID=Pacific/Kiritimati:20260105T000000\nRRULE:FREQ=WEEKLY;BYDAY=MO',
    ],
    ['an RRULE: prefix', 'RRULE:FREQ=WEEKLY;BYDAY=MO'],
    ['BYDAY twice', 'FREQ=WEEKLY;BYDAY=MO;BYDAY=TU'],
    ['BYWEEKDAY', 'FREQ=WEEKLY;BYWEEKDAY=MO'],
    ['an ordinal weekday', 'FREQ=WEEKLY;BYDAY=+1MO'],
    ['a last weekday', 'FREQ=WEEKLY;BYDAY=-1FR'],
    ['an unsigned ordinal', 'FREQ=WEEKLY;BYDAY=1MO'],
    ['a TZID part', 'FREQ=WEEKLY;BYDAY=MO;TZID=Pacific/Kiritimati'],
    ['BYHOUR', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9,10'],
    ['BYSETPOS', 'FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=1'],
    ['BYMONTH', 'FREQ=WEEKLY;BYDAY=MO;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12'],
    ['WKST', 'FREQ=WEEKLY;BYDAY=MO;WKST=SU'],
    ['a floating UNTIL', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000'],
    ['a trailing separator', 'FREQ=WEEKLY;BYDAY=MO;'],
    ['a space', 'FREQ=WEEKLY; BYDAY=MO'],
    ['lower case', 'freq=weekly;byday=mo'],
  ])('refuses %s, which Slotlock cannot evaluate', (_name, rrule) => {
    expect(availabilityRuleProblem({ rrule, startMinutes: 540, durationMinutes: 60 })).toBe(
      'unsupported',
    );
  });

  it('accepts the subset in any order, with INTERVAL=1 and an absolute UNTIL', () => {
    for (const rrule of [
      'BYDAY=MO;FREQ=WEEKLY',
      'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE',
      'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z',
    ]) {
      expect(
        availabilityRuleProblem({ rrule, startMinutes: 540, durationMinutes: 60 }),
        rrule,
      ).toBeNull();
    }
  });

  it('refuses a rule that would expand to every second of the day without expanding it', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => i).join(',');
    const rrule = `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${list(24)};BYMINUTE=${list(60)};BYSECOND=${list(60)}`;
    expect(rrule.length).toBeLessThanOrEqual(500);
    const started = performance.now();
    expect(availabilityRuleProblem({ rrule, startMinutes: 0, durationMinutes: 60 })).toBe(
      'unsupported',
    );
    // Expanding it took 714 ms (security review of #26); refusing it takes microseconds.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('parses a list of at most 50 rules into fresh objects, and refuses anything else', () => {
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 540, durationMinutes: 60 };
    const parsed = parseAvailabilityRules([rule]);
    expect(parsed).toEqual([rule]);
    expect(parsed[0]).not.toBe(rule);
    expect(parseAvailabilityRules([])).toEqual([]);
    for (const value of [
      null,
      'x',
      {},
      [rule, 'x'],
      Array(SLOTLOCK_MAX_AVAILABILITY_RULES + 1).fill(rule),
    ]) {
      expect(() => parseAvailabilityRules(value)).toThrow(
        expect.objectContaining({ code: 'invalid_availability' }),
      );
    }
  });
});

describe('a week of windows as rules', () => {
  it('shares one rule between days with the same window, in weekday order', () => {
    const week = closedWeek();
    for (const day of ['MO', 'TU', 'WE', 'TH', 'FR'] as const)
      week[day] = [{ from: at(9), to: at(17) }];
    week.SA = [{ from: at(10), to: at(14) }];
    expect(weeklyHoursToRules(week)).toEqual([
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 },
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 600, durationMinutes: 240 },
    ]);
  });

  it('reads an end at or before the start as the next morning, and midnight to midnight as all day', () => {
    const week = closedWeek();
    week.FR = [{ from: at(22), to: at(6) }];
    week.SU = [{ from: 0, to: 0 }];
    const rules = weeklyHoursToRules(week);
    expect(rules).toEqual([
      { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 0, durationMinutes: 1_440 },
      { rrule: 'FREQ=WEEKLY;BYDAY=FR', startMinutes: 1_320, durationMinutes: 480 },
    ]);
    // Friday 22:00 to Saturday 06:00 UTC, as expandRules evaluates it.
    const friday = {
      start: new Date('2026-10-16T00:00:00Z'),
      end: new Date('2026-10-18T00:00:00Z'),
    };
    expect(expandRules(rules, friday)).toEqual([
      { start: new Date('2026-10-16T22:00:00Z'), end: new Date('2026-10-17T06:00:00Z') },
    ]);
  });

  it('gives two windows a day, a split shift, two rules', () => {
    const week = closedWeek();
    week.MO = [
      { from: at(14), to: at(18) },
      { from: at(8), to: at(12) },
    ];
    expect(weeklyHoursToRules(week)).toEqual([
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 480, durationMinutes: 240 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 840, durationMinutes: 240 },
    ]);
  });

  it('refuses windows that overlap on one day, more than two a day, and times outside the day', () => {
    const overlap = closedWeek();
    overlap.TU = [
      { from: at(9), to: at(13) },
      { from: at(12), to: at(17) },
    ];
    expect(() => weeklyHoursToRules(overlap)).toThrow(
      expect.objectContaining({
        code: 'invalid_availability',
        message: expect.stringContaining('Tuesday'),
      }),
    );
    const three = closedWeek();
    three.WE = [
      { from: at(6), to: at(7) },
      { from: at(8), to: at(9) },
      { from: at(10), to: at(11) },
    ];
    expect(() => weeklyHoursToRules(three)).toThrow(
      expect.objectContaining({ code: 'invalid_availability' }),
    );
    for (const window of [
      { from: -1, to: 60 },
      { from: 0, to: 1_440 },
      { from: 0.5, to: 60 },
    ]) {
      const bad = closedWeek();
      bad.TH = [window];
      expect(() => weeklyHoursToRules(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_availability' }),
      );
    }
  });

  it('gives a closed week no rules', () => {
    expect(weeklyHoursToRules(closedWeek())).toEqual([]);
  });

  it('reads back every week it writes', () => {
    const week = closedWeek();
    week.MO = [
      { from: at(8), to: at(12) },
      { from: at(13), to: at(17, 30) },
    ];
    week.FR = [{ from: at(22), to: at(6) }];
    week.SU = [{ from: 0, to: 0 }];
    expect(rulesToWeeklyHours(weeklyHoursToRules(week))).toEqual(week);
    expect(rulesToWeeklyHours([])).toEqual(closedWeek());
  });

  it('cannot show rules the week cannot express, so they are not silently rewritten', () => {
    for (const rules of [
      [
        {
          rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z',
          startMinutes: 540,
          durationMinutes: 60,
        },
      ],
      [{ rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 2_880 }],
      [{ rrule: 'BYDAY=MO;FREQ=WEEKLY', startMinutes: 540, durationMinutes: 60 }],
      [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 480, durationMinutes: 60 },
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 600, durationMinutes: 60 },
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 720, durationMinutes: 60 },
      ],
      [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 480, durationMinutes: 240 },
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 600, durationMinutes: 240 },
      ],
    ]) {
      expect(rulesToWeeklyHours(rules)).toBeNull();
    }
  });
});
