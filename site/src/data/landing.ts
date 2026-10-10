// Every sentence on the landing page lives here, so the HTML page (src/pages/index.astro) and its
// Markdown twin (src/pages/index.md.ts) cannot say different things. Numbers and names that come
// from the package are read from src/generated/facts.json, which scripts/sync-content.mjs builds
// from the repository's source on every build.
import facts from '../generated/facts.json';

export const REPO_URL = 'https://github.com/PILOTAAI/slotlock';
export const RACE_TEST_URL = `${REPO_URL}/blob/main/src/__tests__/core.integration.test.ts`;
export const DDL_URL = `${REPO_URL}/blob/main/src/ddl.ts`;

export { facts };

export const toolNames: string[] = facts.tools.map((tool) => tool.name);

export interface Heading {
  soft: string;
  strong: string;
}

export const meta = {
  title: 'Slotlock: the calendar AI agents cannot double-book',
  description:
    'Slotlock is an open-source calendar for AI agents. Each resource is its own calendar, holds expire on their own, and PostgreSQL refuses any overlapping write and returns the conflict as data.',
};

export const hero = {
  pill: { label: `${facts.version} pre-release`, link: 'Release notes', href: '/docs/changelog/' },
  eyebrow: `Open source · ${facts.license} · PostgreSQL 16`,
  heading: {
    soft: 'Slotlock is a calendar for AI agents.',
    strong: 'Two agents, one slot, one booking.',
  } satisfies Heading,
  lede: 'Each car, room, person and machine is its own calendar: agents find and book time over MCP or A2A, or hold it from TypeScript, and PostgreSQL refuses every overlapping write with the conflict returned as data.',
  install: [
    // Offered only while the README documents the Docker quickstart (facts.composeUp).
    ...(facts.composeUp
      ? [
          {
            id: 'docker',
            label: 'Docker',
            command: facts.composeUp,
            note: 'In a clone, after `cp .env.example .env` and filling in its secrets.',
          },
        ]
      : []),
    {
      id: 'source',
      label: 'From source',
      command:
        'git clone https://github.com/PILOTAAI/slotlock && cd slotlock && npm ci && npm run build',
      note: `${facts.version} is not on npm yet.`,
    },
    {
      id: 'npm',
      label: 'npm',
      command: 'npm install slotlock postgres',
      note: 'Works once the first release is published.',
    },
  ],
};

/** Hours on the hero axis are local wall time of each resource, 08:00 to 18:00. */
export type BlockKind = 'confirmed' | 'hold' | 'refused' | 'busy' | 'unproven' | 'closed';

export interface Block {
  start: number;
  end: number;
  kind: BlockKind;
  label: string;
  short?: string;
  /** Animation role in the hero; blocks without one are there from the start. */
  step?: 'a-hold' | 'a-confirm' | 'b-refused' | 'b-hold';
}

export interface Row {
  name: string;
  detail: string;
  zone: string;
  blocks: Block[];
  requestLane?: boolean;
}

export const heroRows: Row[] = [
  {
    name: 'Van AB12 CDE',
    detail: 'vehicle',
    zone: 'Europe/London',
    requestLane: true,
    blocks: [
      { start: 8, end: 9.5, kind: 'confirmed', label: 'BK-1838', short: '1838' },
      {
        start: 10,
        end: 12,
        kind: 'hold',
        label: 'A · hold',
        short: 'A · hold',
        step: 'a-hold',
      },
      {
        start: 10,
        end: 12,
        kind: 'confirmed',
        label: 'A · booked',
        short: 'A',
        step: 'a-confirm',
      },
      {
        start: 11,
        end: 13,
        kind: 'refused',
        label: 'B · refused',
        short: 'B ✕',
        step: 'b-refused',
      },
      {
        start: 12,
        end: 14,
        kind: 'hold',
        label: 'B · hold',
        short: 'B · hold',
        step: 'b-hold',
      },
      { start: 17, end: 18, kind: 'closed', label: 'closed', short: '' },
    ],
  },
  {
    name: 'Room 3',
    detail: 'meeting room',
    zone: 'Europe/London',
    blocks: [
      { start: 9, end: 10, kind: 'confirmed', label: 'Sync', short: '' },
      { start: 13, end: 14.5, kind: 'confirmed', label: 'Interview', short: '' },
      { start: 17, end: 18, kind: 'closed', label: 'closed', short: '' },
    ],
  },
  {
    name: 'Dr Shah',
    detail: 'clinician',
    zone: 'Europe/London',
    blocks: [
      { start: 9, end: 10.5, kind: 'busy', label: 'busy · .ics', short: '.ics' },
      {
        start: 14,
        end: 18,
        kind: 'unproven',
        label: 'unproven after 14:00',
        short: 'unproven',
      },
    ],
  },
  {
    name: 'Mill 2',
    detail: 'machine',
    zone: 'Europe/Berlin',
    blocks: [
      { start: 8, end: 11, kind: 'confirmed', label: 'Job 4471', short: '4471' },
      { start: 16, end: 18, kind: 'closed', label: 'closed', short: '' },
    ],
  },
];

