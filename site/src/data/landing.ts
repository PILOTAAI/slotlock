// Every sentence on the landing page lives here, so the HTML page (src/pages/index.astro) and its
// Markdown twin (src/pages/index.md.ts) cannot say different things. Numbers and names that come
// from the package are read from src/generated/facts.json, which scripts/sync-content.mjs builds
// from the repository's source on every build.
//
// The page sells Slotlock Cloud first. Running it yourself has three places: the Self-host plan in
// Pricing, the Source band, and the footer. Everything else about it lives in the docs.
import facts from '../generated/facts.json';

export const REPO_URL = 'https://github.com/PILOTAAI/slotlock';
export const RACE_TEST_URL = `${REPO_URL}/blob/main/src/__tests__/core.integration.test.ts`;
export const PYLOTA_URL = 'https://pylota.io';

/** Slotlock Cloud: the hosted server and its dashboard (docs/hosted/README.md). */
export const CLOUD_API_URL = 'https://slotlock-api.pylota.io';
export const SIGN_IN_URL = 'https://app.slotlock.pylota.io/dashboard';
/** Where to ask about paid plans: the support address docs/hosted/README.md publishes. */
const SUPPORT_EMAIL = 'support@pylota.io';

/** The sign-in links: "Sign in" in the header, "Start free" on every button in the page. */
export const signIn = {
  label: 'Sign in',
  start: 'Start free',
  href: SIGN_IN_URL,
  /** Shown once, under the Free plan; the dashboard's sign-in page shows the terms as well. */
  terms:
    'By signing in you agree to the [Terms](/docs/terms/) and the [Acceptable Use Policy](/docs/acceptable-use/). The [Privacy notice](/docs/privacy/) says what is kept.',
};

export { facts };

/** 0.2 can accept double bookings around daylight-saving changes (/docs/known-issues/). */
const knownIssues = facts.version.startsWith('0.2.');

/** `Python, Go, Rust, Java and .NET`, from the client directories in the repository. */
const clientList = `${facts.clients.slice(0, -1).join(', ')} and ${facts.clients.at(-1)}`;

export interface Heading {
  /** The section's topic in plain words, set small above the line: what a searcher types. */
  topic?: string;
  soft: string;
  strong: string;
}

/** The search result: at most 60 characters of title and 155 of description (RFC 0005). */
export const meta = {
  title: 'Slotlock: the booking API and calendar for AI agents',
  description:
    'Give AI agents a calendar for every van, room and machine. Find, hold and book slots over MCP, A2A or REST, and PostgreSQL refuses double bookings.',
  imageAlt: 'Slotlock: the booking API and calendar for AI agents. Two agents, one slot, one booking.',
};

/** The header of every page outside the docs: one page per thing people search for. */
export const nav = [
  { label: 'Use cases', href: '/use-cases/' },
  { label: 'MCP server', href: '/mcp-server/' },
  { label: 'API', href: '/booking-api/' },
  { label: 'Pricing', href: '/pricing/' },
  { label: 'Blog', href: '/blog/' },
  { label: 'Docs', href: '/docs/' },
];

export const hero = {
  heading: {
    topic: 'Booking API and calendar for AI agents',
    soft: 'Let AI agents book vans, rooms and machines.',
    strong: 'Two agents, one slot, one booking.',
  } satisfies Heading,
  lede: 'Every resource gets its own calendar. Agents find a free time, hold it while a person picks, and book it. When two want the same slot, one wins and the other gets the next one.',
  docs: { label: 'Read the docs', href: '/docs/' },
  note: (facts as { plans?: unknown }).plans ? 'Free plan, no card needed.' : 'Free while in preview.',
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
  zone: string;
  blocks: Block[];
  requestLane?: boolean;
}

