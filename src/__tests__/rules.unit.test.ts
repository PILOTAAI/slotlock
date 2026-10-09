// VAVAILABILITY-style rule expansion (RFC-0001 spike criterion b) — weekly bookable windows
// expanded to concrete UTC intervals via rrule, in UTC or in a resource's IANA timezone (the
// `timezone:` cases below cover DST gaps and local weekdays).
import { describe, expect, it } from 'vitest';
import { expandRules } from '../rules.js';

const d = (iso: string) => new Date(iso);

describe('expandRules', () => {
  // Bookable Mon-Fri 08:00-18:00 UTC.
  const weekdays = [
    { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
  ];

  it('expands a weekday rule to one window per matching day, clipped to the search window', () => {
    // Mon 2027-01-04 .. Sun 2027-01-10 — expect Mon-Fri windows.
    const windows = expandRules(weekdays, {
      start: d('2027-01-04T00:00:00Z'),
      end: d('2027-01-11T00:00:00Z'),
    });
    expect(windows).toHaveLength(5);
    expect(windows[0]).toEqual({
      start: d('2027-01-04T08:00:00Z'),
      end: d('2027-01-04T18:00:00Z'),
    });
    expect(windows[4]).toEqual({
      start: d('2027-01-08T08:00:00Z'),
      end: d('2027-01-08T18:00:00Z'),
    });
  });

  it('clips a window that straddles the search boundary', () => {
    const windows = expandRules(weekdays, {
      start: d('2027-01-04T10:00:00Z'),
      end: d('2027-01-04T12:00:00Z'),
    });
    expect(windows).toEqual([{ start: d('2027-01-04T10:00:00Z'), end: d('2027-01-04T12:00:00Z') }]);
  });

  it('a rule whose day falls outside the search window contributes nothing', () => {
    const weekend = [
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 9 * 60, durationMinutes: 4 * 60 },
    ];
    const windows = expandRules(weekend, {
      start: d('2027-01-04T00:00:00Z'), // Mon
      end: d('2027-01-06T00:00:00Z'), // Wed
    });
    expect(windows).toEqual([]);
  });

  it('overlapping rules merge into one continuous window', () => {
    const rules = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 8 * 60, durationMinutes: 4 * 60 }, // 08-12
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 11 * 60, durationMinutes: 5 * 60 }, // 11-16
    ];
    const windows = expandRules(rules, {
      start: d('2027-01-04T00:00:00Z'),
      end: d('2027-01-05T00:00:00Z'),
    });
    expect(windows).toEqual([{ start: d('2027-01-04T08:00:00Z'), end: d('2027-01-04T16:00:00Z') }]);
  });

  it('empty rules → no windows', () => {
    expect(
      expandRules([], { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') }),
    ).toEqual([]);
  });

  // ── Determinism gate (adversarial findings 1/2/4, PR #200): unsupported input is REFUSED
  // (fails closed), never answered wrong — and the refusal is query-date-independent.

  it('INTERVAL=2 is refused identically regardless of the query date (no parity flapping)', () => {
    const biweekly = [
      { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', startMinutes: 9 * 60, durationMinutes: 60 },
    ];
    const fromMon = expandRules(biweekly, {
      start: d('2027-01-04T00:00:00Z'),
      end: d('2027-01-11T00:00:00Z'),
    });
    const fromFri = expandRules(biweekly, {
      start: d('2027-01-08T00:00:00Z'),
      end: d('2027-01-11T00:00:00Z'),
    });
    expect(fromMon).toEqual([]);
    expect(fromFri).toEqual([]);
  });

  it('COUNT rules are refused (re-anchoring would restart the count on every query)', () => {
    const counted = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=1', startMinutes: 9 * 60, durationMinutes: 60 },
    ];
    expect(
      expandRules(counted, { start: d('2027-01-04T00:00:00Z'), end: d('2027-06-01T00:00:00Z') }),
    ).toEqual([]);
  });

  it('a blank / freq-less rrule contributes nothing (no phantom default-YEARLY availability)', () => {
    const junk = [
      { rrule: '', startMinutes: 23 * 60, durationMinutes: 120 },
      { rrule: 'COUNT=5', startMinutes: 9 * 60, durationMinutes: 60 },
    ];
    expect(
      expandRules(junk, { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') }),
    ).toEqual([]);
  });

  it('UNTIL stays supported (absolute anchor — expands correctly, stops after)', () => {
    const until = [
      {
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20270105T000000Z',
        startMinutes: 9 * 60,
        durationMinutes: 60,
      },
    ];
    const windows = expandRules(until, {
      start: d('2027-01-04T00:00:00Z'),
      end: d('2027-02-01T00:00:00Z'),
    });
    expect(windows).toEqual([{ start: d('2027-01-04T09:00:00Z'), end: d('2027-01-04T10:00:00Z') }]);
  });

  it('applies UNTIL to the real instant after zoned wall-time conversion', () => {
    const until = [
      {
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20270704T220000Z',
        startMinutes: 9 * 60,
        durationMinutes: 60,
      },
    ];
    const windows = expandRules(
      until,
      { start: d('2027-07-04T00:00:00Z'), end: d('2027-07-06T00:00:00Z') },
      'Pacific/Auckland',
    );
    expect(windows).toEqual([{ start: d('2027-07-04T21:00:00Z'), end: d('2027-07-04T22:00:00Z') }]);
  });

  it('rejects out-of-range, fractional, and non-finite minute fields', () => {
    const invalid = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: -1, durationMinutes: 60 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 1440, durationMinutes: 60 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 1.5, durationMinutes: 60 },
      {
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        startMinutes: Number.POSITIVE_INFINITY,
        durationMinutes: 60,
      },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 60, durationMinutes: 1.5 },
    ];
    expect(
      expandRules(invalid, {
        start: d('2027-01-04T00:00:00Z'),
        end: d('2027-01-05T00:00:00Z'),
      }),
    ).toEqual([]);
  });

  it('a multi-day window is found from a search window entirely INSIDE it', () => {
    // "Available Mon 00:00 for 3 days" queried on Wednesday only — the fixed one-day back-scan
    // silently lost this class entirely.
    const multiDay = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 3 * 24 * 60 },
    ];
    const windows = expandRules(multiDay, {
      start: d('2027-01-06T00:00:00Z'), // Wed
      end: d('2027-01-07T00:00:00Z'),
    });
    expect(windows).toEqual([{ start: d('2027-01-06T00:00:00Z'), end: d('2027-01-07T00:00:00Z') }]);
  });

  it('a late window crossing midnight reaches into the next-day search window', () => {
    const late = [{ rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 23 * 60, durationMinutes: 120 }];
    const windows = expandRules(late, {
      start: d('2027-01-04T00:00:00Z'), // Mon
      end: d('2027-01-04T06:00:00Z'),
    });
    expect(windows).toEqual([{ start: d('2027-01-04T00:00:00Z'), end: d('2027-01-04T01:00:00Z') }]);
  });

  it('windows come back sorted even when rules are not', () => {
    const rules = [
      { rrule: 'FREQ=WEEKLY;BYDAY=WE', startMinutes: 9 * 60, durationMinutes: 60 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 60 },
    ];
    const windows = expandRules(rules, {
      start: d('2027-01-04T00:00:00Z'),
      end: d('2027-01-11T00:00:00Z'),
    });
    expect(windows.map((w) => w.start.toISOString())).toEqual([
      '2027-01-04T09:00:00.000Z',
      '2027-01-06T09:00:00.000Z',
    ]);
  });

  it('timezone: the SAME local rule maps to different UTC instants across DST (Europe/London)', () => {
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 8 * 60 };
    // Summer Monday (BST, UTC+1): 09:00 local = 08:00Z.
    const summer = expandRules(
      [rule],
      { start: d('2027-07-05T00:00:00Z'), end: d('2027-07-06T00:00:00Z') },
      'Europe/London',
    );
    expect(summer.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2027-07-05T08:00:00.000Z', '2027-07-05T16:00:00.000Z'],
    ]);
    // Winter Monday (GMT, UTC+0): 09:00 local = 09:00Z.
    const winter = expandRules(
      [rule],
      { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-05T00:00:00Z') },
      'Europe/London',
    );
    expect(winter.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2027-01-04T09:00:00.000Z', '2027-01-04T17:00:00.000Z'],
    ]);
  });

  it('timezone: BYDAY is the LOCAL weekday — an Auckland Monday morning is Sunday evening UTC, and is still found when the search window ends before UTC Monday', () => {
    // 2027-07: NZST (UTC+12). Local Monday 2027-07-05 09:00 = Sunday 2027-07-04 21:00Z.
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 60 };
    const windows = expandRules(
      [rule],
      // Ends BEFORE UTC Monday — the local-Monday stamp (Jul 5) lies past the window end and
      // is only scanned because of the one-day widen (rrule.between would include a stamp
      // exactly ON the end, so 23:00 makes the widen load-bearing — review-proven gap).
      { start: d('2027-07-04T00:00:00Z'), end: d('2027-07-04T23:00:00Z') },
      'Pacific/Auckland',
    );
    expect(windows.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2027-07-04T21:00:00.000Z', '2027-07-04T22:00:00.000Z'],
    ]);
  });

  it('timezone: wall-clock END across a spring-forward gap — the real span shrinks by the skipped hour', () => {
    // Europe/London springs forward 2027-03-28 at 01:00 GMT → 02:00 BST. A local window
    // [00:30, 04:30) on that Sunday spans 4 wall hours but only 3 real hours:
    // 00:30Z (GMT) … 03:30Z (= 04:30 BST).
    const rule = {
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      startMinutes: 30,
      durationMinutes: 4 * 60,
    };
    const windows = expandRules(
      [rule],
      { start: d('2027-03-28T00:00:00Z'), end: d('2027-03-29T00:00:00Z') },
      'Europe/London',
    );
    expect(windows.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2027-03-28T00:30:00.000Z', '2027-03-28T03:30:00.000Z'],
    ]);
  });

  it('timezone: UTC (explicit or omitted) reproduces the spike expansion byte-for-byte', () => {
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=TU', startMinutes: 10 * 60, durationMinutes: 60 };
    const window = { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') };
    expect(expandRules([rule], window, 'UTC')).toEqual(expandRules([rule], window));
  });

  it('timezone: an invalid IANA name throws a typed invalid_timezone error — never silent UTC math', () => {
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 60 };
    let thrown: unknown;
    try {
      expandRules(
        [rule],
        { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-05T00:00:00Z') },
        'Europe/Narnia',
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected a throw').toBeTruthy();
    expect((thrown as { code?: string }).code).toBe('invalid_timezone');
  });

  it('timezone: fall-back ambiguity is the FIRST occurrence (RFC 5545) — a 1h rule stays 1 real hour', () => {
    // Europe/London falls back 2027-10-31 02:00 BST → 01:00 GMT. Wall [00:30, 01:30) reads
    // twice; the pre-transition reading is [2027-10-30T23:30Z, 2027-10-31T00:30Z). The
    // accidental later-occurrence pick spanned 2 real hours for a 1-hour rule.
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 30, durationMinutes: 60 };
    const windows = expandRules(
      [rule],
      { start: d('2027-10-30T00:00:00Z'), end: d('2027-11-01T00:00:00Z') },
      'Europe/London',
    );
    expect(windows.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2027-10-30T23:30:00.000Z', '2027-10-31T00:30:00.000Z'],
    ]);
  });

  it('timezone: a rule wholly inside a spring-forward gap yields NOTHING — negative-offset zones included', () => {
    // America/New_York springs forward 2027-03-14 02:00 EST → 03:00 EDT. A [02:00, 03:00)
    // local rule names only skipped wall time: both endpoints shift forward to 07:00Z and the
    // degenerate window is dropped. (The naive probe manufactured [06:00Z, 07:00Z) — wall
    // 01:00–02:00 EST, an hour the rule excludes.)
    const rule = { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 2 * 60, durationMinutes: 60 };
    const windows = expandRules(
      [rule],
      { start: d('2027-03-14T00:00:00Z'), end: d('2027-03-15T00:00:00Z') },
      'America/New_York',
    );
    expect(windows).toEqual([]);
  });

  it('timezone: BYDAY-less FREQ=WEEKLY is refused in BOTH paths (anchor-nondeterministic)', () => {
    const rule = { rrule: 'FREQ=WEEKLY', startMinutes: 10 * 60, durationMinutes: 60 };
    const window = { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') };
    expect(expandRules([rule], window)).toEqual([]);
    expect(expandRules([rule], window, 'Europe/London')).toEqual([]);
  });
});
