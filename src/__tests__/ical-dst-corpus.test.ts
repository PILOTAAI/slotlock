// The audit's 66-case daylight-saving corpus (helpers/dst-corpus.ts), as a regression suite. Every
// case occupies Slotlock's answer exactly, never less than RFC 5545's exact reading, and the two
// paths agree: a feed imported with the trusted parser and stored occupies what the feed reports,
// and a stored event exported and read back as a feed occupies what the store holds.
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  CalendarContractError,
  emitITipCalendar,
  expandCalendarEventOccurrences,
  parseICalendarChanges,
  parseICalendarFeed,
  parseTrustedICalendarEvents,
} from '../sync.js';
import { zonedDateTimeToUtc } from '../timezone.js';
import type { CalendarEventContent } from '../types.js';
import {
  type Answer,
  CASES,
  type Case,
  FEED_WINDOW,
  type FeedCase,
  STORE_WINDOW,
  type Span,
  type StoreCase,
  VTZ,
  WINDOWS_IANA,
  cal,
  ev,
} from './helpers/dst-corpus.js';

const minute = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;
const sorted = (spans: Span[]) => [...spans].sort((a, b) => a[0].localeCompare(b[0]));
const busy = (changes: ReturnType<typeof parseICalendarChanges>): Span[] =>
  sorted(
    changes
      .filter((change) => !change.deleted && change.busy && change.start && change.end)
      .map((change): Span => [minute(change.start as Date), minute(change.end as Date)]),
  );

function refused(run: () => Span[]): Span[] | 'refuse' {
  try {
    return run();
  } catch (error) {
    if (error instanceof CalendarContractError) return 'refuse';
    throw error;
  }
}

function storeContent(c: StoreCase): CalendarEventContent {
  const content: CalendarEventContent = {
    start: new Date(c.content.start),
    end: new Date(c.content.end),
    timezone: c.content.timezone,
    summary: 'corpus',
  };
  if (c.content.rrule) {
    content.recurrence = { rrule: c.content.rrule };
    if (c.content.exceptions) {
      content.recurrence.exceptions = c.content.exceptions.map((exception) => ({
        recurrenceId: new Date(exception.recurrenceId),
        ...(exception.cancelled ? { cancelled: true } : {}),
        ...(exception.start ? { start: new Date(exception.start) } : {}),
        ...(exception.end ? { end: new Date(exception.end) } : {}),
      }));
    }
  }
  return content;
}

const occupied = (content: CalendarEventContent, window: { start: Date; end: Date }): Span[] =>
  sorted(
    expandCalendarEventOccurrences(content, window).map(
      (o): Span => [minute(o.start), minute(o.end)],
    ),
  );

function answer(c: Case): Answer {
  if (c.kind === 'feed') {
    return refused(() => busy(parseICalendarChanges(c.ics, undefined, FEED_WINDOW)));
  }
  return refused(() => occupied(storeContent(c), STORE_WINDOW));
}

/** Minutes `a` occupies that `b` does not. */
function freedMinutes(a: Span[], b: Span[]): number {
  const covered = new Set<number>();
  for (const [start, end] of b) {
    for (let t = Date.parse(start); t < Date.parse(end); t += 60_000) covered.add(t);
  }
  let freed = 0;
  for (const [start, end] of a) {
    for (let t = Date.parse(start); t < Date.parse(end); t += 60_000) {
      if (!covered.has(t)) freed += 1;
    }
  }
  return freed;
}

/**
 * The trusted parser refuses these feeds, rather than store something that occupies less than the
 * feed: a zone only the feed's VTIMEZONE defines (no IANA zone to store), an override whose
 * transparency differs from its series' (a stored series has one), a shape ical.js expands wrongly,
 * DTEND with DURATION; and the store refuses an exception that matches no occurrence.
 */
const TRUSTED_REFUSES = [
  /^ENG-8 /,
  /^ENG-9 /,
  /^ENG-10 .*\(transp\)/,
  /^ENG-12\(2\)/,
  /^ENG-4 /,
  /^ENG-19 /,
];

