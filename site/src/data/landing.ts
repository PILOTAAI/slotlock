// Every sentence on the landing page lives here, so the HTML page (src/pages/index.astro) and its
// Markdown twin (src/pages/index.md.ts) cannot say different things. Numbers and names that come
// from the package are read from src/generated/facts.json, which scripts/sync-content.mjs builds
// from the repository's source on every build.
import facts from '../generated/facts.json';

export const REPO_URL = 'https://github.com/PILOTAAI/slotlock';
export const RACE_TEST_URL = `${REPO_URL}/blob/main/src/__tests__/core.integration.test.ts`;
export const DDL_URL = `${REPO_URL}/blob/main/src/ddl.ts`;

export { facts };

/** 0.2 can accept double bookings around daylight-saving changes (/docs/known-issues/). */
const knownIssues = facts.version.startsWith('0.2.');

export const toolNames: string[] = facts.tools.map((tool) => tool.name);

/** `Python, Go, Rust, Java and .NET`, from the client directories in the repository. */
const clientList = `${facts.clients.slice(0, -1).join(', ')} and ${facts.clients.at(-1)}`;

/** How long the change feed keeps changes, naming the setting once the server has one. */
const retention = facts.retentionSetting
  ? `${facts.changeRetentionDays} days by default (\`${facts.retentionSetting}\`)`
  : `${facts.changeRetentionDays} days`;

/** A tool's title as the registry gives it, which is what the dashboard shows. */
const toolTitle = (name: string): string => {
  const tool = facts.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`landing: no tool ${name} in facts.json`);
  return tool.title;
};

/** `A, B and C`. */
const listed = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** The dashboard's sidebar, in the order src/dashboard.ts lists it. */
const dashboardNav = [
  'Overview',
  'Resources',
  'Waitlist',
  'API keys',
  'Webhooks',
  ...(facts.assistant ? ['Assistant'] : []),
  'Settings',
];

export interface Heading {
  soft: string;
  strong: string;
}

export const meta = {
  title: 'Slotlock: the calendar AI agents cannot double-book',
  description:
    'Slotlock is an open-source calendar for AI agents. Each resource is its own calendar; agents hold and book time over MCP, A2A or REST and show free slots as an MCP App; people manage it in a GitHub sign-in dashboard; PostgreSQL refuses any overlapping write and returns the conflict as data.',
};

export interface InstallTarget {
  id: string;
  label: string;
  command: string;
  /** False for a line that goes in a build file, not a terminal. */
  shell?: false;
  note: string;
}

export const hero = {
  // The site deploys when a release merges, but npm serves that version only once a maintainer
  // approves it, so the pill names the version and claims nothing about where it is published.
  pill: { label: `Version ${facts.version}`, link: 'Release notes', href: '/docs/changelog/' },
  eyebrow: `Open source · ${facts.license} · PostgreSQL 16 to 18`,
  heading: {
    soft: 'Slotlock is a calendar for AI agents.',
    strong: 'Two agents, one slot, one booking.',
  } satisfies Heading,
  lede: 'Each car, room, person and machine is its own calendar. Agents find, hold and book time over MCP, A2A or REST, a person picks the slot in the chat, and PostgreSQL refuses every overlapping write with the conflict returned as data.',
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
      id: 'npm',
      label: 'npm',
      command: `npm install slotlock@${facts.version} postgres`,
      note: `Then \`npx slotlock migrate\` with \`SLOTLOCK_MIGRATE_DATABASE_URL\` set to the schema owner's URL, and \`npx slotlock serve\` with \`DATABASE_URL\` set to a role that owns nothing.${knownIssues ? ' Read the [known issues](/docs/known-issues/) first.' : ''}`,
    },
    // Clients for a running server; versions match the release (clients/README.md).
    {
      id: 'python',
      label: 'Python',
      command: `pip install slotlock==${facts.version}`,
      note: 'Python 3.10+, against a running server. [Client guide](/docs/clients/#python)',
    },
    {
      id: 'go',
      label: 'Go',
      command: `go get github.com/PILOTAAI/slotlock/clients/go@v${facts.version}`,
      note: 'Go 1.22+, against a running server. [Client guide](/docs/clients/#go)',
    },
    {
      id: 'rust',
      label: 'Rust',
      command: `cargo add slotlock@${facts.version}`,
      note: 'Rust 1.85+, against a running server. [Client guide](/docs/clients/#rust)',
    },
    {
      id: 'java',
      label: 'Java',
      command: `implementation("io.pylota:slotlock:${facts.version}")`,
      shell: false,
      note: 'Gradle; Maven takes the same coordinates. Java 17+. [Client guide](/docs/clients/#java)',
    },
    {
      id: 'dotnet',
      label: '.NET',
      command: `dotnet add package Slotlock.Client -v ${facts.version}`,
      note: '.NET 8 or 10, against a running server. [Client guide](/docs/clients/#net)',
    },
  ] satisfies InstallTarget[],
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