export interface LogLine {
  time: string;
  agent: 'A' | 'B';
  call: string;
  args: string;
  result: string;
  tone: 'ok' | 'hold' | 'refused';
  step: number;
}

/** The calls, in order. Library calls run inside store.withTenant; tool calls go over MCP. */
export const heroLog: LogLine[] = [
  {
    time: '09:41:02.108',
    agent: 'A',
    call: 'slotlock_find_next_available',
    args: 'van, 120 min, from 10:00',
    result: '10:00–12:00 · certain',
    tone: 'ok',
    step: 1,
  },
  {
    time: '09:41:02.131',
    agent: 'A',
    call: 'acquireHold',
    args: '10:00–12:00, ttl 10 min',
    result: 'ok: held to 09:51:02',
    tone: 'hold',
    step: 2,
  },
  {
    time: '09:41:02.133',
    agent: 'B',
    call: 'acquireHold',
    args: '11:00–13:00, ttl 10 min',
    result: "code: 'overlap'",
    tone: 'refused',
    step: 3,
  },
  {
    time: '09:41:02.150',
    agent: 'B',
    call: 'slotlock_find_next_available',
    args: 'van, 120 min, from 10:00',
    result: '12:00–14:00 · certain',
    tone: 'ok',
    step: 4,
  },
  {
    time: '09:41:02.164',
    agent: 'B',
    call: 'acquireHold',
    args: '12:00–14:00, ttl 10 min',
    result: 'ok: held to 09:51:02',
    tone: 'hold',
    step: 5,
  },
  {
    time: '09:41:37.402',
    agent: 'A',
    call: 'confirmHold',
    args: 'hold of 10:00–12:00',
    result: 'ok: confirmed',
    tone: 'ok',
    step: 6,
  },
];

export const heroRefusal = {
  title: 'Refused by PostgreSQL',
  body: 'Agent B asked for 11:00–13:00, but part of it is already held.',
  result: "{ ok: false, code: 'overlap', conflictingReservationId: '3f9c…' }",
  next: 'Next certain slot',
  chip: '12:00–14:00',
};

export const heroAria =
  'A calendar for four resources from 08:00 to 18:00, each in its own local time: a van, a meeting room, a clinician and a machine. At 09:41 Agent A finds the van free from 10:00 to 12:00 and holds it for ten minutes. Agent B tries to hold 11:00 to 13:00 on the same van; PostgreSQL refuses it with the code overlap, shown as a red outline. Agent B asks for the next certain two hours, gets 12:00 to 14:00 and holds that until 09:51. Agent A confirms its hold, which becomes a booking. The clinician has a busy block imported from an iCalendar feed, and the time after 14:00 is marked unproven because the feed has only been read up to then. The van, the room and the machine close when their rules say the bookable hours end.';

export const specStrip = [
  'PostgreSQL EXCLUDE',
  'Expiring holds',
  'Half-open [start, end)',
  `MCP ${facts.mcpModern}`,
  `A2A ${facts.a2a}`,
  'iCalendar in and out',
  facts.license,
];

export const proof = {
  id: 'proof',
  counter: '01',
  heading: { soft: 'Two agents ask for the same van.', strong: 'PostgreSQL lets one through.' },
  lede: 'The overlap check is an exclusion constraint on the reservations table, so a race has exactly one winner and the loser gets a result it can act on.',
  constraintCaption: 'src/ddl.ts',
  resultCaption: 'What the second writer gets back',
  storeResult: "{ ok: false, code: 'overlap', conflictingReservationId: '3f9c…' }",
  mcpResult:
    '{"isError": true, "content": [{"type": "text", "text": "{\\"error\\":{\\"code\\":\\"overlap\\"}}"}]}',
  storeLabel: 'TypeScript',
  mcpLabel: 'MCP tool result',
  testLink: 'Read the race test',
  /** What the constraint does to two concurrent inserts, as the integration suite runs it. */
  race: [
    { who: 'racer-a', what: 'INSERT [10:00, 12:00)', result: 'committed', tone: 'g' },
    {
      who: 'racer-b',
      what: 'INSERT [11:00, 13:00)',
      result: 'SQLSTATE 23P01, exclusion_violation',
      tone: 'r',
    },
  ],
  raceNote: "returned to racer-b as { ok: false, code: 'overlap' }",
};