export const heroRows: Row[] = [
  {
    name: 'Van AB12 CDE',
    zone: 'Europe/London',
    requestLane: true,
    blocks: [
      { start: 8, end: 9.5, kind: 'confirmed', label: 'BK-1838', short: '1838' },
      { start: 10, end: 12, kind: 'hold', label: 'A · hold', short: 'A · hold', step: 'a-hold' },
      { start: 10, end: 12, kind: 'confirmed', label: 'A · booked', short: 'A', step: 'a-confirm' },
      { start: 11, end: 13, kind: 'refused', label: 'B · refused', short: 'B ✕', step: 'b-refused' },
      { start: 12, end: 14, kind: 'hold', label: 'B · hold', short: 'B · hold', step: 'b-hold' },
      { start: 17, end: 18, kind: 'closed', label: '', short: '' },
    ],
  },
  {
    name: 'Room 3',
    zone: 'Europe/London',
    blocks: [
      { start: 9, end: 10, kind: 'confirmed', label: 'Sync', short: '' },
      { start: 13, end: 14.5, kind: 'confirmed', label: 'Interview', short: '' },
      { start: 17, end: 18, kind: 'closed', label: '', short: '' },
    ],
  },
  {
    name: 'Dr Shah',
    zone: 'Europe/London',
    blocks: [
      { start: 9, end: 10.5, kind: 'busy', label: 'busy · .ics', short: '.ics' },
      { start: 14, end: 18, kind: 'unproven', label: 'unproven', short: 'unproven' },
    ],
  },
  {
    name: 'Mill 2',
    zone: 'Europe/Berlin',
    blocks: [
      { start: 8, end: 11, kind: 'confirmed', label: 'Job 4471', short: '4471' },
      { start: 16, end: 18, kind: 'closed', label: '', short: '' },
    ],
  },
];

export interface LogLine {
  agent: 'A' | 'B';
  /** What the agent asked for, in words. */
  ask: string;
  /** The tool it called. */
  call: string;
  result: string;
  tone: 'ok' | 'hold' | 'refused';
  step: number;
}

/** The calls, in order, as two agents make them over MCP, in the words a person would use. */
export const heroLog: LogLine[] = [
  { agent: 'A', ask: 'Find two hours for the van', call: 'slotlock_find_next_available', result: '10:00–12:00, certain', tone: 'ok', step: 1 },
  { agent: 'A', ask: 'Hold it while Ana picks', call: 'slotlock_hold_slots', result: 'held to 09:51', tone: 'hold', step: 2 },
  { agent: 'B', ask: 'Hold 11:00–13:00', call: 'slotlock_hold_slots', result: 'refused: overlap', tone: 'refused', step: 3 },
  { agent: 'B', ask: 'Find the next two hours', call: 'slotlock_find_next_available', result: '12:00–14:00, held', tone: 'hold', step: 5 },
  { agent: 'A', ask: 'Book the hold', call: 'slotlock_create_event', result: 'booked', tone: 'ok', step: 6 },
];

export const heroWindow = {
  title: 'Slotlock · Today',
  now: 'now 09:41',
  nav: ['Overview', 'Resources', 'Waitlist', 'API keys'],
  agents: 'Agent activity',
};

export const heroAria =
  'The Slotlock dashboard at 09:41. A calendar shows four resources from 08:00 to 18:00, each in its own time zone: a van, a meeting room, a clinician and a machine. Beside it, the agents’ activity. Agent A finds the van free from 10:00 to 12:00 and holds it while Ana picks. Agent B asks to hold 11:00 to 13:00 on the same van and is refused with the code overlap, shown as a red outline. Agent B finds the next two free hours, 12:00 to 14:00, and holds them. Agent A books its hold. The clinician has busy time imported from an iCalendar feed, and the time after 14:00 is unproven because the feed has only been read up to then.';

/** Under the hero: what every calendar does, then who runs on it. */
export const strip = {
  items: [
    { icon: 'calendar', text: 'A calendar for every resource' },
    { icon: 'timer', text: 'Holds that expire on their own' },
    { icon: 'refuse', text: 'Refusals your agent can act on' },
    { icon: 'pick', text: 'A person picks the slot in the chat' },
  ] as const,
  proof: {
    name: 'Pylota',
    text: 'the AI fleet manager for independent car rental operators, checks every booking with Slotlock.',
    href: PYLOTA_URL,
  },
};

