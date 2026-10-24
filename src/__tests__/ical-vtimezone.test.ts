// RFC 5545 §3.6.5: a calendar holds a VTIMEZONE for every TZID it names. Slotlock's exports write
// one from Intl's reading of the zone, and a reader that knows the zone only by that VTIMEZONE
// reads every occurrence as Intl does: in the years around the event, and years later, where the
// VTIMEZONE's yearly rules carry the zone on (ENG-15).
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { emitITipCalendar, parseICalendarChanges } from '../sync.js';
import { zoneTransitions } from '../timezone.js';

const ZONES = [
  'Europe/London',
  'Europe/Berlin',
  'Europe/Dublin',
  'America/New_York',
  'America/St_Johns',
  'America/Santiago',
  'America/Havana',
  'America/Asuncion',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'Asia/Tehran',
  'Africa/Cairo',
  'Africa/Casablanca',
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The TZIDs a calendar's properties name, and the ones its VTIMEZONEs define. */
function zones(text: string) {
  const root = new ICAL.Component(ICAL.parse(text));
  const named = new Set<string>();
  for (const event of root.getAllSubcomponents('vevent')) {
    for (const property of event.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid === 'string') named.add(tzid);
    }
  }
  const defined = root
    .getAllSubcomponents('vtimezone')
    .map((zone) => String(zone.getFirstPropertyValue('tzid')));
  return { named: [...named].sort(), defined: defined.sort() };
}

/** The calendar with its zone renamed to one Intl does not know, so only its VTIMEZONE says it. */
const renamed = (text: string, zone: string) =>
  text
    .replaceAll(`TZID:${zone}`, 'TZID:Exported Zone')
    .replaceAll(`TZID=${zone}`, 'TZID=Exported Zone');

const spans = (text: string, window: { start: Date; end: Date }) =>
  parseICalendarChanges(text, undefined, window).map(
    (change) => `${change.start?.toISOString()}..${change.end?.toISOString()}`,
  );

describe('an exported calendar defines every zone it names', () => {
  it.each(ZONES.flatMap((zone) => [2006, 2021, 2026].map((year) => [zone, year] as const)))(
    '%s, a daily series from %i, read by its VTIMEZONE alone, as Intl reads it',
    (zone, year) => {
      // 01:30 local, two hours: in the hour most zones skip or repeat.
      const start = new Date(Date.UTC(year, 0, 10, 1, 30) - (zoneOffset(zone, year) ?? 0));
      const text = emitITipCalendar(
        {
          uid: 'series@slotlock.test',
          start,
          end: new Date(start.getTime() + 2 * HOUR),
          timezone: zone,
          summary: 'Daily',
          recurrence: { rrule: 'FREQ=DAILY' },
        },
        'PUBLISH',
      );
      expect(zones(text)).toEqual({ named: [zone], defined: [zone] });
      for (const from of [year, year + 15]) {
        const window = {
          start: new Date(Date.UTC(from, 0, 11)),
          end: new Date(Date.UTC(from + 1, 0, 11)),
        };
        const intl = spans(text, window);
        expect(intl.length).toBeGreaterThan(360);
        expect(spans(renamed(text, zone), window), `${zone} ${from}`).toEqual(intl);
      }
    },
    60_000,
  );

  it.each(ZONES)('%s, a one-off, read by its VTIMEZONE alone, as Intl reads it', (zone) => {
    const start = new Date('2027-07-01T09:00:00Z');
    const text = emitITipCalendar(
      {
        uid: 'once@slotlock.test',
        start,
        end: new Date(start.getTime() + DAY),
        timezone: zone,
        summary: 'Once',
      },
      'PUBLISH',
    );
    const { named, defined } = zones(text);
    expect(defined).toEqual(named);
    const window = {
      start: new Date('2027-06-01T00:00:00Z'),
      end: new Date('2027-08-01T00:00:00Z'),
    };
    expect(spans(renamed(text, zone), window)).toEqual(spans(text, window));
  });

  it('names no zone, and defines none, in UTC', () => {
    const start = new Date('2027-07-01T09:00:00Z');
    const text = emitITipCalendar(
      {
        uid: 'utc@slotlock.test',
        start,
        end: new Date(start.getTime() + HOUR),
        timezone: 'UTC',
        summary: 'UTC',
        recurrence: { rrule: 'FREQ=WEEKLY' },
      },
      'PUBLISH',
    );
    expect(zones(text)).toEqual({ named: [], defined: [] });
  });
});

describe('zoneTransitions', () => {
  it('finds every change a day-by-day search finds, in every zone Intl knows, 2020 to 2032', () => {
    const from = Date.UTC(2020, 0, 1);
    const to = Date.UTC(2032, 0, 1);
    let changes = 0;
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      const found = zoneTransitions(zone, from, to);
      const daily: number[] = [];
      let previous = zoneOffset(zone, 2020, from) as number;
      for (let at = from + DAY; at <= to; at += DAY) {
        const offset = zoneOffset(zone, 0, at) as number;
        if (offset !== previous) daily.push(at);
        previous = offset;
      }
      // Each change lies in the day before the daily search first sees it.
      expect(found.length, zone).toBe(daily.length);
      found.forEach((change, index) => {
        expect(change.at, zone).toBeGreaterThan((daily[index] as number) - DAY);
        expect(change.at, zone).toBeLessThanOrEqual(daily[index] as number);
        expect(zoneOffset(zone, 0, change.at - 1000), zone).toBe(change.before);
        expect(zoneOffset(zone, 0, change.at), zone).toBe(change.after);
      });
      changes += found.length;
    }
    expect(changes).toBeGreaterThan(1_000);
  }, 120_000);
});

const formatters = new Map<string, Intl.DateTimeFormat>();
/** `zone`'s offset in ms at `at` (or at the start of `year`), read from Intl. */
function zoneOffset(zone: string, year: number, at = Date.UTC(year, 0, 1)): number | undefined {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    parts.hour as number,
    parts.minute as number,
    parts.second as number,
  );
  return wall - Math.floor(at / 1000) * 1000;
}