export const steps = {
  id: 'how',
  counter: '02',
  heading: { soft: 'Find it, hold it, confirm it.', strong: 'Or let the hold run out.' },
  items: [
    {
      n: '01',
      title: 'Model each resource',
      body: 'Give it an IANA time zone and weekly hours as an RRULE. No rule means never bookable.',
      link: { label: 'Resources and rules', href: '/docs/concepts/#resources' },
    },
    {
      n: '02',
      title: 'Find a slot and hold it',
      body: `Agents ask \`slotlock_find_next_available\` for the earliest certain slot. From TypeScript, \`acquireHold\` keeps it for up to ${facts.maxHoldDays} days on the database clock.`,
      link: { label: 'Holds', href: '/docs/concepts/#holds' },
    },
    {
      n: '03',
      title: 'Confirm, or let it lapse',
      body: '`confirmHold` turns the hold into a booking. An expired hold is cleared by the next writer that wants the time, with no cron job.',
      link: { label: 'The exclusion constraint', href: '/docs/concepts/#the-exclusion-constraint' },
    },
  ],
  diagram: {
    inputs: ['Your provider adapters', 'iCalendar feeds'],
    core: 'Slotlock engine',
    store: 'PostgreSQL 16 · schema slotlock',
    outputs: ['MCP', 'A2A', 'TypeScript'],
    aria: 'Diagram: your provider adapters and iCalendar feeds send busy time into the Slotlock engine, which stores everything in the slotlock schema of PostgreSQL 16 and serves agents over MCP, A2A and TypeScript.',
  },
};

export const model = {
  id: 'model',
  counter: '03',
  heading: {
    soft: 'Calendars belong to resources,',
    strong: 'each with its own rules and clock.',
  },
  lede: 'Rules run in the resource’s own time zone, daylight saving included, and a feed that has not been read makes time unproven instead of free.',
  /** The van's WeeklyAvailabilityRule; the week strip below is drawn from these numbers. */
  weekly: {
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    startMinutes: 480,
    durationMinutes: 540,
  },
  ruleCaption: 'expandRules · Van AB12 CDE · Europe/London',
  yourTime: { label: 'Your time', value: '04:41', zone: 'America/New_York' },
  resourceTime: { label: 'Resource time', value: '09:41', zone: 'Europe/London' },
};

/** The model band's narrative label, with its counts taken from legendCounts(). */
const DAYS = [
  ['MO', 'Mon', 'Monday'],
  ['TU', 'Tue', 'Tuesday'],
  ['WE', 'Wed', 'Wednesday'],
  ['TH', 'Thu', 'Thursday'],
  ['FR', 'Fri', 'Friday'],
  ['SA', 'Sat', 'Saturday'],
  ['SU', 'Sun', 'Sunday'],
] as const;

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The van's week as expandRules sees it: open inside the rule's window on its BYDAY days, closed otherwise. */
export function weekWindows() {
  const { rrule, startMinutes, durationMinutes } = model.weekly;
  const byDay = (/BYDAY=([A-Z,]+)/.exec(rrule)?.[1] ?? '').split(',');
  const end = startMinutes + durationMinutes;
  return DAYS.map(([code, short, long]) => ({
    short,
    long,
    open: byDay.includes(code),
    start: startMinutes / 60,
    end: end / 60,
    label: `${hhmm(startMinutes)}–${hhmm(end)}`,
  }));
}

/** The rule as the TypeScript a reader would write. */
export function ruleCode(): string {
  const { rrule, startMinutes, durationMinutes } = model.weekly;
  return [
    'expandRules(',
    `  [{ rrule: '${rrule}',`,
    `     startMinutes: ${startMinutes}, durationMinutes: ${durationMinutes} }],`,
    '  week,',
    "  'Europe/London',",
    ')',
  ].join('\n');
}