/** The van's WeeklyAvailabilityRule; the week strip in the first step is drawn from these numbers. */
const weekly = {
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  startMinutes: 480,
  durationMinutes: 540,
};

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
  const { rrule, startMinutes, durationMinutes } = weekly;
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

/** Three steps, each beside the picture of what it does. */
export const story = {
  id: 'product',
  heading: {
    topic: 'How it works',
    soft: 'Vans, rooms and clinics already run on calendars.',
    strong: 'Now your agents can book them.',
  } satisfies Heading,
  resource: {
    name: 'Van AB12 CDE',
    zone: 'Europe/London',
    rule: weekly.rrule,
  },
  items: [
    {
      n: '01',
      title: 'Describe each resource',
      body: 'Give it a time zone and weekly hours. Its rules follow its own clock, daylight saving included.',
      link: { label: 'Resources and rules', href: '/docs/concepts/#resources' },
    },
    {
      n: '02',
      title: 'Find a time and hold it',
      body: `Agents find certain free slots and hold up to ${facts.holdSlotsMax} while a person picks one in the chat.`,
      link: { label: 'MCP Apps', href: '/docs/connect/#mcp-apps' },
    },
    {
      n: '03',
      title: 'Book it, or let it lapse',
      body: 'Booking the hold makes the event and frees the rest. A hold nobody books expires on its own.',
      link: { label: 'Holds', href: '/docs/concepts/#holds' },
    },
  ],
  picker: {
    title: 'Pick a time',
    days: ['Mon 29', 'Tue 30', 'Wed 31'],
    times: ['09:00', '10:30', '12:00', '14:00', '15:30'],
    picked: '12:00',
    held: 'Held until 09:51',
    button: 'Book this time',
  },
  lapse: { booked: 'booked', lapsed: 'no booking by 09:51: freed' },
  aria: [
    'The van AB12 CDE in Europe/London, open Monday to Friday from 08:00 to 17:00 and closed by rule at the weekend.',
    'A calendar view inside a chat: three days to choose from and five free times. 12:00 is picked and held until 09:51, with a Book this time button.',
    'Two outcomes of a hold: booked, it becomes a solid green booking; not booked by 09:51, it is freed for the next agent.',
  ],
};

export const proof = {
  id: 'proof',
  heading: {
    topic: 'Double-booking prevention',
    soft: 'Two agents ask for the same van.',
    strong: 'One gets it. The other gets the next free time.',
  } satisfies Heading,
  lede: 'A PostgreSQL exclusion constraint checks every write: a race has one winner, and the other agent gets an answer it can act on.',
  /** The race in agent terms; the integration suite runs it as two concurrent inserts. */
  race: [
    { who: 'agent-a', what: 'hold [10:00, 12:00)', result: 'held', tone: 'g' },
    { who: 'agent-b', what: 'hold [11:00, 13:00)', result: "refused: 'overlap'", tone: 'r' },
    { who: 'agent-b', what: 'next free 2 h', result: '[12:00, 14:00) certain', tone: 'g' },
  ],
  links: [
    { label: 'Read the race test', href: RACE_TEST_URL },
    { label: 'The constraint', href: '/docs/concepts/#the-exclusion-constraint' },
  ],
  compare: {
    caption: 'Slotlock compared with a bookings table and a cron job',
    columns: ['', 'A table and a cron job', 'Slotlock'],
    rows: [
      ['Two writers, one slot', 'A read-then-insert check can pass for both.', 'The constraint admits one; the other gets `overlap`.'],
      ['Abandoned holds', 'A scheduled job deletes them later.', 'They expire on the database clock.'],
      ['A stale calendar feed', 'Missing data reads as free time.', 'Unread time is unproven, and can refuse bookings.'],
    ],
  },
};