/** The calls, in order, as two agents make them over MCP. */
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
    call: 'slotlock_hold_slots',
    args: '10:00–12:00, 600 s',
    result: 'held to 09:51:02',
    tone: 'hold',
    step: 2,
  },
  {
    time: '09:41:02.133',
    agent: 'B',
    call: 'slotlock_hold_slots',
    args: '11:00–13:00, 600 s',
    result: "refused: 'overlap'",
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
    call: 'slotlock_hold_slots',
    args: '12:00–14:00, 600 s',
    result: 'held to 09:51:02',
    tone: 'hold',
    step: 5,
  },
  {
    time: '09:41:37.402',
    agent: 'A',
    call: 'slotlock_create_event',
    args: 'from its hold_id',
    result: 'booked, revision 1',
    tone: 'ok',
    step: 6,
  },
];

export const heroRefusal = {
  title: 'Refused by PostgreSQL',
  body: 'Agent B asked for 11:00–13:00, but part of it is already held.',
  result: "{ holds: [], refused: [{ index: 0, code: 'overlap' }] }",
  next: 'Next certain slot',
  chip: '12:00–14:00',
};

export const heroAria =
  'A calendar for four resources from 08:00 to 18:00, each in its own local time: a van, a meeting room, a clinician and a machine. At 09:41 Agent A finds the van free from 10:00 to 12:00 and holds it for ten minutes. Agent B tries to hold 11:00 to 13:00 on the same van; PostgreSQL refuses it with the code overlap, shown as a red outline. Agent B asks for the next certain two hours, gets 12:00 to 14:00 and holds that until 09:51. Agent A confirms its hold, which becomes a booking. The clinician has a busy block imported from an iCalendar feed, and the time after 14:00 is marked unproven because the feed has only been read up to then. The van, the room and the machine close when their rules say the bookable hours end.';

/** What is in the box, one line per layer. */
export const specStrip: { label: string; value: string }[] = [
  { label: 'Overlaps', value: 'PostgreSQL EXCLUDE constraint, expiring holds' },
  {
    label: 'Agents',
    value: `MCP ${facts.mcpModern}, MCP Apps, A2A ${facts.a2a}, ${facts.toolCount} tools`,
  },
  {
    label: 'Applications',
    value: `REST, OpenAPI, RFC 9457 errors, ${facts.clientCount} language clients`,
  },
  { label: 'Interchange', value: 'CloudEvents, Standard Webhooks, iCalendar, JSCalendar' },
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
      body: `\`slotlock_find_available_slots\` lists certain slots; \`slotlock_hold_slots\` keeps up to ${facts.holdSlotsMax} for ${facts.holdTtlMin} to ${facts.holdTtlMax} seconds while a person chooses.`,
      link: { label: 'Holds', href: '/docs/concepts/#holds' },
    },
    {
      n: '03',
      title: 'Confirm, or let it lapse',
      body: 'Booking a `hold_id` turns that hold into the event and frees the rest. An expired hold is cleared by the next writer, with no cron job.',
      link: { label: 'The exclusion constraint', href: '/docs/concepts/#the-exclusion-constraint' },
    },
  ],
  diagram: {
    inputs: ['Your provider adapters', 'iCalendar feeds'],
    core: 'Slotlock engine',
    store: 'PostgreSQL · schema slotlock',
    outputs: ['MCP', 'A2A', 'REST', 'TypeScript'],
    aria: 'Diagram: your provider adapters and iCalendar feeds send busy time into the Slotlock engine, which stores everything in the slotlock schema of PostgreSQL and serves agents and applications over MCP, A2A, REST and TypeScript.',
  },
};

