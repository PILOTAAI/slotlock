// Defects an audit reproduced in expandRules: UNTIL read differently with and without a time zone,
// and no bound on the search window (50 daily rules over a century took a minute of CPU).
import { describe, expect, it } from 'vitest';
import { expandRules } from '../rules.js';

const d = (iso: string) => new Date(iso);
const DAY = 24 * 60 * 60 * 1000;

describe('expandRules UNTIL, with and without a time zone', () => {
  const window = { start: d('2026-01-01T00:00:00Z'), end: d('2026-01-20T00:00:00Z') };

  it('offers nothing that starts after UNTIL when no zone is given (the audit repro)', () => {
    const rule = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260105T080000Z',
      startMinutes: 540,
      durationMinutes: 60,
    };
    expect(expandRules([rule], window, 'UTC')).toEqual([]);
    expect(expandRules([rule], window)).toEqual([]);
  });

  it('agrees with the UTC zone for every UNTIL around a window', () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const until = new Date(Date.parse('2026-01-05T00:00:00Z') + minutes * 60_000);
      const stamp = until.toISOString().replace(/[-:]/g, '').replace('.000', '');
      const rule = {
        rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${stamp}`,
        startMinutes: 540,
        durationMinutes: 60,
      };
      expect(expandRules([rule], window), stamp).toEqual(expandRules([rule], window, 'UTC'));
    }
    // A window that starts at UNTIL is the last one, in both.
    const atStart = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260105T090000Z',
      startMinutes: 540,
      durationMinutes: 60,
    };
    expect(expandRules([atStart], window)).toEqual([
      { start: d('2026-01-05T09:00:00Z'), end: d('2026-01-05T10:00:00Z') },
    ]);
  });
});

describe('expandRules search window', () => {
  const rule = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
    startMinutes: 540,
    durationMinutes: 60,
  };
  const start = d('2026-01-01T00:00:00Z');

  it('expands a window of 367 days, as free/busy reads one', () => {
    expect(expandRules([rule], { start, end: new Date(start.getTime() + 367 * DAY) })).toHaveLength(
      367,
    );
    expect(
      expandRules([rule], { start, end: new Date(start.getTime() + 367 * DAY) }, 'Europe/London'),
    ).toHaveLength(367);
  });

  it('refuses a longer one with invalid_window, with or without a zone', () => {
    const longer = { start, end: new Date(start.getTime() + 367 * DAY + 1) };
    expect(() => expandRules([rule], longer)).toThrow(
      expect.objectContaining({ code: 'invalid_window' }),
    );
    expect(() => expandRules([rule], longer, 'Europe/London')).toThrow(
      expect.objectContaining({ code: 'invalid_window' }),
    );
  });

  it('refuses the audit repro, 50 daily rules over a century, at once', () => {
    const started = performance.now();
    expect(() =>
      expandRules(
        Array.from({ length: 50 }, () => rule),
        { start, end: d('2126-01-01T00:00:00Z') },
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_window' }));
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('expandRules rule length', () => {
  const window = { start: d('2026-01-05T00:00:00Z'), end: d('2026-01-06T00:00:00Z') };
  const daily = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';

  it('skips a rule longer than a week, as the hours validator refuses one', () => {
    // Each rule scans back as many days as it lasts: a year-long one bypassed the window's bound.
    expect(expandRules([{ rrule: daily, startMinutes: 0, durationMinutes: 10_081 }], window)).toEqual(
      [],
    );
    const started = performance.now();
    expect(
      expandRules(
        Array.from({ length: 50 }, () => ({
          rrule: daily,
          startMinutes: 0,
          durationMinutes: 1440 * 365_000,
        })),
        window,
      ),
    ).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('still expands a rule of exactly a week', () => {
    expect(
      expandRules([{ rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 10_080 }], window),
    ).toEqual([{ start: d('2026-01-05T00:00:00Z'), end: d('2026-01-06T00:00:00Z') }]);
  });
});
