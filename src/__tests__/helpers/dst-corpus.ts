// The 66-case corpus of the 2026-10-24 readiness audit (its GAP1 lens), kept as a regression suite:
// every input that made Slotlock 0.2.0 or Pylota's own engine leave written busy time free, around
// the daylight-saving changes of 2026-10-25 (EU), 2026-11-01 (US) and 2027-03-28 / 2027-03-14.
// `feed` cases are what a provider sends (parseICalendarChanges); `store` cases are what an agent
// writes (putCalendarEvent, through expandCalendarEventOccurrences).
//
// Each case carries two answers, written by hand from RFC 5545 (§3.3.5 a fold's first instant and a
// gap's time moved forward; §3.3.6 exact hours; §3.8.5.3 one exact length for every member; §3.6.1
// DTEND and DURATION never together):
// - `rfc`: the exact-duration reading alone, which is the least an occurrence may occupy;
// - `expected`: Slotlock's rule (SPEC.md, "Daylight-saving time"): the union of that reading and
//   the wall-clock one (DTEND's wall time carried to each occurrence's date, the later instant of a
//   repeated hour), or 'refuse' where Slotlock refuses the input. It differs from `rfc` only where
//   the wall-clock reading occupies more.
// The audit's notes recorded where its fixtures came from; the VTIMEZONE fixtures are checked
// against Intl by the corpus test itself.

const DAY = 86_400_000;
const anchor = Date.UTC(2026, 9, 24);
/** The window Pylota's sync job reads a feed over on 2026-10-24. */
export const FEED_WINDOW = { start: new Date(anchor - DAY), end: new Date(anchor + 365 * DAY) };
/** calendarEventRollingHorizon(2026-10-24): the window an agent's write is materialised over. */
export const STORE_WINDOW = {
  start: new Date(anchor - DAY),
  end: new Date(anchor - DAY + 367 * DAY),
};

