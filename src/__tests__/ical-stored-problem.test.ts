// Series an earlier Slotlock stored that this one refuses as maintenance rolls them (a rule shape
// it no longer expands, COUNT with a yearly day some years lack, an exception that names no
// occurrence) are counted as refused on every roll and keep their old coverage. The check names
// each one and why, without writing anything, so an operator can fix them before upgrading.
import { describe, expect, it } from 'vitest';
import { expandStoredCalendarEventOccurrences, storedCalendarEventProblem } from '../sync.js';
import type { CalendarEventContent } from '../types.js';

const series = (rrule: string, extra: Partial<CalendarEventContent> = {}): CalendarEventContent => ({
  start: new Date('2027-01-04T09:00:00Z'),
  end: new Date('2027-01-04T10:00:00Z'),
  timezone: 'Europe/London',
  summary: 'x',
  recurrence: { rrule },
  ...extra,
});
const WINDOW = { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-12-31T00:00:00Z') };

describe('storedCalendarEventProblem', () => {
  it.each([
    ['FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO', /BYWEEKNO/],
    ['FREQ=MONTHLY;BYMONTH=2,8;BYMONTHDAY=3', /BYMONTH with FREQ=MONTHLY/],
    ['FREQ=MONTHLY;BYDAY=20MO', /two digits/],
    ['FREQ=HOURLY', /not a rule Slotlock stores/],
    ['FREQ=DAILY;COUNT=0', /RFC 5545/],
  ])('names %s, which the roll refuses', (rrule, reason) => {
    expect(storedCalendarEventProblem(series(rrule))).toMatch(reason);
    expect(() => expandStoredCalendarEventOccurrences(series(rrule), WINDOW)).toThrow();
  });

  it('names COUNT with 29 February', () => {
    const leap = series('FREQ=YEARLY;COUNT=4', {
      start: new Date('2028-02-29T09:00:00Z'),
      end: new Date('2028-02-29T10:00:00Z'),
    });
    expect(storedCalendarEventProblem(leap)).toMatch(/COUNT/);
  });

  it('names exceptions that name no occurrence, with their instants', () => {
    const event = series('FREQ=WEEKLY;COUNT=4', {
      recurrence: {
        rrule: 'FREQ=WEEKLY;COUNT=4',
        exceptions: [
          { recurrenceId: new Date('2027-01-11T09:00:00Z'), cancelled: true },
          { recurrenceId: new Date('2027-01-12T09:00:00Z'), cancelled: true },
          {
            recurrenceId: new Date('2027-02-15T09:00:00Z'),
            start: new Date('2027-02-15T11:00:00Z'),
            end: new Date('2027-02-15T12:00:00Z'),
          },
        ],
      },
    });
    expect(storedCalendarEventProblem(event)).toBe(
      '2 exceptions that name no occurrence: 2027-01-12T09:00:00.000Z, 2027-02-15T09:00:00.000Z',
    );
    expect(() => expandStoredCalendarEventOccurrences(event, WINDOW)).toThrow();
  });

  it('finds nothing wrong with a series the roll expands, or a one-off', () => {
    const good = series('FREQ=WEEKLY;BYDAY=MO', {
      recurrence: {
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        exceptions: [{ recurrenceId: new Date('2027-01-11T09:00:00Z'), cancelled: true }],
      },
    });
    expect(storedCalendarEventProblem(good)).toBeNull();
    expect(expandStoredCalendarEventOccurrences(good, WINDOW).length).toBeGreaterThan(40);
    const { recurrence: _none, ...oneOff } = good;
    expect(storedCalendarEventProblem(oneOff)).toBeNull();
    const leap = series('FREQ=YEARLY', {
      start: new Date('2028-02-29T09:00:00Z'),
      end: new Date('2028-02-29T10:00:00Z'),
    });
    expect(storedCalendarEventProblem(leap)).toBeNull();
  });
});
