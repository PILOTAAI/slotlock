// Availability maths with no database: expand business hours, subtract busy time, pick a slot.
// #region next-slot
import { expandRules, findNextAvailable } from 'slotlock';

const searchWindow = {
  start: new Date('2026-09-14T00:00:00Z'),
  end: new Date('2026-09-21T00:00:00Z'),
};

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
// slot: 2026-09-14 10:00–12:00 UTC, the first two free hours after the busy one
// #endregion next-slot