/** The dashboard (src/dashboard.ts), drawn with the labels its Overview shows. */
export const dashboard = {
  id: 'dashboard',
  heading: { topic: 'Dashboard', soft: 'See what every agent booked.', strong: 'Step in when it matters.' } satisfies Heading,
  lede: 'Add resources, create keys, and see every change each key made.',
  view: {
    path: 'app.slotlock.pylota.io/dashboard',
    brand: 'Slotlock',
    workspace: 'acme-rentals',
    nav: ['Overview', 'Resources', 'Waitlist', 'API keys', ...(facts.assistant ? ['Assistant'] : []), 'Settings'],
    title: 'Overview',
    stats: [
      { label: `Booked, next ${facts.dashboardAgendaDays} days`, value: '18' },
      { label: 'Live holds', value: '3' },
      { label: 'Resources', value: '12' },
    ],
    upcoming: [
      { time: 'Today 10:00', what: 'Van AB12 CDE', kind: 'Booking' },
      { time: 'Today 12:00', what: 'Van AB12 CDE', kind: 'Hold' },
    ],
    activity: [
      { text: 'Hold booked', on: 'Van AB12 CDE', who: 'booking-agent', when: '2 min ago', tone: 'good' },
      { text: 'Waitlist offer sent', on: 'Van CD34 EFG', who: 'Slotlock', when: '18 min ago', tone: 'good' },
    ],
  },
  aria: `The dashboard's Overview. Three counts: 18 booked in the next ${facts.dashboardAgendaDays} days, 3 live holds, 12 resources. Upcoming lists today's van booking and a hold on the same van. Agent activity lists a hold booked by the key booking-agent and a waitlist offer.`,
  points: [
    { title: 'Every resource', body: 'Hours, rules, pool and bookings on one page.' },
    { title: 'Waitlists', body: 'Freed time goes to the next in line, as a hold.' },
    ...(facts.assistant
      ? [{ title: 'An assistant', body: 'Ask in plain words; every change waits for your approval.' }]
      : []),
  ],
  link: { label: 'Dashboard', href: '/docs/dashboard/' },
};

/** Who books with Slotlock. Car rental first: Pylota checks every booking with it. */
export const industries = {
  id: 'industries',
  heading: {
    topic: 'Industries',
    soft: 'Anything booked by the hour or the day.',
    strong: 'Built first for car rental.',
  } satisfies Heading,
  items: [
    { title: 'Car and van rental', body: 'Each vehicle is a calendar; a second booking is refused.', featured: true },
    { title: 'Equipment hire', body: 'Diggers to drills, with inspection time kept between hires.' },
    { title: 'Clinics', body: 'Room, clinician and equipment booked together, or not at all.' },
    { title: 'Courts', body: 'Padel and tennis on fixed starts, with no-shows offered on.' },
    { title: 'Garage service bays', body: 'Bay, technician and courtesy car in one booking.' },
    { title: 'Salons and spas', body: 'Rooms and therapists, with cleaning time built in.' },
    { title: 'Rooms and desks', body: 'Rooms nobody checks in to go back on offer.' },
    { title: 'Field service', body: 'Technician and van, held while the customer chooses.' },
  ],
  link: { label: 'Use cases', href: '/use-cases/' },
};

export interface InstallTarget {
  id: string;
  label: string;
  command: string;
  /** False for a line that goes in a build file, not a terminal. */
  shell?: false;
  note: string;
}

/** The README's `claude mcp add` line, pointed at Slotlock Cloud with an API key. */
function cloudMcpAdd(): string {
  const local = 'http://localhost:8080/mcp';
  const token = '$SLOTLOCK_AUTH_TOKEN';
  if (!facts.claudeMcpAdd.includes(local) || !facts.claudeMcpAdd.includes(token)) {
    throw new Error('landing: the README claude mcp add line changed; update cloudMcpAdd');
  }
  return facts.claudeMcpAdd.replace(local, `${CLOUD_API_URL}/mcp`).replace(token, '$SLOTLOCK_API_KEY');
}