/** VTIMEZONE fixtures (RFC 5545 §3.6.5), two with the Windows names Outlook and Exchange use. */
export const VTZ: Record<string, string[]> = {
  'Europe/Berlin': [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Europe/London': [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/London',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'America/New_York': [
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'GMT Standard Time': [
    'BEGIN:VTIMEZONE',
    'TZID:GMT Standard Time',
    'BEGIN:STANDARD',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010101T010000',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ],
  'Eastern Standard Time': [
    'BEGIN:VTIMEZONE',
    'TZID:Eastern Standard Time',
    'BEGIN:STANDARD',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ],
};
/** The IANA zone each Windows-named fixture stands for. */
export const WINDOWS_IANA: Record<string, string> = {
  'GMT Standard Time': 'Europe/London',
  'Eastern Standard Time': 'America/New_York',
};

export function cal(zones: string[], ...events: string[][]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//slotlock corpus//EN',
    ...zones.flatMap((zone) => VTZ[zone] ?? []),
    ...events.flat(),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A VEVENT; every one has a SUMMARY, so the trusted parser can read the same text. */
export const ev = (uid: string, ...lines: string[]) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20261024T000000Z',
  'SUMMARY:corpus',
  ...lines,
  'END:VEVENT',
];

/** `[start, end)` as `YYYY-MM-DDTHH:MMZ`. */
export type Span = [string, string];
export type Answer = Span[] | 'refuse';

interface CaseBase {
  id: string;
  /** The audit finding (and its earlier id) the case reproduces. */
  defect: string;
  rfc: Answer;
  expected: Answer;
  note: string;
}
export interface FeedCase extends CaseBase {
  kind: 'feed';
  variant: 'vtz' | 'bare' | 'utc' | 'windows';
  ics: string;
}
export interface StoreCase extends CaseBase {
  kind: 'store';
  content: {
    start: string;
    end: string;
    timezone: string;
    rrule?: string;
    exceptions?: { recurrenceId: string; cancelled?: boolean; start?: string; end?: string }[];
  };
}
export type Case = FeedCase | StoreCase;

const zoned = (zone: string, variant: 'vtz' | 'bare') => (variant === 'vtz' ? [zone] : []);
/** A feed case twice: with the zone's VTIMEZONE (as RFC 5545 wants) and with a bare TZID. */
const both = (build: (variant: 'vtz' | 'bare') => Omit<FeedCase, 'variant' | 'kind'>): FeedCase[] =>
  (['vtz', 'bare'] as const).map((variant) => {
    const built = build(variant);
    return { kind: 'feed', variant, ...built, id: `${built.id} [${variant}]` };
  });
const minuteIso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const span = (startMs: number, minutes: number): Span => [
  minuteIso(startMs),
  minuteIso(startMs + minutes * 60_000),
];

// D1 / ENG-1: a first instance spanning the spring change. Its later instances run 01:00-04:00
// local: three real hours by the wall clock, two by the exact length; the union is three.
const d1Spring: Span[] = [
  ['2027-03-28T00:00Z', '2027-03-28T02:00Z'],
  ['2027-04-03T23:00Z', '2027-04-04T01:00Z'],
  ['2027-04-10T23:00Z', '2027-04-11T01:00Z'],
];
const d1SpringUnion: Span[] = [
  ['2027-03-28T00:00Z', '2027-03-28T02:00Z'],
  ['2027-04-03T23:00Z', '2027-04-04T02:00Z'],
  ['2027-04-10T23:00Z', '2027-04-11T02:00Z'],
];
const d1Autumn: Span[] = [
  ['2026-10-24T23:30Z', '2026-10-25T04:30Z'],
  ['2026-11-01T00:30Z', '2026-11-01T05:30Z'],
];
// D4 / ENG-5: 02:30 on the gap night moves to 01:30Z and lasts its 75 exact minutes.
const d4: Span[] = [
  ['2027-03-26T01:30Z', '2027-03-26T02:45Z'],
  ['2027-03-27T01:30Z', '2027-03-27T02:45Z'],
  ['2027-03-28T01:30Z', '2027-03-28T02:45Z'],
  ['2027-03-29T00:30Z', '2027-03-29T01:45Z'],
  ['2027-03-30T00:30Z', '2027-03-30T01:45Z'],
];
// D6 / ENG-7: a DATE UNTIL includes its whole local day, so 2027-01-06 is the third occurrence.
const d6: Span[] = [
  ['2027-01-04T08:00Z', '2027-01-04T09:00Z'],
  ['2027-01-05T08:00Z', '2027-01-05T09:00Z'],
  ['2027-01-06T08:00Z', '2027-01-06T09:00Z'],
];
// ENG-12: an override matching no occurrence, or one whose instance an EXDATE removes, still
// occupies its own interval, as the provider shows it.
const orphan: Span[] = [
  ['2027-01-04T09:00Z', '2027-01-04T10:00Z'],
  ['2027-01-05T09:00Z', '2027-01-05T10:00Z'],
  ['2027-01-05T14:00Z', '2027-01-05T15:00Z'],
  ['2027-01-06T09:00Z', '2027-01-06T10:00Z'],
];
const exdated: Span[] = [
  ['2027-01-04T09:00Z', '2027-01-04T10:00Z'],
  ['2027-01-05T14:00Z', '2027-01-05T15:00Z'],
  ['2027-01-06T09:00Z', '2027-01-06T10:00Z'],
];

export const CASES: Case[] = [
  ...both((v) => ({
    id: 'D1 spring Berlin weekly 01:00-04:00 from 2027-03-28 feed',
    defect: 'ENG-1 (D1)',
    ics: cal(
      zoned('Europe/Berlin', v),
      ev(
        'd1',
        'DTSTART;TZID=Europe/Berlin:20270328T010000',
        'DTEND;TZID=Europe/Berlin:20270328T040000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ),
    ),
    rfc: d1Spring,
    expected: d1SpringUnion,
    note: 'DTSTART is the first instance (§3.6.1); later ones 01:00-04:00 local, 3h by the wall clock',
  })),
  {
    kind: 'store',
    id: 'D1 spring Berlin weekly store',
    defect: 'ENG-1 (D1)',
    content: {
      start: '2027-03-28T00:00:00Z',
      end: '2027-03-28T02:00:00Z',
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=WEEKLY;COUNT=3',
    },
    rfc: d1Spring,
    expected: d1SpringUnion,
    note: 'the first instance is the stored instants',
  },
  ...both((v) => ({
    id: 'D1 autumn London weekly 00:30-04:30 from 2026-10-25 feed',
    defect: 'ENG-1 (D1, autumn)',
    ics: cal(
      zoned('Europe/London', v),
      ev(
        'd1a',
        'DTSTART;TZID=Europe/London:20261025T003000',
        'DTEND;TZID=Europe/London:20261025T043000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
      ),
    ),
    rfc: d1Autumn,
    expected: d1Autumn,
    note: '00:30 BST to 04:30 GMT is five exact hours, for every member',
  })),
  {
    kind: 'store',
    id: 'D1 autumn London weekly store',
    defect: 'ENG-1 (D1, autumn)',
    content: {
      start: '2026-10-24T23:30:00Z',
      end: '2026-10-25T04:30:00Z',
      timezone: 'Europe/London',
      rrule: 'FREQ=WEEKLY;COUNT=2',
    },
    rfc: d1Autumn,
    expected: d1Autumn,
    note: 'the first instance is the stored instants',
  },

  // ENG-2: the store path must expand from instants, never from re-read wall times.
  {
    kind: 'store',
    id: 'ENG-2(1) London daily 01:15Z-01:45Z 2026-10-25 (the second 01:15) store',
    defect: 'ENG-2',
    content: {
      start: '2026-10-25T01:15:00Z',
      end: '2026-10-25T01:45:00Z',
      timezone: 'Europe/London',
      rrule: 'FREQ=DAILY;COUNT=3',
    },
    rfc: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
      ['2026-10-27T01:15Z', '2026-10-27T01:45Z'],
    ],
    expected: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
      ['2026-10-27T01:15Z', '2026-10-27T01:45Z'],
    ],
    note: 'first instance = stored instants; later days 01:15 GMT',
  },
  {
    kind: 'store',
    id: 'ENG-2(2) London daily 00:30Z-01:30Z 2026-10-25 (across the fold) store',
    defect: 'ENG-2',
    content: {
      start: '2026-10-25T00:30:00Z',
      end: '2026-10-25T01:30:00Z',
      timezone: 'Europe/London',
      rrule: 'FREQ=DAILY;COUNT=30',
    },
    rfc: [
      ['2026-10-25T00:30Z', '2026-10-25T01:30Z'],
      ...Array.from({ length: 29 }, (_, i) => span(Date.UTC(2026, 9, 26 + i, 1, 30), 60)),
    ],
    expected: [
      ['2026-10-25T00:30Z', '2026-10-25T01:30Z'],
      ...Array.from({ length: 29 }, (_, i) => span(Date.UTC(2026, 9, 26 + i, 1, 30), 60)),
    ],
    note: 'one real hour from 01:30 BST to 01:30 GMT; later days 01:30 GMT for an hour',
  },
  {
    kind: 'store',
    id: 'ENG-2(3) London daily 11:00 local, the 2026-10-25 occurrence moved to 01:15Z store',
    defect: 'ENG-2',
    content: {
      start: '2026-10-20T10:00:00Z',
      end: '2026-10-20T10:30:00Z',
      timezone: 'Europe/London',
      rrule: 'FREQ=DAILY;COUNT=7',
      exceptions: [
        {
          recurrenceId: '2026-10-25T11:00:00Z',
          start: '2026-10-25T01:15:00Z',
          end: '2026-10-25T01:45:00Z',
        },
      ],
    },
    rfc: [
      ['2026-10-23T10:00Z', '2026-10-23T10:30Z'],
      ['2026-10-24T10:00Z', '2026-10-24T10:30Z'],
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T11:00Z', '2026-10-26T11:30Z'],
    ],
    expected: [
      ['2026-10-23T10:00Z', '2026-10-23T10:30Z'],
      ['2026-10-24T10:00Z', '2026-10-24T10:30Z'],
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T11:00Z', '2026-10-26T11:30Z'],
    ],
    note: 'a moved occurrence occupies its stored instants (the window starts 2026-10-23)',
  },
  {
    kind: 'store',
    id: 'ENG-2(4) Berlin daily 01:15Z-01:45Z 2026-10-25 (the second 02:15) store',
    defect: 'ENG-2',
    content: {
      start: '2026-10-25T01:15:00Z',
      end: '2026-10-25T01:45:00Z',
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;COUNT=2',
    },
    rfc: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
    ],
    expected: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
    ],
    note: 'first instance = stored instants; later 02:15 CET',
  },
  {
    kind: 'store',
    id: 'ENG-2(5) New York daily 06:10Z-06:40Z 2026-11-01 (the second 01:10) store',
    defect: 'ENG-2',
    content: {
      start: '2026-11-01T06:10:00Z',
      end: '2026-11-01T06:40:00Z',
      timezone: 'America/New_York',
      rrule: 'FREQ=DAILY;COUNT=2',
    },
    rfc: [
      ['2026-11-01T06:10Z', '2026-11-01T06:40Z'],
      ['2026-11-02T06:10Z', '2026-11-02T06:40Z'],
    ],
    expected: [
      ['2026-11-01T06:10Z', '2026-11-01T06:40Z'],
      ['2026-11-02T06:10Z', '2026-11-02T06:40Z'],
    ],
    note: 'first instance = stored instants; later 01:10 EST',
  },
  {
    kind: 'store',
    id: 'ENG-2(6) New York daily 23:00 EDT-01:30 EST (03:00Z-06:30Z) store',
    defect: 'ENG-2',
    content: {
      start: '2026-11-01T03:00:00Z',
      end: '2026-11-01T06:30:00Z',
      timezone: 'America/New_York',
      rrule: 'FREQ=DAILY;COUNT=4',
    },
    rfc: [
      ['2026-11-01T03:00Z', '2026-11-01T06:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T07:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T07:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T07:30Z'],
    ],
    expected: [
      ['2026-11-01T03:00Z', '2026-11-01T06:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T07:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T07:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T07:30Z'],
    ],
    note: 'first instance = stored 3.5h; later members 3.5h exact (the wall clock gives 2.5h)',
  },
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-2(7) feed UTC one-off 01:15Z-01:45Z 2026-10-25',
    defect: 'ENG-2 (feed)',
    ics: cal([], ev('f7', 'DTSTART:20261025T011500Z', 'DTEND:20261025T014500Z')),
    rfc: [['2026-10-25T01:15Z', '2026-10-25T01:45Z']],
    expected: [['2026-10-25T01:15Z', '2026-10-25T01:45Z']],
    note: 'UTC is exact',
  },
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-2(8) feed UTC daily from 01:15Z 2026-10-25',
    defect: 'ENG-2 (feed)',
    ics: cal(
      [],
      ev('f8', 'DTSTART:20261025T011500Z', 'DTEND:20261025T014500Z', 'RRULE:FREQ=DAILY;COUNT=3'),
    ),
    rfc: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
      ['2026-10-27T01:15Z', '2026-10-27T01:45Z'],
    ],
    expected: [
      ['2026-10-25T01:15Z', '2026-10-25T01:45Z'],
      ['2026-10-26T01:15Z', '2026-10-26T01:45Z'],
      ['2026-10-27T01:15Z', '2026-10-27T01:45Z'],
    ],
    note: 'a UTC series repeats at 01:15Z',
  },
  ...both((v) => ({
    id: 'ENG-2(9) feed London daily 01:15-01:45 from 2026-10-20 through the fold',
    defect: 'ENG-2 (feed)',
    ics: cal(
      zoned('Europe/London', v),
      ev(
        'f9',
        'DTSTART;TZID=Europe/London:20261020T011500',
        'DTEND;TZID=Europe/London:20261020T014500',
        'RRULE:FREQ=DAILY;COUNT=10',
      ),
    ),
    rfc: [
      ['2026-10-23T00:15Z', '2026-10-23T00:45Z'],
      ['2026-10-24T00:15Z', '2026-10-24T00:45Z'],
      ['2026-10-25T00:15Z', '2026-10-25T00:45Z'],
      ...[26, 27, 28, 29].map((d): Span => [`2026-10-${d}T01:15Z`, `2026-10-${d}T01:45Z`]),
    ],
    expected: [
      ['2026-10-23T00:15Z', '2026-10-23T00:45Z'],
      ['2026-10-24T00:15Z', '2026-10-24T00:45Z'],
      // Starts at the first 01:15 (BST); its wall-clock end, 01:45, is read at the second (GMT).
      ['2026-10-25T00:15Z', '2026-10-25T01:45Z'],
      ...[26, 27, 28, 29].map((d): Span => [`2026-10-${d}T01:15Z`, `2026-10-${d}T01:45Z`]),
    ],
    note: 'a fold start is its first instant; a fold wall-clock end, its later one',
  })),
  ...both((v) => ({
    id: 'ENG-2(10) feed New York daily 23:00-01:30 (DTEND in the fold) from 2026-10-31',
    defect: 'ENG-2 (feed)',
    ics: cal(
      zoned('America/New_York', v),
      ev(
        'f10',
        'DTSTART;TZID=America/New_York:20261031T230000',
        'DTEND;TZID=America/New_York:20261101T013000',
        'RRULE:FREQ=DAILY;COUNT=4',
      ),
    ),
    rfc: [
      ['2026-11-01T03:00Z', '2026-11-01T05:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T06:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T06:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T06:30Z'],
    ],
    expected: [
      ['2026-11-01T03:00Z', '2026-11-01T06:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T06:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T06:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T06:30Z'],
    ],
    note: 'DTEND 01:30 is 05:30Z exactly (§3.3.5); its wall-clock reading is the later 06:30Z',
  })),
  ...both((v) => ({
    id: 'ENG-2(11) feed New York daily 23:00 zoned, DTEND 06:30Z (UTC) from 2026-10-31',
    defect: 'ENG-2 (feed)',
    ics: cal(
      zoned('America/New_York', v),
      ev(
        'f11',
        'DTSTART;TZID=America/New_York:20261031T230000',
        'DTEND:20261101T063000Z',
        'RRULE:FREQ=DAILY;COUNT=4',
      ),
    ),
    rfc: [
      ['2026-11-01T03:00Z', '2026-11-01T06:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T07:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T07:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T07:30Z'],
    ],
    expected: [
      ['2026-11-01T03:00Z', '2026-11-01T06:30Z'],
      ['2026-11-02T04:00Z', '2026-11-02T07:30Z'],
      ['2026-11-03T04:00Z', '2026-11-03T07:30Z'],
      ['2026-11-04T04:00Z', '2026-11-04T07:30Z'],
    ],
    note: 'a UTC DTEND is exact: 3.5h for every member',
  })),
  ...both((v) => ({
    id: 'ENG-2(12) feed London one-off 01:00-02:00 on 2026-10-25',
    defect: 'ENG-2 (feed)',
    ics: cal(
      zoned('Europe/London', v),
      ev(
        'f12',
        'DTSTART;TZID=Europe/London:20261025T010000',
        'DTEND;TZID=Europe/London:20261025T020000',
      ),
    ),
    rfc: [['2026-10-25T00:00Z', '2026-10-25T02:00Z']],
    expected: [['2026-10-25T00:00Z', '2026-10-25T02:00Z']],
    note: 'a one-off occupies exactly its interval: 01:00 BST (00:00Z) to 02:00 GMT',
  })),

  // D3 / ENG-3: a stored series addresses its skipped-hour occurrence by its UTC instant.
  ...(
    [
      ['1h', '2027-03-26T02:30:00Z', '2027-03-28T11:00:00Z', 60],
      ['2h', '2027-03-26T03:30:00Z', '2027-03-28T12:00:00Z', 120],
    ] as const
  ).flatMap(([length, end, movedEnd, minutes]): StoreCase[] => {
    const head = (day: string): Span => span(Date.parse(`${day}T01:30:00Z`), minutes);
    const tail = (day: string): Span => span(Date.parse(`${day}T00:30:00Z`), minutes);
    const base = {
      start: '2027-03-26T01:30:00Z',
      end,
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;COUNT=5',
    };
    const plain = [
      head('2027-03-26'),
      head('2027-03-27'),
      head('2027-03-28'),
      tail('2027-03-29'),
      tail('2027-03-30'),
    ];
    const moved: Span[] = [
      head('2027-03-26'),
      head('2027-03-27'),
      ['2027-03-28T10:00Z', `${movedEnd.slice(0, 16)}Z`],
      tail('2027-03-29'),
      tail('2027-03-30'),
    ];
    const cancelled = [
      head('2027-03-26'),
      head('2027-03-27'),
      tail('2027-03-29'),
      tail('2027-03-30'),
    ];
    return [
      {
        kind: 'store',
        id: `D3 Berlin daily 02:30 ${length}, plain store`,
        defect: 'ENG-3 (D3) control',
        content: base,
        rfc: plain,
        expected: plain,
        note: '02:30 on the gap night is 01:30Z (§3.3.5), for the exact length',
      },
      {
        kind: 'store',
        id: `D3 Berlin daily 02:30 ${length}, gap occurrence moved to 10:00Z store`,
        defect: 'ENG-3 (D3)',
        content: {
          ...base,
          exceptions: [
            { recurrenceId: '2027-03-28T01:30:00Z', start: '2027-03-28T10:00:00Z', end: movedEnd },
          ],
        },
        rfc: moved,
        expected: moved,
        note: 'a moved occurrence occupies only its new instants',
      },
      {
        kind: 'store',
        id: `D3 Berlin daily 02:30 ${length}, gap occurrence cancelled store`,
        defect: 'ENG-3 (D3)',
        content: {
          ...base,
          exceptions: [{ recurrenceId: '2027-03-28T01:30:00Z', cancelled: true }],
        },
        rfc: cancelled,
        expected: cancelled,
        note: 'a cancelled occurrence occupies nothing',
      },
    ];
  }),
  ...both((v) => ({
    id: 'D3 feed Berlin daily 02:30-03:30, RECURRENCE-ID 20270328T023000 moved to 10:00Z',
    defect: 'ENG-3 (D3, feed)',
    ics: cal(
      zoned('Europe/Berlin', v),
      ev(
        'd3',
        'DTSTART;TZID=Europe/Berlin:20270326T023000',
        'DTEND;TZID=Europe/Berlin:20270326T033000',
        'RRULE:FREQ=DAILY;COUNT=5',
      ),
      ev(
        'd3',
        'RECURRENCE-ID;TZID=Europe/Berlin:20270328T023000',
        'DTSTART:20270328T100000Z',
        'DTEND:20270328T110000Z',
      ),
    ),
    rfc: [
      ['2027-03-26T01:30Z', '2027-03-26T02:30Z'],
      ['2027-03-27T01:30Z', '2027-03-27T02:30Z'],
      ['2027-03-28T10:00Z', '2027-03-28T11:00Z'],
      ['2027-03-29T00:30Z', '2027-03-29T01:30Z'],
      ['2027-03-30T00:30Z', '2027-03-30T01:30Z'],
    ],
    expected: [
      ['2027-03-26T01:30Z', '2027-03-26T02:30Z'],
      ['2027-03-27T01:30Z', '2027-03-27T02:30Z'],
      ['2027-03-28T10:00Z', '2027-03-28T11:00Z'],
      ['2027-03-29T00:30Z', '2027-03-29T01:30Z'],
      ['2027-03-30T00:30Z', '2027-03-30T01:30Z'],
    ],
    note: 'RECURRENCE-ID 02:30 names the 01:30Z instance; the override replaces it',
  })),

  // D4 / ENG-5: an occurrence starting in the gap lasts its exact length, however long.
  ...both((v) => ({
    id: 'D4 feed Berlin daily 02:30-03:45 from 2027-03-26',
    defect: 'ENG-5 (D4)',
    ics: cal(
      zoned('Europe/Berlin', v),
      ev(
        'd4',
        'DTSTART;TZID=Europe/Berlin:20270326T023000',
        'DTEND;TZID=Europe/Berlin:20270326T034500',
        'RRULE:FREQ=DAILY;COUNT=5',
      ),
    ),
    rfc: d4,
    expected: d4,
    note: 'a gap start moves to 01:30Z and lasts 75 minutes',
  })),
  {
    kind: 'store',
    id: 'D4 Berlin daily 02:30 75m store',
    defect: 'ENG-5 (D4)',
    content: {
      start: '2027-03-26T01:30:00Z',
      end: '2027-03-26T02:45:00Z',
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;COUNT=5',
    },
    rfc: d4,
    expected: d4,
    note: '75 exact minutes',
  },

  // D9 / ENG-6: hours are exact durations.
  ...both((v) => ({
    id: 'D9 feed Berlin one-off 12:00 + PT48H from 2027-03-27',
    defect: 'ENG-6 (D9)',
    ics: cal(
      zoned('Europe/Berlin', v),
      ev('d9', 'DTSTART;TZID=Europe/Berlin:20270327T120000', 'DURATION:PT48H'),
    ),
    rfc: [['2027-03-27T11:00Z', '2027-03-29T11:00Z']],
    expected: [['2027-03-27T11:00Z', '2027-03-29T11:00Z']],
    note: '§3.3.6: PT48H is 48 exact hours',
  })),

  // D6 / ENG-7: a DATE UNTIL on a timed series includes its whole local day.
  ...both((v) => ({
    id: 'D6 feed Berlin daily 09:00 UNTIL=20270106 (DATE)',
    defect: 'ENG-7 (D6)',
    ics: cal(
      zoned('Europe/Berlin', v),
      ev(
        'd6',
        'DTSTART;TZID=Europe/Berlin:20270104T090000',
        'DTEND;TZID=Europe/Berlin:20270104T100000',
        'RRULE:FREQ=DAILY;UNTIL=20270106',
      ),
    ),
    rfc: d6,
    expected: d6,
    note: '§3.3.10 UNTIL is inclusive; a DATE names its whole local day',
  })),
  {
    kind: 'store',
    id: 'D6 Berlin daily 09:00 UNTIL=20270106 store',
    defect: 'ENG-7 (D6)',
    content: {
      start: '2027-01-04T08:00:00Z',
      end: '2027-01-04T09:00:00Z',
      timezone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;UNTIL=20270106',
    },
    rfc: d6,
    expected: d6,
    note: 'the stored rule names the end of 2027-01-06 in Berlin, in UTC',
  },

  // ENG-4: shapes ical.js 2.2.1 expands wrongly are refused (UTC, so only the iterator is tested).
  ...(
    [
      [
        'H1',
        '20261004T090000Z',
        'FREQ=MONTHLY;BYMONTH=10,3;BYDAY=SU;COUNT=9',
        [
          '2026-10-04',
          '2026-10-11',
          '2026-10-18',
          '2026-10-25',
          '2027-03-07',
          '2027-03-14',
          '2027-03-21',
          '2027-03-28',
          '2027-10-03',
        ],
      ],
      [
        'H2',
        '20261102T090000Z',
        'FREQ=MONTHLY;BYMONTH=11,5;BYMONTHDAY=2,29,30',
        ['2026-11-02', '2026-11-29', '2026-11-30', '2027-05-02', '2027-05-29', '2027-05-30'],
      ],
      [
        'H3',
        '20261029T090000Z',
        'FREQ=YEARLY;BYMONTHDAY=29,-1;UNTIL=20270101T235959Z',
        ['2026-10-29', '2026-10-31', '2026-11-29', '2026-11-30', '2026-12-29', '2026-12-31'],
      ],
      [
        'H4',
        '20261230T090000Z',
        'FREQ=DAILY;BYMONTHDAY=-2,31;UNTIL=20270331T235959Z',
        [
          '2026-12-30',
          '2026-12-31',
          '2027-01-30',
          '2027-01-31',
          '2027-02-27',
          '2027-03-30',
          '2027-03-31',
        ],
      ],
      [
        'H5',
        '20261231T090000Z',
        'FREQ=YEARLY;BYMONTHDAY=-1;BYDAY=TH',
        ['2026-12-31', '2027-09-30'],
      ],
      ['H6', '20270517T090000Z', 'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO', ['2027-05-17']],
      [
        'H7',
        '20270104T090000Z',
        'FREQ=WEEKLY;BYDAY=MO,TU,WE;BYSETPOS=1;COUNT=4',
        ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25'],
      ],
    ] as const
  ).flatMap(([h, dtstart, rule, days]): Case[] => {
    const rfc = days.map((day): Span => [`${day}T09:00Z`, `${day}T10:00Z`]);
    const start = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}T09:00:00Z`;
    return [
      {
        kind: 'feed',
        variant: 'utc',
        id: `ENG-4 ${h} feed ${rule}`,
        defect: 'ENG-4',
        ics: cal(
          [],
          ev(
            `h-${h}`,
            `DTSTART:${dtstart}`,
            `DTEND:${dtstart.replace('T09', 'T10')}`,
            `RRULE:${rule}`,
          ),
        ),
        rfc,
        expected: 'refuse',
        note: 'ical.js 2.2.1 expands this shape wrongly, so the series is refused',
      },
      {
        kind: 'store',
        id: `ENG-4 ${h} store ${rule}`,
        defect: 'ENG-4',
        content: { start, end: start.replace('T09', 'T10'), timezone: 'UTC', rrule: rule },
        rfc,
        expected: 'refuse',
        note: 'ical.js 2.2.1 expands this shape wrongly, so the write is refused',
      },
    ];
  }),

  // ENG-8: a zone defined only by a VTIMEZONE (a Windows name) reads fold and gap times as an IANA
  // zone does.
  {
    kind: 'feed',
    variant: 'windows',
    id: 'ENG-8 GMT Standard Time one-off 01:30-02:00 on 2026-10-25',
    defect: 'ENG-8',
    ics: cal(
      ['GMT Standard Time'],
      ev(
        'w1',
        'DTSTART;TZID=GMT Standard Time:20261025T013000',
        'DTEND;TZID=GMT Standard Time:20261025T020000',
      ),
    ),
    rfc: [['2026-10-25T00:30Z', '2026-10-25T02:00Z']],
    expected: [['2026-10-25T00:30Z', '2026-10-25T02:00Z']],
    note: 'the fold start is its first instant (BST)',
  },
  {
    kind: 'feed',
    variant: 'windows',
    id: 'ENG-8 GMT Standard Time daily 01:15-01:45 from 2026-10-20',
    defect: 'ENG-8',
    ics: cal(
      ['GMT Standard Time'],
      ev(
        'w2',
        'DTSTART;TZID=GMT Standard Time:20261020T011500',
        'DTEND;TZID=GMT Standard Time:20261020T014500',
        'RRULE:FREQ=DAILY;COUNT=10',
      ),
    ),
    rfc: [
      ['2026-10-23T00:15Z', '2026-10-23T00:45Z'],
      ['2026-10-24T00:15Z', '2026-10-24T00:45Z'],
      ['2026-10-25T00:15Z', '2026-10-25T00:45Z'],
      ...[26, 27, 28, 29].map((d): Span => [`2026-10-${d}T01:15Z`, `2026-10-${d}T01:45Z`]),
    ],
    expected: [
      ['2026-10-23T00:15Z', '2026-10-23T00:45Z'],
      ['2026-10-24T00:15Z', '2026-10-24T00:45Z'],
      ['2026-10-25T00:15Z', '2026-10-25T01:45Z'],
      ...[26, 27, 28, 29].map((d): Span => [`2026-10-${d}T01:15Z`, `2026-10-${d}T01:45Z`]),
    ],
    note: 'as Europe/London: the fold start first, the fold wall-clock end later',
  },
  {
    kind: 'feed',
    variant: 'windows',
    id: 'ENG-8 Eastern Standard Time one-off 01:30-02:00 on 2026-11-01',
    defect: 'ENG-8',
    ics: cal(
      ['Eastern Standard Time'],
      ev(
        'w3',
        'DTSTART;TZID=Eastern Standard Time:20261101T013000',
        'DTEND;TZID=Eastern Standard Time:20261101T020000',
      ),
    ),
    rfc: [['2026-11-01T05:30Z', '2026-11-01T07:00Z']],
    expected: [['2026-11-01T05:30Z', '2026-11-01T07:00Z']],
    note: 'the fold start is its first instant (EDT, 05:30Z); 02:00 EST is 07:00Z',
  },
  {
    kind: 'feed',
    variant: 'windows',
    id: 'ENG-8 GMT Standard Time one-off 01:30-03:00 on 2027-03-28 (gap)',
    defect: 'ENG-8',
    ics: cal(
      ['GMT Standard Time'],
      ev(
        'w4',
        'DTSTART;TZID=GMT Standard Time:20270328T013000',
        'DTEND;TZID=GMT Standard Time:20270328T030000',
      ),
    ),
    rfc: [['2027-03-28T01:30Z', '2027-03-28T02:00Z']],
    expected: [['2027-03-28T01:30Z', '2027-03-28T02:00Z']],
    note: 'a gap time takes the offset before the gap (+00:00)',
  },
  {
    kind: 'feed',
    variant: 'windows',
    id: 'ENG-8 GMT Standard Time one-off 00:30-01:30 on 2027-03-28 (ends in the gap)',
    defect: 'ENG-8',
    ics: cal(
      ['GMT Standard Time'],
      ev(
        'w5',
        'DTSTART;TZID=GMT Standard Time:20270328T003000',
        'DTEND;TZID=GMT Standard Time:20270328T013000',
      ),
    ),
    rfc: [['2027-03-28T00:30Z', '2027-03-28T01:30Z']],
    expected: [['2027-03-28T00:30Z', '2027-03-28T01:30Z']],
    note: 'a gap end takes the offset before the gap',
  },

  // ENG-9: transparency is per component.
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-9 feed transparent series + opaque override moved to 14:00Z',
    defect: 'ENG-9',
    ics: cal(
      [],
      ev(
        't9',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'TRANSP:TRANSPARENT',
      ),
      ev(
        't9',
        'RECURRENCE-ID:20270105T090000Z',
        'DTSTART:20270105T140000Z',
        'DTEND:20270105T150000Z',
        'TRANSP:OPAQUE',
      ),
    ),
    rfc: [['2027-01-05T14:00Z', '2027-01-05T15:00Z']],
    expected: [['2027-01-05T14:00Z', '2027-01-05T15:00Z']],
    note: '§3.8.2.7 TRANSP per component: only the opaque override occupies',
  },

  // ENG-10: an override that keeps its time.
  ...(
    [
      ['rename', ['SUMMARY:renamed'], 3],
      ['partstat', ['ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com'], 3],
      ['transp', ['TRANSP:TRANSPARENT'], 2],
    ] as const
  ).map(([kind, extra, busyDays]): FeedCase => {
    const answer = (busyDays === 3 ? ['04', '05', '06'] : ['04', '06']).map(
      (d): Span => [`2027-01-${d}T09:00Z`, `2027-01-${d}T10:00Z`],
    );
    return {
      kind: 'feed',
      variant: 'utc',
      id: `ENG-10 feed daily 09:00Z + same-time override (${kind})`,
      defect: 'ENG-10 (D2)',
      ics: cal(
        [],
        ev('o10', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
        [
          'BEGIN:VEVENT',
          'UID:o10',
          'DTSTAMP:20261024T000000Z',
          'RECURRENCE-ID:20270105T090000Z',
          'DTSTART:20270105T090000Z',
          'DTEND:20270105T100000Z',
          ...(kind === 'rename' ? [] : ['SUMMARY:corpus']),
          ...extra,
          'END:VEVENT',
        ],
      ),
      rfc: answer,
      expected: answer,
      note:
        kind === 'transp'
          ? 'a transparent override frees its instance'
          : 'an override that keeps the time is still busy',
    };
  }),

  // ENG-12: overrides Slotlock 0.2.0 dropped. Written policy (SPEC.md): an override without an end
  // lasts its series' length; one matching no occurrence, or one whose instance an EXDATE removes,
  // still occupies its own interval.
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-12(1) feed override with DTSTART 14:00Z and no DTEND',
    defect: 'ENG-12',
    ics: cal(
      [],
      ev('o12a', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
      ev('o12a', 'RECURRENCE-ID:20270105T090000Z', 'DTSTART:20270105T140000Z'),
    ),
    rfc: [
      ['2027-01-04T09:00Z', '2027-01-04T10:00Z'],
      ['2027-01-06T09:00Z', '2027-01-06T10:00Z'],
    ],
    expected: [
      ['2027-01-04T09:00Z', '2027-01-04T10:00Z'],
      ['2027-01-05T14:00Z', '2027-01-05T15:00Z'],
      ['2027-01-06T09:00Z', '2027-01-06T10:00Z'],
    ],
    note: '§3.6.1 alone ends it as it starts; Slotlock gives it the series length (fail-closed)',
  },
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-12(2) feed orphan override (RECURRENCE-ID 09:30Z matches nothing) at 14:00Z',
    defect: 'ENG-12',
    ics: cal(
      [],
      ev('o12b', 'DTSTART:20270104T090000Z', 'DTEND:20270104T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
      ev(
        'o12b',
        'RECURRENCE-ID:20270105T093000Z',
        'DTSTART:20270105T140000Z',
        'DTEND:20270105T150000Z',
      ),
    ),
    rfc: orphan,
    expected: orphan,
    note: 'RFC 5545 is silent; the provider shows the override busy',
  },
  {
    kind: 'feed',
    variant: 'utc',
    id: "ENG-12(3) feed EXDATE'd override at 14:00Z",
    defect: 'ENG-12',
    ics: cal(
      [],
      ev(
        'o12c',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE:20270105T090000Z',
      ),
      ev(
        'o12c',
        'RECURRENCE-ID:20270105T090000Z',
        'DTSTART:20270105T140000Z',
        'DTEND:20270105T150000Z',
      ),
    ),
    rfc: exdated,
    expected: exdated,
    note: 'RFC 5545 is silent; the provider shows the override busy',
  },

  // ENG-19: DTEND and DURATION together.
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-19 feed one-off DTEND 12:00Z + DURATION PT1H',
    defect: 'ENG-19',
    ics: cal([], ev('b19a', 'DTSTART:20270104T090000Z', 'DTEND:20270104T120000Z', 'DURATION:PT1H')),
    rfc: 'refuse',
    expected: 'refuse',
    note: '§3.6.1: dtend and duration MUST NOT occur in the same eventprop',
  },
  {
    kind: 'feed',
    variant: 'utc',
    id: 'ENG-19 feed daily DTEND 12:00Z + DURATION PT1H',
    defect: 'ENG-19',
    ics: cal(
      [],
      ev(
        'b19b',
        'DTSTART:20270104T090000Z',
        'DTEND:20270104T120000Z',
        'DURATION:PT1H',
        'RRULE:FREQ=DAILY;COUNT=2',
      ),
    ),
    rfc: 'refuse',
    expected: 'refuse',
    note: '§3.6.1: MUST NOT occur together',
  },
];
