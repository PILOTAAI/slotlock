// Availability maths with no database: expand business hours, subtract busy time, pick a slot.
// #region next-slot
import { expandRules, findNextAvailable } from 'slotlock';

const searchWindow = {
  start: new Date('2026-09-14T00:00:00Z'),
  end: new Date('2026-09-21T00:00:00Z'),
};

// Weekdays 09:00-17:00, evaluated in the resource's own timezone (DST included).
const windows = expandRules(
  [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 8 * 60 }],
  searchWindow,
  'Europe/London',
);

export const slot = findNextAvailable({
  windows,
  busy: [{ start: new Date('2026-09-14T09:00:00Z'), end: new Date('2026-09-14T10:00:00Z') }],
  durationMs: 2 * 60 * 60 * 1000,
});
// slot = { start: 2026-09-14T10:00:00Z, end: 2026-09-14T12:00:00Z }: Monday 08:00-09:00 UTC
// (09:00 London) is too short before the busy hour.
// #endregion next-slot