export function modelAria(): string {
  const counts = legendCounts();
  const list = legend.map(({ kind, label }) => `${counts[kind]} ${label}`).join(', ');
  const week = weekWindows();
  const open = week.filter((day) => day.open);
  return `The van's weekly rule expanded over one week in Europe/London: open ${open[0]?.long} to ${open.at(-1)?.long} from ${open[0]?.label}, closed by rule on ${week
    .filter((day) => !day.open)
    .map((day) => day.long)
    .join(
      ' and ',
    )}. Beside it, the van's time next to the viewer's: ${model.resourceTime.value} in London is ${model.yourTime.value} in New York. Below, the legend of the calendar at the top of the page with how many blocks of each kind it shows: ${list}.`;
}

export const legend: { kind: BlockKind; label: string }[] = [
  { kind: 'confirmed', label: 'confirmed' },
  { kind: 'hold', label: 'held, expires' },
  { kind: 'refused', label: 'refused write' },
  { kind: 'busy', label: 'busy from iCalendar' },
  { kind: 'unproven', label: 'unproven' },
  { kind: 'closed', label: 'closed by rule' },
];

/** Legend counts, derived from the hero data rather than typed in. A held-then-booked slot counts once, as booked. */
export function legendCounts(): Record<BlockKind, number> {
  const counts: Record<BlockKind, number> = {
    confirmed: 0,
    hold: 0,
    refused: 0,
    busy: 0,
    unproven: 0,
    closed: 0,
  };
  for (const row of heroRows) {
    for (const block of row.blocks) {
      if (block.step === 'a-hold') continue;
      counts[block.kind] += 1;
    }
  }
  return counts;
}

export const developers = {
  id: 'developers',
  counter: '04',
  heading: { soft: 'One registry, three ways in.', strong: 'MCP, A2A or a TypeScript import.' },
  lede: `The ${facts.toolCount} tools and their JSON Schemas come from one registry, so a refusal reads the same on every transport.`,
  links: [
    { label: 'Every tool, field by field', href: '/docs/tools/' },
    { label: 'Error codes', href: '/docs/tools/#error-codes' },
    { label: 'Connect Claude Code, Cursor or VS Code', href: '/docs/connect/' },
    { label: 'Confirmation before writes', href: '/docs/security/#confirmation-before-writes' },
    {
      label: 'Live calendar updates',
      href: '/docs/reference/#calendar-resources-and-live-updates',
    },
  ],
};

export const security = {
  id: 'security',
  counter: '05',
  heading: { soft: 'Agents propose.', strong: 'A person confirms, PostgreSQL decides.' },
  approval: {
    eyebrow: 'slotlock_create_event · input required',
    message:
      'Book "Vehicle handover" on resource vehicle-42: 2027-03-29 10:00–11:00 (Europe/London).',
    checkbox: 'Confirm this change',
    help: 'The agent changes the calendar only if this is ticked.',
    decline: 'Decline',
    accept: 'Accept',
    seal: `requestState sealed with HMAC-SHA256 · expires in ${facts.confirmTtlSeconds / 60} min`,
  },
  receipt: { label: 'Created', detail: 'revision 1 · replayed: false' },
  aria: `A confirmation form shown to a person before an agent's write runs. It reads: Book "Vehicle handover" on resource vehicle-42, 29 March 2027, 10:00 to 11:00, Europe/London, with one tick box and Decline and Accept buttons. Below it, the receipt after acceptance: the event was created at revision 1.`,
  statements: [
    'Tenancy comes from your `authenticate` callback. No tool argument can choose a tenant.',
    'Forced row-level security returns nothing when the tenant setting is missing.',
    `A pending confirmation is sealed to the caller, the tool, the exact arguments and an expiry (${facts.confirmTtlSeconds} seconds by default).`,
    'A client that cannot ask a person (MCP 2025 revisions, A2A) gets `confirmation_required`, and the write never runs.',
    `Live updates are capped at ${facts.subscriptionsPerPrincipal} streams per principal and ${facts.subscriptionsTotal} per server by default.`,
    `Idempotency evidence is kept for ${facts.retentionDays} days by default, then pruned to return quota.`,
  ],
};

