// Where the clocks change, a wall time names two instants (a fold) or none (a gap). The engine reads
// an occurrence's start and exact end per RFC 5545 §3.3.5 (a fold's first instant, a gap's time
// moved forward), its wall-clock end at a fold's later instant, and an availability window up to
// where a gap ends. Each choice is held to an Intl-only oracle in every zone the audit used.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalTimeZoneName,
  createTimeZoneConverter,
  wallFrameToInstant,
  zonedDateTimeToUtc,
} from '../timezone.js';
import { instantsOf, offsetOf, resolve, transitions, wallOf } from './helpers/dst-oracle.js';

const iso = (ms: number | Date) => new Date(ms).toISOString();
const frame = (text: string) => Date.parse(`${text}Z`);
const ZONES = [
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'America/Santiago',
];

describe('a wall time where the clocks change', () => {
  it('names the earlier instant of a fold by default, and the later one when asked', () => {
    const london = createTimeZoneConverter('Europe/London');
    // 2026-10-25: 01:30 is 00:30Z (BST) and again 01:30Z (GMT).
    expect(iso(london.wallFrameToUtc(frame('2026-10-25T01:30:00')))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(iso(london.wallFrameToUtc(frame('2026-10-25T01:30:00'), { fold: 'later' }))).toBe(
      '2026-10-25T01:30:00.000Z',
    );
    // An unambiguous time is the same either way.
    expect(iso(london.wallFrameToUtc(frame('2026-10-25T02:30:00'), { fold: 'later' }))).toBe(
      '2026-10-25T02:30:00.000Z',
    );
  });

  it('moves a time in a gap forward by default, and to where the gap ends when asked', () => {
    const newYork = createTimeZoneConverter('America/New_York');
    // 2027-03-14: 02:00-03:00 EST does not exist.
    expect(iso(newYork.wallFrameToUtc(frame('2027-03-14T02:30:00')))).toBe(
      '2027-03-14T07:30:00.000Z',
    );
    expect(iso(newYork.wallFrameToUtc(frame('2027-03-14T02:30:00'), { gap: 'end' }))).toBe(
      '2027-03-14T07:00:00.000Z',
    );
    // Lord Howe skips half an hour (02:00 LHST to 02:30 LHDT) on 2027-10-03.
    const lordHowe = createTimeZoneConverter('Australia/Lord_Howe');
    expect(iso(lordHowe.wallFrameToUtc(frame('2027-10-03T02:15:00')))).toBe(
      '2027-10-02T15:45:00.000Z',
    );
    expect(iso(lordHowe.wallFrameToUtc(frame('2027-10-03T02:15:00'), { gap: 'end' }))).toBe(
      '2027-10-02T15:30:00.000Z',
    );
    // Samoa skipped all of 2011-12-30 (UTC-10 to UTC+14).
    const apia = createTimeZoneConverter('Pacific/Apia');
    expect(iso(apia.wallFrameToUtc(frame('2011-12-30T12:00:00')))).toBe('2011-12-30T22:00:00.000Z');
    expect(iso(apia.wallFrameToUtc(frame('2011-12-30T12:00:00'), { gap: 'end' }))).toBe(
      '2011-12-30T10:00:00.000Z',
    );
  });

  it('reads a zone given only as an offset function the same way', () => {
    // Berlin's 2027 rules as a bare offset function: what a feed's own VTIMEZONE gives.
    const spring = Date.parse('2027-03-28T01:00:00Z');
    const autumn = Date.parse('2027-10-31T01:00:00Z');
    const offsetAt = (utcMs: number) => (utcMs >= spring && utcMs < autumn ? 7_200_000 : 3_600_000);
    expect(iso(wallFrameToInstant(frame('2027-10-31T02:30:00'), offsetAt))).toBe(
      '2027-10-31T00:30:00.000Z',
    );
    expect(iso(wallFrameToInstant(frame('2027-10-31T02:30:00'), offsetAt, { fold: 'later' }))).toBe(
      '2027-10-31T01:30:00.000Z',
    );
    expect(iso(wallFrameToInstant(frame('2027-03-28T02:30:00'), offsetAt))).toBe(
      '2027-03-28T01:30:00.000Z',
    );
    expect(iso(wallFrameToInstant(frame('2027-03-28T02:30:00'), offsetAt, { gap: 'end' }))).toBe(
      '2027-03-28T01:00:00.000Z',
    );
  });

  it('passes the choices through zonedDateTimeToUtc', () => {
    expect(
      iso(
        zonedDateTimeToUtc(
          { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
          'America/New_York',
          { fold: 'later' },
        ),
      ),
    ).toBe('2026-11-01T06:30:00.000Z');
  });

  it('agrees with the Intl-only oracle around every change in seven zones', () => {
    const changes = ZONES.flatMap((zone) =>
      transitions(zone, Date.parse('2026-06-01T00:00:00Z'), Date.parse('2028-06-01T00:00:00Z')).map(
        (at) => ({ zone, at }),
      ),
    );
    expect(changes.length).toBeGreaterThan(25);
    fc.assert(
      fc.property(
        fc.constantFrom(...changes),
        fc.integer({ min: -16, max: 16 }),
        fc.constantFrom<'earlier' | 'later'>('earlier', 'later'),
        ({ zone, at }, quarters, fold) => {
          // A wall time within four hours of the change, on a quarter hour.
          const wall = wallOf(at, zone) + quarters * 15 * 60 * 1000;
          const converter = createTimeZoneConverter(zone);
          const got = converter.wallFrameToUtc(wall, { fold }).getTime();
          expect(got).toBe(resolve(wall, zone, fold));
          const end = converter.wallFrameToUtc(wall, { gap: 'end' }).getTime();
          if (instantsOf(wall, zone).length === 0) {
            // Where the gap ends: the change itself.
            expect(end).toBe(at);
            expect(offsetOf(end - 1000, zone)).not.toBe(offsetOf(end, zone));
          } else {
            expect(end).toBe(resolve(wall, zone, 'earlier'));
          }
        },
      ),
      { seed: 20261024, numRuns: 600 },
    );
  });
});

describe('a time-zone name', () => {
  it('is kept in Intl spelling when only its case differs', () => {
    expect(canonicalTimeZoneName('europe/london')).toBe('Europe/London');
    expect(canonicalTimeZoneName(' Europe/Berlin ')).toBe('Europe/Berlin');
    expect(canonicalTimeZoneName('utc')).toBe('UTC');
  });

  it('keeps an alias as written, whatever this ICU resolves it to', () => {
    expect(canonicalTimeZoneName('US/Eastern')).toBe('US/Eastern');
    expect(canonicalTimeZoneName('Etc/GMT+5')).toBe('Etc/GMT+5');
  });

  it.each(['+05:00', '-0500', 'UTC+1', 'Europe/Narnia', '', ' '])(
    'refuses %j: an offset or an unknown name is not an IANA zone',
    (name) => {
      expect(() => canonicalTimeZoneName(name)).toThrow(
        expect.objectContaining({ code: 'invalid_timezone' }),
      );
    },
  );
});