export const developers = {
  id: 'developers',
  heading: { topic: 'MCP, A2A and REST API', soft: 'However your agent is built,', strong: 'it can book.' } satisfies Heading,
  lede: `${facts.toolCount} tools with JSON Schemas, the same on every transport.`,
  /** The REST tab's example: pool availability, in the shape openapi.json gives it. */
  restPool: 'van-class',
  pool: {
    members: 4,
    day: '2027-03-01',
    intervals: [
      { from: 9, to: 11, free: 3 },
      { from: 11, to: 14, free: 1 },
      { from: 14, to: 16, free: 0 },
    ],
  },
  cloudMcpAdd: cloudMcpAdd(),
  rows: [
    { label: 'MCP', body: `MCP ${facts.mcpModern} and ${facts.mcpLegacy}, with an MCP App.`, href: '/mcp-server/' },
    { label: 'A2A', body: `A2A ${facts.a2a} skills and an agent card.`, href: '/docs/reference/#endpoints' },
    { label: 'REST', body: '`/openapi.json`, with RFC 9457 refusals.', href: '/booking-api/' },
    { label: 'Clients', body: `${clientList}.`, href: '/docs/clients/' },
    { label: 'TypeScript', body: 'The engine, on your own PostgreSQL.', href: '/docs/library/' },
  ],
  install: [
    // Offered only while the README documents the Docker quickstart (facts.composeUp).
    ...(facts.composeUp
      ? [
          {
            id: 'docker',
            label: 'Docker',
            command: facts.composeUp,
            note: '[Quickstart](/docs/quickstart/)',
          },
        ]
      : []),
    {
      id: 'npm',
      label: 'npm',
      command: `npm install slotlock@${facts.version} postgres`,
      note: `[Self-hosting](/docs/self-host/)${knownIssues ? ' Read the [known issues](/docs/known-issues/) first.' : ''}`,
    },
    // Clients for a running server; versions match the release (clients/README.md).
    {
      id: 'python',
      label: 'Python',
      command: `pip install slotlock==${facts.version}`,
      note: 'Python 3.10+ · [Guide](/docs/clients/#python)',
    },
    {
      id: 'go',
      label: 'Go',
      command: `go get github.com/PILOTAAI/slotlock/clients/go@v${facts.version}`,
      note: 'Go 1.22+ · [Guide](/docs/clients/#go)',
    },
    {
      id: 'rust',
      label: 'Rust',
      command: `cargo add slotlock@${facts.version}`,
      note: 'Rust 1.85+ · [Guide](/docs/clients/#rust)',
    },
    {
      id: 'java',
      label: 'Java',
      command: `implementation("io.pylota:slotlock:${facts.version}")`,
      shell: false,
      note: 'Java 17+ · [Guide](/docs/clients/#java)',
    },
    {
      id: 'dotnet',
      label: '.NET',
      command: `dotnet add package Slotlock.Client -v ${facts.version}`,
      note: '.NET 8 or 10 · [Guide](/docs/clients/#net)',
    },
  ] satisfies InstallTarget[],
  /** Slotlock Cloud's endpoints (docs/hosted/README.md publishes the same list). */
  endpoints: {
    caption: 'Slotlock Cloud',
    items: [
      { id: 'mcp', label: 'MCP', value: `${CLOUD_API_URL}/mcp` },
      { id: 'a2a', label: 'A2A', value: `${CLOUD_API_URL}/a2a` },
      { id: 'rest', label: 'REST', value: `${CLOUD_API_URL}/v1` },
      { id: 'openapi', label: 'OpenAPI', value: `${CLOUD_API_URL}/openapi.json` },
      { id: 'card', label: 'Agent card', value: `${CLOUD_API_URL}/.well-known/agent-card.json` },
    ],
    commandCaption: 'Claude Code',
  },
  capabilities: [
    { title: 'Holds', body: `Up to ${facts.holdSlotsMax} slots held as one group.`, href: '/docs/api/hold-slots/' },
    { title: 'Pools', body: 'Any one of a class.', href: '/docs/api/get-pool-availability/' },
    { title: 'Booking rules', body: 'Notice, steps, turnaround and hours.', href: '/docs/booking-rules/' },
    { title: 'Waitlists', body: 'Freed time offered in order.', href: '/docs/api/join-waitlist/' },
    { title: 'Change feed', body: 'CloudEvents and signed webhooks.', href: '/docs/api/list-changes/' },
    { title: 'Book together', body: 'Several resources, all or none.', href: '/docs/api/book-together/' },
  ],
};