export const compare = {
  id: 'compare',
  counter: '06',
  heading: { soft: 'Compared with', strong: 'a bookings table and a cron job.' },
  columns: ['', 'Table and cron job', 'Slotlock'],
  rows: [
    [
      'Two writers, one slot',
      'A read-then-insert check can pass for both.',
      'The constraint admits one; the other gets `overlap`.',
    ],
    [
      'Abandoned holds',
      'A scheduled job deletes them later.',
      'They expire on the database clock; the next writer clears them.',
    ],
    [
      'Back-to-back bookings',
      'Boundary rules vary by query.',
      'Half-open intervals: ending and starting at 12:00 never collide.',
    ],
    [
      'A stale external feed',
      'Missing data reads as free time.',
      'Time the feed has not covered is unproven.',
    ],
    [
      'Retries',
      'A retry can book twice.',
      'A replay with the same idempotency key returns the first result.',
    ],
    [
      'Agent access',
      'You write and maintain the tools.',
      `${facts.toolCount} MCP tools and A2A skills with JSON Schemas.`,
    ],
  ],
};

export const openSource = {
  id: 'open-source',
  counter: '07',
  heading: { soft: `${facts.license}, on the PostgreSQL`, strong: 'you already run.' },
  repo: {
    name: 'PILOTAAI/slotlock',
    caption: 'Repository on GitHub',
    includes: ['Engine', 'Schema and RLS', 'MCP and A2A server', 'Node listener'],
    run: facts.composeUp ?? 'npm ci && npm run build',
    cta: 'View on GitHub',
  },
  statements: [
    'GOVERNANCE.md commits the engine, the spec and the server to Apache-2.0 or another OSI-approved licence.',
    'Contributions are signed off under the Developer Certificate of Origin. There is no CLA.',
    facts.composeUp
      ? 'Docker Compose runs PostgreSQL 16 and the server on 127.0.0.1; writes wait for a person by default.'
      : 'Needs Node.js 22.12 or newer and PostgreSQL 16 with btree_gist.',
    'There is no hosted service. You run it, next to your own data.',
    'Report vulnerabilities privately through the repository’s Security tab.',
  ],
};

export const faq = {
  id: 'faq',
  heading: { soft: 'Questions', strong: 'we expect first.' },
  items: [
    {
      q: 'Does it sync with Google Calendar or Outlook?',
      a: 'Not by itself. Provider adapters live in your application; Slotlock normalises their changes, reads and writes iCalendar, and records how much of each feed has been read.',
    },
    {
      q: 'Why not take a lock in my application?',
      a: 'A lock protects the code paths that remember to take it. The constraint covers every write that reaches the table, including the ones an agent makes.',
    },
    {
      q: 'Is it ready for production?',
      a: `Not yet. ${facts.version} is a pre-release; the README keeps the production checklist.`,
    },
    {
      q: 'Does a model decide anything?',
      a: 'No. Models call tools. The database decides overlaps, your authorize callback decides permissions, and a person can be asked to confirm each write.',
    },
  ],
};

export const closing = {
  heading: {
    soft: 'Stop checking for conflicts in application code.',
    strong: 'Let PostgreSQL refuse them.',
  },
};

export const nav = [
  { label: 'Docs', href: '/docs/' },
  { label: 'Developers', href: '#developers' },
  { label: 'Security', href: '#security' },
  { label: 'Open source', href: '#open-source' },
];

export const footer = {
  tagline: 'The calendar AI agents cannot double-book.',
  columns: [
    {
      title: 'Product',
      links: [
        { label: 'Introduction', href: '/docs/' },
        { label: 'Concepts', href: '/docs/concepts/' },
        { label: 'Security model', href: '/docs/security/' },
        { label: 'Changelog', href: '/docs/changelog/' },
      ],
    },
    {
      title: 'Developers',
      links: [
        { label: 'Quickstart', href: '/docs/quickstart/' },
        { label: 'Tools reference', href: '/docs/tools/' },
        { label: 'MCP and A2A server', href: '/docs/reference/' },
        { label: 'Specification', href: '/docs/specification/' },
        { label: 'Manifest schema', href: '/schema/manifest.schema.json' },
      ],
    },
    {
      title: 'Source',
      links: [
        { label: 'GitHub', href: REPO_URL },
        { label: 'Licence', href: `${REPO_URL}/blob/main/LICENSE` },
        { label: 'Security policy', href: `${REPO_URL}/blob/main/SECURITY.md` },
        { label: 'Contributing', href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
      ],
    },
  ],
  legal: `${facts.license} · A Pylota project · © 2026 TREFT LTD`,
};