describe('the daylight-saving corpus', () => {
  it('holds all 66 cases', () => {
    expect(CASES).toHaveLength(66);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(66);
  });

  it('has VTIMEZONE fixtures that agree with Intl at unambiguous times', () => {
    const walls = ['20260701T120000', '20261201T120000', '20270115T090000', '20270615T090000'];
    for (const zone of Object.keys(VTZ)) {
      for (const wall of walls) {
        const root = new ICAL.Component(
          ICAL.parse(cal([zone], ev('c', `DTSTART;TZID=${zone}:${wall}`))),
        );
        const viaFixture = (
          root.getFirstSubcomponent('vevent')?.getFirstPropertyValue('dtstart') as ICAL.Time
        ).toJSDate();
        const viaIntl = zonedDateTimeToUtc(
          {
            year: Number(wall.slice(0, 4)),
            month: Number(wall.slice(4, 6)),
            day: Number(wall.slice(6, 8)),
            hour: Number(wall.slice(9, 11)),
          },
          WINDOWS_IANA[zone] ?? zone,
        );
        expect(viaFixture.toISOString(), `${zone} ${wall}`).toBe(viaIntl.toISOString());
      }
    }
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const got = answer(c);
    expect(got).toEqual(c.expected === 'refuse' ? 'refuse' : sorted(c.expected));
    // Never less than RFC 5545's exact reading: the fixture's own answer frees nothing it holds.
    if (c.expected !== 'refuse' && c.rfc !== 'refuse') {
      expect(freedMinutes(c.rfc, c.expected)).toBe(0);
    }
  });

  it('frees no busy minute in any case, on either path', () => {
    const failOpen: string[] = [];
    for (const c of CASES) {
      const got = answer(c);
      if (got === 'refuse' || c.rfc === 'refuse') continue;
      const freed = freedMinutes(c.rfc, got);
      if (freed > 0) failOpen.push(`${c.id}: ${freed} minutes free`);
    }
    expect(failOpen).toEqual([]);
  });

  it.each(CASES.filter((c): c is FeedCase => c.kind === 'feed').map((c) => [c.id, c] as const))(
    'stores what the feed reports: %s',
    (id, c) => {
      const feed = answer(c);
      let stored: Span[] | 'refuse';
      try {
        stored = sorted(
          parseTrustedICalendarEvents(c.ics).flatMap((event) =>
            event.status === 'cancelled' || event.transparency === 'transparent'
              ? []
              : occupied(event as CalendarEventContent, FEED_WINDOW),
          ),
        );
      } catch (error) {
        if (!(error instanceof CalendarContractError)) throw error;
        stored = 'refuse';
      }
      if (TRUSTED_REFUSES.some((pattern) => pattern.test(id))) {
        expect(stored).toBe('refuse');
      } else {
        expect(stored).toEqual(feed);
      }
    },
  );

  it.each(CASES.filter((c): c is StoreCase => c.kind === 'store').map((c) => [c.id, c] as const))(
    'reads back from its export what the store holds: %s',
    (_id, c) => {
      const stored = answer(c);
      const exported = refused(() => {
        const text = emitITipCalendar(
          { ...storeContent(c), uid: 'corpus@slotlock.test' },
          'PUBLISH',
        );
        return busy(parseICalendarChanges(text, undefined, STORE_WINDOW));
      });
      expect(exported).toEqual(stored);
    },
  );

  it.each(
    CASES.filter((c): c is FeedCase => c.kind === 'feed' && c.expected === 'refuse').map(
      (c) => [c.id, c] as const,
    ),
  )('refuses only the series, not the feed: %s', (_id, c) => {
    const keep = ev('keep', 'DTSTART:20270105T120000Z', 'DTEND:20270105T130000Z');
    const text = c.ics.replace('END:VCALENDAR', `${keep.join('\r\n')}\r\nEND:VCALENDAR`);
    const read = parseICalendarFeed(text, undefined, FEED_WINDOW);
    expect(busy(read.changes)).toEqual([['2027-01-05T12:00Z', '2027-01-05T13:00Z']]);
    expect(read.refused.map((series) => series.uid)).toHaveLength(1);
    // The array API answers all or nothing, so a caller that cannot see a refusal never reads the
    // feed as complete.
    expect(() => parseICalendarChanges(text, undefined, FEED_WINDOW)).toThrow(
      CalendarContractError,
    );
  });
});