export const security = {
  id: 'security',
  heading: {
    topic: 'Security',
    soft: 'Agents reach only what their key allows.',
    strong: 'Tenants never see each other.',
  } satisfies Heading,
  /** An API key as the dashboard's key list shows it. */
  key: {
    name: 'booking-agent',
    state: 'Active',
    fields: [
      ['Key', 'slk_7Hq2…'],
      ['Access', 'Read and write'],
      ['Expires', 'in 90 days'],
    ],
    revoke: 'Revoke',
  },
  aria: 'An API key in the dashboard: booking-agent, active, read and write access, expiring in 90 days, with a Revoke button.',
  statements: [
    'The tenant comes from the API key, never from a tool argument.',
    'Row-level security returns nothing without a tenant, and the server refuses roles that bypass it.',
    'Keys are read only, read and write, or full, and can expire or be revoked.',
    'On your own server, each write can wait for a person to confirm it.',
  ],
  link: { label: 'Security model', href: '/docs/security/' },
};

export interface Plan {
  id: string;
  name: string;
  host: string;
  price: string;
  per: string;
  tagline: string;
  features: string[];
  cta: { label: string; href: string };
  more?: { label: string; href: string };
  featured?: boolean;
  terms?: boolean;
}

/** A hosted plan as src/plans.ts and the hosted service page's Plans table define it (sync-content). */
interface HostedPlan {
  id: string;
  monthly: number;
  yearly: number;
  /** ISO 4217, such as GBP. */
  currency: string;
  /** Its sign, such as £. */
  symbol: string;
  resources: number;
  apiKeys: number;
  webhookEndpoints: number;
  operations?: number;
  bookings?: number;
}

/** Null on a release without hosted plans: the page then offers only what Slotlock Cloud is today. */
const hostedPlans = (facts as { plans?: HostedPlan[] | null }).plans ?? null;
const hostedPlan = (id: string) => hostedPlans?.find((plan) => plan.id === id);
const count = (value: number) => value.toLocaleString('en-GB');
const allows = (plan: HostedPlan) => [
  `${count(plan.resources)} resources, ${count(plan.apiKeys)} API keys`,
  ...(plan.bookings !== undefined ? [`${count(plan.bookings)} bookings a month`] : []),
  ...(plan.operations !== undefined ? [`${count(plan.operations)} operations a month`] : []),
  `${count(plan.webhookEndpoints)} webhooks`,
];
const freePlan = hostedPlan('free');
const developerPlan = hostedPlan('developer');
const teamPlan = hostedPlan('team');
const upgrade = { label: 'Upgrade', href: `${SIGN_IN_URL}/plan` };
const paid = (plan: HostedPlan) => ({ price: `${plan.symbol}${plan.monthly}`, per: `a month, or ${plan.symbol}${plan.yearly} a year` });
/** The plans' currency sign, for Free and self-hosting at no charge. */
const money = (developerPlan ?? freePlan)?.symbol ?? '$';