export const model = {
  id: 'model',
  counter: '03',
  heading: {
    soft: 'Calendars belong to resources,',
    strong: 'each with its own rules and clock.',
  },
  lede: 'Rules run in the resource’s own time zone, daylight saving included. Time a calendar feed has not read is unproven, not free, and with `requireCertain` a booking there is refused.',
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

/** The MCP Apps slot picker (src/mcp-app.ts), drawn with the words the view itself shows. */
export const picker = {
  id: 'picker',
  counter: '04',
  heading: { soft: 'The agent shows the free slots.', strong: 'A person picks one in the chat.' },
  lede: 'Search results open in an MCP App, a calendar view any MCP Apps host renders in a sandbox, MCP-UI’s renderer included.',
  view: {
    title: 'Pick a time',
    resource: 'Van AB12 CDE · Europe/London',
    days: ['Mon 29', 'Tue 30', 'Wed 31'],
    groups: [
      { label: 'Morning', times: ['09:00', '10:30'] },
      { label: 'Afternoon', times: ['12:00', '14:00', '15:30'] },
    ],
    picked: '12:00',
    held: 'Held until 09:51',
    button: 'Book this time',
    sent: 'Sent to your agent',
  },
  aria: 'A calendar view inside a chat: the van AB12 CDE, three days to choose from, and Tuesday’s free times grouped into morning and afternoon. The 12:00 slot is picked and held until 09:51, and the Book this time button sends one message to the agent, which books it through the usual confirmation.',
  points: [
    'Picking a time sends the agent one message; the agent books it through the usual confirmation.',
    'The view makes no network requests, and write tools are visible to the model only.',
  ],
  link: { label: 'MCP Apps', href: '/docs/connect/#mcp-apps' },
};

/** The org dashboard (src/dashboard.ts), drawn with the labels its Overview shows. */
export const dashboard = {
  id: 'dashboard',
  counter: '05',
  heading: { soft: 'Sign in with GitHub.', strong: 'See what every agent booked.' },
  lede: 'The server serves a dashboard at `/dashboard`. Its pages render on the server, work without JavaScript, and follow light and dark.',
  view: {
    brand: 'Slotlock',
    org: 'acme-rentals',
    nav: dashboardNav,
    title: 'Overview',
    stats: [
      { label: `Booked, next ${facts.dashboardAgendaDays} days`, value: '18' },
      { label: 'Live holds', value: '3' },
      { label: 'Resources', value: '12' },
      { label: 'Active keys', value: '4' },
    ],
    upcoming: [
      { day: 'Today', time: '10:00–12:00', what: 'Van AB12 CDE', kind: 'Booking' },
      { day: 'Today', time: '12:00–14:00', what: 'Van AB12 CDE', kind: 'Hold' },
      { day: 'Today', time: '13:00–14:30', what: 'Room 3', kind: 'Event' },
      { day: 'Tomorrow', time: '09:00–17:00', what: 'Van CD34 EFG', kind: 'Booking' },
    ],
    activity: [
      { text: 'Hold booked', on: 'Van AB12 CDE', who: 'booking-agent', when: '2 min ago', tone: 'good' },
      { text: 'Waitlist offer sent', on: 'Van CD34 EFG', who: 'Slotlock', when: '18 min ago', tone: 'good' },
      { text: 'No-show released', on: 'Room 3', who: 'Slotlock', when: '1 h ago', tone: 'bad' },
      { text: 'Calendar sync is behind', on: 'Dr Shah', who: 'Slotlock', when: '3 h ago', tone: 'bad' },
    ],
  },
  aria: `The dashboard's Overview for the GitHub organization acme-rentals. A sidebar lists ${listed(dashboardNav)}. Four counts: 18 booked in the next ${facts.dashboardAgendaDays} days, 3 live holds, 12 resources, 4 active keys. Upcoming lists today's van booking, a hold on the same van, an event in Room 3, and tomorrow's booking of a second van. Agent activity lists, newest first: a hold booked by the key booking-agent, a waitlist offer, a no-show released, and a calendar sync that is behind.`,
  points: [
    ...(facts.dashboardOrgs
      ? [
          {
            title: 'A tenant per GitHub organization',
            body: 'With `SLOTLOCK_DASHBOARD_ORGS`, an organization is one tenant its members share. Removing it signs its sessions out and stops its keys.',
          },
        ]
      : []),
    {
      title: 'A page for each part',
      body: `Each resource’s hours, booking rules and pool; the waitlist; API keys with the MCP and A2A endpoints; webhooks with each endpoint’s delivery health${facts.assistant ? '; the assistant' : ''}.`,
    },
    ...(facts.dashboardWorker
      ? [
          {
            title: 'On your server or on Cloudflare',
            body: 'From `slotlock serve`, or as a Worker at its own origin that reaches your PostgreSQL through Hyperdrive.',
          },
        ]
      : []),
  ],
  link: { label: 'Dashboard', href: '/docs/dashboard/' },
  /** The Assistant page (src/dashboard.ts assistantPage), drawn with the labels it shows. */
  assistant: facts.assistant
    ? {
        heading: 'Operate it by chat',
        view: {
          path: 'slotlock.example.com/dashboard/assistant',
          title: 'Assistant',
          reset: 'New conversation',
          question: 'Is a van free on 1 March from 09:00 to 11:00? Book one for Ana.',
          read: `Read: ${toolTitle('slotlock_get_pool_availability')}`,
          answer: 'Three of the four vans in van-class are free then. I have proposed a booking for Ana.',
          card: {
            title: toolTitle('slotlock_book_pool'),
            state: 'Waiting for you',
            summary:
              'Book any one of pool van-class for 2027-03-01 09:00–11:00 UTC+00:00 (Europe/London): "Ana".',
            fields: [
              ['pool', 'van-class'],
              ['starts at', '2027-03-01T09:00:00Z'],
              ['ends at', '2027-03-01T11:00:00Z'],
              ['timezone', 'Europe/London'],
              ['title', 'Ana'],
            ],
            approve: 'Approve',
            dismiss: 'Dismiss',
          },
          composer: 'Find a free van tomorrow morning and book it for Ana',
          send: 'Send',
          recorded: 'Assistant for @ana',
        },
        aria: `The dashboard's Assistant page. A member asks: is a van free on 1 March from 09:00 to 11:00, book one for Ana. A line shows the assistant read the pool's availability, and it answers that three of the four vans in van-class are free then. Below, a proposed change titled ${toolTitle('slotlock_book_pool')}, waiting for the member: book any one of pool van-class for 1 March 2027, 09:00 to 11:00, Europe/London, titled Ana, with every argument listed and Approve and Dismiss buttons. Once approved, activity records it as Assistant for @ana.`,
        statements: [
          `Owners connect their organization’s own model in Settings: the ${facts.assistantProviders[0]}, or an ${facts.assistantProviders[1]} API (${listed(facts.assistantCompatible)}). Every member chats on the Assistant page.`,
          `Reads (free/busy, slots, pool availability, events) answer at once, up to ${facts.assistantMaxSteps} model calls a message.`,
          'Every write is a proposed change, shown in full on a card. It runs once, when the member approves it, under the same booking rules and limits as an agent, recorded as “Assistant for @login”.',
          'API keys, webhooks, booking rules, pool membership, coverage and erasure are never offered.',
          'The model’s API key is sealed with AES-256-GCM and never shown again, only its last four characters.',
          'A model URL on a loopback, private or metadata address is refused unless the operator sets `SLOTLOCK_ASSISTANT_PRIVATE_URLS=on`. The page works without JavaScript.',
        ],
      }
    : null,
};

export type CapabilityVisual = 'holds' | 'pools' | 'rules' | 'waitlist' | 'feed' | 'metrics';

/** What 0.4 adds beyond one hold and one booking, each linked to its operation's page. */
export const capabilities = {
  id: 'capabilities',
  counter: '06',
  heading: { soft: 'Beyond one booking.', strong: 'What a fleet or a clinic needs.' },
  items: [
    {
      visual: 'holds',
      title: 'Agent holds',
      body: `Up to ${facts.holdSlotsMax} candidate slots, held as one group while a person chooses; booking one releases the rest. Each agent may hold ${facts.holderHolds} at once and ${facts.holderHeldHoursText} hours in all.`,
      href: '/docs/api/hold-slots/',
    },
    {
      visual: 'pools',
      title: 'Pools',
      body: 'Book a vehicle class or room type and get the first free member, in one transaction, so a class sells out at its size. `slotlock_get_pool_availability` says how many are free, and when.',
      href: '/docs/api/get-pool-availability/',
    },
    {
      visual: 'rules',
      title: 'Booking rules',
      body: 'Notice, how far ahead, slot steps, turnaround and hours, judged by the database clock. `require_certain` refuses a booking in time no calendar sync has read within a day.',
      href: '/docs/api/set-resource-booking-rules/',
    },
    {
      visual: 'waitlist',
      title: 'Waitlists and check-in',
      body: 'Freed time goes to the waitlist in join order, as a hold for the next person. A booking nobody checks in to is released and offered on.',
      href: '/docs/api/join-waitlist/',
    },
    {
      visual: 'feed',
      title: 'Change feed and webhooks',
      body: `Every committed change as a CloudEvent, read by a cursor that never skips one, kept ${retention}. Webhooks send them in order, signed as Standard Webhooks.`,
      href: '/docs/api/list-changes/',
    },
    ...(facts.metrics
      ? [
          {
            visual: 'metrics',
            title: 'Prometheus metrics',
            body: 'With `SLOTLOCK_METRICS_TOKEN`, `/metrics` counts calls by protocol, operation and outcome, refusals, maintenance and deliveries. No label names a tenant.',
            href: '/docs/scaling/#observe-it',
          },
        ]
      : []),
  ] satisfies { visual: CapabilityVisual; title: string; body: string; href: string }[],
  more: [
    { title: 'Book together', body: 'Several resources, all or none.', href: '/docs/api/book-together/' },
    { title: 'Feed health', body: 'Each sync’s window, last read and error.', href: '/docs/api/get-coverage/' },
    { title: 'History', body: 'Who changed what, and what it was before.', href: '/docs/api/get-resource-history/' },
    { title: 'Calendar formats', body: 'Hours as VAVAILABILITY, events as JSCalendar.', href: '/docs/api/export-resource-availability/' },
  ],
  /** The drawings inside the cards: illustrative values in the shapes the API returns. */
  scenes: {
    holds: [
      { time: '10:00–12:00', state: 'held' },
      { time: '12:00–14:00', state: 'held' },
      { time: '14:00–16:00', state: 'taken' },
    ],
    holdsAria: 'Three candidate slots in one hold group: two held, one already taken.',
    pool: {
      name: 'van-class',
      members: 4,
      day: '2027-03-01',
      intervals: [
        { from: 9, to: 11, free: 3 },
        { from: 11, to: 14, free: 1 },
        { from: 14, to: 16, free: 0 },
        { from: 16, to: 18, free: 2 },
      ],
    },
    poolAria: 'A pool of four vans across a day: three free from 9 to 11, one from 11 to 14, none from 14 to 16, two from 16 to 18.',
    rules: [
      ['min_notice_minutes', '60'],
      ['slot_step_minutes', '30'],
      ['turnaround_minutes', '15'],
      ['check_in_minutes', '15'],
      ['require_certain', 'true'],
    ],
    rulesAria: 'Booking rules for one resource: an hour of notice, starts every 30 minutes, 15 minutes of turnaround, check-in within 15 minutes, and certain coverage required.',
    waitlist: [
      { n: '1', who: 'entry 1', state: 'offered, held' },
      { n: '2', who: 'entry 2', state: 'waiting' },
      { n: '3', who: 'entry 3', state: 'waiting' },
    ],
    waitlistAria: 'A waitlist of three: the first entry has been offered the freed time as a hold, the others wait.',
    feed: [
      'io.pylota.slotlock.hold.created',
      'io.pylota.slotlock.reservation.created',
      'io.pylota.slotlock.reservation.no_show',
      'io.pylota.slotlock.waitlist.offered',
    ],
    feedAria: 'Four change types in commit order: a hold created, a reservation created, a no-show, and a waitlist offer.',
    metrics: [
      ['slotlock_calls_total{protocol="mcp",operation="slotlock_hold_slots",outcome="ok"}', '412'],
      ['slotlock_calls_total{protocol="mcp",operation="slotlock_hold_slots",outcome="overlap"}', '9'],
      ['slotlock_webhook_deliveries_total{result="delivered"}', '1288'],
    ],
    metricsAria: 'Prometheus counters: hold calls by outcome, and webhook deliveries.',
  },
};

export const developers = {
  id: 'developers',
  counter: '07',
  heading: { soft: 'One registry, four ways in.', strong: 'MCP, A2A, REST or TypeScript.' },
  lede: `The ${facts.toolCount} tools and their JSON Schemas come from one registry, so a refusal reads the same on every transport.`,
  /** The REST tab's example: pool availability, in the shape openapi.json gives it. */
  restPool: 'van-class',
  rows: [
    {
      label: 'MCP',
      body: `${facts.toolCount} tools on MCP ${facts.mcpModern} and ${facts.mcpLegacy}, with the slot picker as an MCP App.`,
      href: '/docs/connect/',
    },
    {
      label: 'A2A',
      body: `The same operations as A2A ${facts.a2a} skills, with an agent card.`,
      href: '/docs/reference/#endpoints',
    },
    {
      label: 'REST',
      body: 'The tools and the application API, described at `/openapi.json`, refusals as RFC 9457 problem details.',
      href: '/docs/reference/#rest-and-openapi',
    },
    {
      label: 'Clients',
      body: `${clientList}: one method per operation, generated from the OpenAPI document.`,
      href: '/docs/clients/',
    },
    {
      label: 'TypeScript',
      body: 'The engine as a library on your PostgreSQL; the availability maths needs no database.',
      href: '/docs/library/',
    },
    {
      label: 'Live updates',
      body: `On MCP ${facts.mcpModern} each resource is an MCP resource, and a subscription hears when its free/busy changes, as the booking commits. On A2A the same feed streams to a watch task.`,
      href: '/docs/reference/#calendar-resources-and-live-updates',
    },
  ],
};

export const security = {
  id: 'security',
  counter: '08',
  heading: { soft: 'Agents propose.', strong: 'A person confirms, PostgreSQL decides.' },
  approval: {
    eyebrow: 'slotlock_create_event · input required',
    message:
      'Book vehicle-42 for 2027-03-29 10:00–11:00 (Europe/London): "Vehicle handover".',
    checkbox: 'Confirm this change',
    help: 'The agent changes the calendar only if this is ticked.',
    decline: 'Decline',
    accept: 'Accept',
    seal: `requestState sealed with HMAC-SHA256 · expires in ${facts.confirmTtlSeconds / 60} min`,
  },
  receipt: { label: 'Created', detail: 'revision 1 · replayed: false' },
  aria: `A confirmation form shown to a person before an agent's write runs. It reads: Book vehicle-42 for 29 March 2027, 10:00 to 11:00, Europe/London: Vehicle handover, with one tick box and Decline and Accept buttons. Below it, the receipt after acceptance: the event was created at revision 1.`,
  statements: [
    'Tenancy comes from your `authenticate` callback. No tool argument can choose a tenant.',
    'Forced row-level security returns nothing when the tenant setting is missing, and `slotlock serve` refuses to run as a superuser or a `BYPASSRLS` role.',
    `A pending confirmation is sealed to the caller, the tool, the exact arguments and an expiry (${facts.confirmTtlSeconds} seconds by default).`,
    'A client that cannot ask a person (MCP 2025 revisions, A2A) gets `confirmation_required`, and the write never runs.',
  ],
};

export const compare = {
  id: 'compare',
  counter: '09',
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
      'A stale external feed',
      'Missing data reads as free time.',
      'Time the feed has not covered is unproven; `requireCertain` refuses bookings there.',
    ],
    [
      'Retries',
      'A retry can book twice.',
      'A replay with the same idempotency key returns the first result.',
    ],
    [
      'A cancellation',
      'The slot sits empty until someone looks.',
      'The waitlist is offered it in order, as a hold.',
    ],
    [
      'Telling other systems',
      'A trigger or a poller, if anyone wrote one.',
      'Signed webhooks, in commit order, replayable.',
    ],
    [
      'Seeing what happened',
      'Whatever logging someone added.',
      'A dashboard of what each key changed, history per booking, and Prometheus metrics.',
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
  counter: '10',
  heading: { soft: 'Run it where your data is,', strong: `${facts.license}, on the PostgreSQL you run.` },
  deploy: [
    ...(facts.composeUp
      ? [
          {
            title: 'Docker Compose',
            body: 'The server and PostgreSQL 18 on 127.0.0.1, with MCP, A2A, REST and, with four settings, the dashboard.',
            command: facts.composeUp,
            link: { label: 'Quickstart', href: '/docs/quickstart/' },
          },
        ]
      : []),
    {
      title: 'Your Node.js app',
      body: `The engine as a library on PostgreSQL 16 to 18 with btree_gist; Node.js ${facts.nodeEngine.replace('>=', '')} or newer.`,
      command: `npm install slotlock@${facts.version} postgres`,
      link: { label: 'Library', href: '/docs/library/' },
    },
    ...(facts.dashboardWorker
      ? [
          {
            title: 'Dashboard on Cloudflare',
            body: 'The dashboard as a Worker at its own origin, through Hyperdrive to your PostgreSQL. Agents keep using the server.',
            command: 'cd workers/dashboard && npm ci',
            link: { label: 'Worker setup', href: `${REPO_URL}#dashboard-on-cloudflare-workers` },
          },
        ]
      : []),
    {
      title: 'Hosted',
      body: 'The hosted service is not open; self-hosting is the only supported path today.',
      command: null,
      link: { label: 'Hosted Slotlock', href: '/docs/hosted/' },
    },
  ],
  repo: {
    name: 'PILOTAAI/slotlock',
    caption: 'Repository on GitHub',
    includes: ['Engine', 'Schema and RLS', 'MCP, A2A and REST server', 'Dashboard', `${facts.clientCount} clients`],
    run: facts.composeUp ?? 'npm ci && npm run build',
    cta: 'View on GitHub',
  },
  statements: [
    'GOVERNANCE.md commits the engine, the spec and the server to Apache-2.0 or another OSI-approved licence.',
    'Contributions are signed off under the Developer Certificate of Origin. There is no CLA.',
    facts.composeUp
      ? 'Under Compose, agents’ writes wait for a person by default (`SLOTLOCK_CONFIRM_WRITES=all`).'
      : 'Needs Node.js 22.12 or newer and PostgreSQL 16 or newer with btree_gist.',
  ],
};

export const faq = {
  id: 'faq',
  heading: { soft: 'Questions', strong: 'we expect first.' },
  items: [
    {
      q: 'Does it sync with Google Calendar or Outlook?',
      a: 'Not by itself. Provider adapters live in your application; Slotlock normalises their changes, reads and writes iCalendar, exports JSCalendar, and records how much of each feed has been read.',
    },
    {
      q: 'Is it ready for production?',
      a: knownIssues
        ? `Not ${facts.version}: it can accept a double booking around a daylight-saving change. Read the [known issues](/docs/known-issues/), and use 0.3.0 once it is published; the README keeps the production checklist.`
        : `${facts.version} is a 0.x release, so a minor release may change the API, as [versioning](/docs/versioning/) explains; the README keeps the production checklist.`,
    },
    ...(facts.dashboardOrgs
      ? [
          {
            q: 'Can a team share one calendar?',
            a: 'Yes. With `SLOTLOCK_DASHBOARD_ORGS`, a GitHub organization is one tenant: its members share the keys, resources and hours, and the key list says who made each key.',
          },
        ]
      : []),
    ...(facts.assistant
      ? [
          {
            q: 'Can people operate it by chat?',
            a: `Yes, on the dashboard’s Assistant page, with a model the organization connects (${facts.assistantProviders[0]} or ${facts.assistantProviders[1]}). It reads at once; every change waits on a card until a member approves it. The model’s key is never shown, and conversations are kept ${facts.assistantConversationHours} hours.`,
          },
        ]
      : []),
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
  { label: 'Dashboard', href: '#dashboard' },
  { label: 'Capabilities', href: '#capabilities' },
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
        { label: 'Dashboard', href: '/docs/dashboard/' },
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
      title: 'Hosted',
      links: [
        { label: 'Hosted Slotlock', href: '/docs/hosted/' },
        { label: 'Status', href: '/docs/status/' },
        { label: 'Privacy notice', href: '/docs/privacy/' },
        { label: 'Terms of Service', href: '/docs/terms/' },
        { label: 'Acceptable use', href: '/docs/acceptable-use/' },
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