export const pricing = {
  id: 'pricing',
  eyebrow: 'Slotlock Cloud',
  heading: {
    topic: 'Pricing',
    soft: 'Start free on Slotlock Cloud.',
    strong: developerPlan ? 'Upgrade as you grow, or run it yourself.' : 'Or run it on your own PostgreSQL.',
  } satisfies Heading,
  lede: freePlan
    ? 'Every account starts on Free; upgrade from the dashboard.'
    : 'Slotlock Cloud is free while it is in preview.',
  plans: [
    freePlan
      ? {
          id: 'free',
          name: 'Free',
          host: 'We host',
          price: `${money}0`,
          per: '',
          tagline: 'Connect an agent today.',
          features: allows(freePlan),
          cta: { label: signIn.start, href: SIGN_IN_URL },
          featured: !developerPlan,
          terms: true,
        }
      : {
          id: 'free',
          name: 'Free',
          host: 'We host',
          price: `${money}0`,
          per: 'while in preview',
          tagline: 'Connect an agent today.',
          features: [
            `${facts.dashboardMaxResources} resources in the dashboard`,
            `${count(facts.eventQuota)} events per key`,
            'MCP, A2A and REST',
            'Best effort, no SLA',
          ],
          cta: { label: signIn.start, href: SIGN_IN_URL },
          featured: true,
          terms: true,
        },
    ...(developerPlan
      ? [
          {
            id: 'developer',
            name: 'Developer',
            host: 'We host',
            ...paid(developerPlan),
            tagline: 'For agents booking in production.',
            features: allows(developerPlan),
            cta: upgrade,
            featured: true,
          },
        ]
      : []),
    ...(teamPlan
      ? [
          {
            id: 'team',
            name: 'Team',
            host: 'We host',
            ...paid(teamPlan),
            tagline: 'One price for the whole team.',
            features: allows(teamPlan),
            cta: upgrade,
          },
        ]
      : []),
    {
      id: 'self',
      name: 'Self-host',
      host: 'You host',
      price: `${money}0`,
      per: facts.license,
      tagline: 'Your servers, your data.',
      features: [`Same server, ${facts.toolCount} tools`, 'PostgreSQL 16 to 18', 'No limits from us'],
      cta: { label: 'Self-hosting guide', href: '/docs/self-host/' },
      more: { label: 'GitHub', href: REPO_URL },
    },
  ] satisfies Plan[],
  note: 'Your own servers, support and a contract?',
  /** The Custom column's link on the hosted service page, else the support address. */
  contact: (facts as { planContact?: { label: string; href: string } | null }).planContact ?? {
    label: `Write to ${SUPPORT_EMAIL}`,
    href: `mailto:${SUPPORT_EMAIL}`,
  },
  link: { label: 'Plans in detail', href: '/pricing/' },
};

export const source = {
  id: 'source',
  heading: {
    topic: 'Open source',
    soft: 'Read how every booking is stored and checked.',
    strong: 'The source is on GitHub.',
  } satisfies Heading,
  repo: {
    name: 'PILOTAAI/slotlock',
    caption: 'Repository on GitHub',
    includes: ['Engine', 'Schema and RLS', 'Server', 'Dashboard', `${facts.clientCount} clients`],
    cta: 'View on GitHub',
  },
  statements: [
    `${facts.license}, and GOVERNANCE.md keeps it under an OSI-approved licence.`,
    'Read the race test, the schema and the security policies before you trust them.',
    'Issues and pull requests are welcome.',
  ],
};

/** What a plan costs, in words, from facts.plans; "free while in preview" before plans exist. */
const priceAnswer =
  developerPlan && teamPlan
    ? `Slotlock Cloud starts free, with no card. Developer is ${developerPlan.symbol}${developerPlan.monthly} a month and Team ${teamPlan.symbol}${teamPlan.monthly} a month for the whole organization; running it yourself costs nothing ([pricing](/pricing/)).`
    : 'Slotlock Cloud is free while it is in preview, and running it yourself costs nothing ([pricing](/pricing/)).';

/**
 * The questions people ask before they try it, most asked first. Each answer stands alone (search
 * engines and AI answers quote them one at a time) and links the page that says more. The landing
 * page also gives them as FAQPage data (src/pages/index.astro).
 */
export const faq = {
  id: 'faq',
  heading: { topic: 'FAQ', soft: 'Questions', strong: 'we expect first.' } satisfies Heading,
  items: [
    {
      q: 'What is Slotlock?',
      a: 'A booking API and calendar for AI agents. Each van, room, court or person is a calendar of its own: agents find free time, hold it while a person picks, and book it over MCP, A2A or REST, and PostgreSQL refuses any booking that overlaps another.',
    },
    {
      q: 'How does it stop double bookings?',
      a: 'A PostgreSQL exclusion constraint checks every booking, hold and event as it is written. When two agents race for one slot, one write wins and the other is refused with `overlap`, as data the agent can act on ([how it works](/blog/postgresql-exclusion-constraint-double-booking/)).',
    },
    {
      q: 'Which agents can use it?',
      a: `Any MCP client, such as Claude Code, Cursor or VS Code; any A2A ${facts.a2a} agent; and any code that calls REST. There are clients for ${clientList} ([connect an agent](/docs/connect/)).`,
    },
    {
      q: 'What can I book with it?',
      a: 'Things and staff hours that take one booking at a time: vehicles, rooms, courts, machines, a technician’s afternoon. For a meeting between two people, a scheduling link does that already ([use cases](/use-cases/)).',
    },
    {
      q: 'Can a person approve what an agent books?',
      a: `Yes. An agent holds up to ${facts.holdSlotsMax} options while a person picks one in the chat, and a hold nobody books lapses on its own. On your own server, each write can also wait for a person to confirm it.`,
    },
    {
      q: 'Does it replace my booking system?',
      a: 'No, it sits behind it. Your site, your phone agents and your AI agents all write through Slotlock, so each slot is sold once whichever channel sells it. [Pylota](/blog/pylota-car-rental-case-study/) runs it as a library inside its own database.',
    },
    {
      q: 'Does it sync with Google Calendar or Outlook?',
      a: 'Not by itself. Your adapter brings each feed in as iCalendar busy time, and Slotlock records how far it has read each one, so time no feed has proven is never offered as free ([external calendars](/docs/external-calendars/)).',
    },
    {
      q: 'How is it different from Calendly or Cal.com?',
      a: 'Those schedule meetings between people. Slotlock books resources for agents, holds options that lapse on their own, and refuses overlaps in the database ([comparisons](/compare/)).',
    },
    {
      q: 'How much does it cost?',
      a: priceAnswer,
    },
    {
      q: 'Can I run it myself?',
      a: `Yes. It is ${facts.license}: run the Docker image or the npm package on your own PostgreSQL 16 to 18, with the same tools as Slotlock Cloud ([self-hosting](/docs/self-host/)).`,
    },
    {
      q: 'Is it ready for production?',
      a: knownIssues
        ? `Not ${facts.version}: it can accept a double booking around a daylight-saving change. Read the [known issues](/docs/known-issues/) first.`
        : `Pylota checks every car rental booking with it. ${facts.version} is a 0.x release, so a minor release may change the API, and Slotlock Cloud gives 90 days’ notice before anything under \`/v1\` changes ([versioning](/docs/versioning/)).`,
    },
    {
      q: 'Where is my data?',
      a: 'On Slotlock Cloud, in the United Kingdom, as the [privacy notice](/docs/privacy/) says. Self-hosted, on your own PostgreSQL.',
    },
  ],
};

export const closing = {
  heading: {
    soft: 'Stop checking for conflicts in application code.',
    strong: 'Let Slotlock refuse them.',
  } satisfies Heading,
};

export const footer = {
  tagline: 'The calendar AI agents cannot double-book.',
  columns: [
    {
      title: 'Product',
      links: [
        { label: 'Booking MCP server', href: '/mcp-server/' },
        { label: 'Booking API', href: '/booking-api/' },
        { label: 'Use cases', href: '/use-cases/' },
        { label: 'Compare', href: '/compare/' },
        { label: 'Open source', href: '/open-source/' },
        { label: 'Blog', href: '/blog/' },
      ],
    },
    {
      title: 'Developers',
      links: [
        { label: 'Quickstart', href: '/docs/quickstart/' },
        { label: 'Tools reference', href: '/docs/tools/' },
        { label: 'REST reference', href: '/docs/api/' },
        { label: 'Self-hosting', href: '/docs/self-host/' },
        { label: 'Changelog', href: '/docs/changelog/' },
      ],
    },
    {
      title: 'Slotlock Cloud',
      links: [
        { label: 'Pricing', href: '/pricing/' },
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
        { label: 'About', href: '/about/' },
        { label: 'GitHub', href: REPO_URL },
        { label: 'Licence', href: `${REPO_URL}/blob/main/LICENSE` },
        { label: 'Security policy', href: `${REPO_URL}/blob/main/SECURITY.md` },
      ],
    },
  ],
  version: { label: `Version ${facts.version}`, href: '/docs/changelog/' },
  legal: `${facts.license} · A Pylota project · © 2026 TREFT LTD`,
};
