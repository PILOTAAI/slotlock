// /mcp-server/: the booking MCP server, for people searching for a calendar or booking MCP server.
// Tool names, counts and protocol versions come from src/agent-server.ts through facts.json.
import facts from '../../generated/facts.json';
import type { MarketingPage } from '../../lib/page';
import { softwareApplication } from '../../lib/seo';
import { CLOUD_API_URL, developers, SIGN_IN_URL } from '../landing';

const description = `A booking and calendar MCP server for AI agents: ${facts.toolCount} tools to find free time, hold slots while a person picks, and book with no double bookings.`;

const cursorConfig = JSON.stringify(
  {
    mcpServers: {
      slotlock: {
        url: `${CLOUD_API_URL}/mcp`,
        headers: { Authorization: 'Bearer ${env:SLOTLOCK_API_KEY}' },
      },
    },
  },
  null,
  2,
);

const access = (tool: { readOnly?: boolean; destructive?: boolean }) =>
  tool.readOnly ? 'Read' : tool.destructive ? 'Write, destructive' : 'Write';

export const mcpServerPage: MarketingPage = {
  path: '/mcp-server/',
  title: 'Booking and calendar MCP server for AI agents | Slotlock',
  description,
  image: 'mcp-server',
  imageAlt: 'Slotlock: a booking and calendar MCP server for AI agents.',
  crumbs: [{ name: 'MCP server', path: '/mcp-server/' }],
  hero: {
    topic: 'Booking MCP server',
    heading: { soft: 'A calendar MCP server for agents that book.', strong: 'Two agents, one slot, one booking.' },
    lede: `Give Claude, Cursor or any MCP client ${facts.toolCount} booking tools. Agents read free/busy, find the next free time, hold slots while a person picks in the chat, and book. PostgreSQL refuses any overlap, and the agent gets the conflict as data it can act on.`,
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Tools reference', href: '/docs/tools/' },
    ],
  },
  sections: [
    {
      id: 'connect',
      topic: 'Connect',
      heading: { soft: 'One line in Claude Code.', strong: 'One block in Cursor.' },
      lede: 'Sign in with GitHub or Google, create an API key in the dashboard, and point your client at Slotlock Cloud. A self-hosted server works the same way at its own address.',
      blocks: [
        { kind: 'code', caption: 'Claude Code', code: developers.cloudMcpAdd },
        { kind: 'code', caption: 'Cursor (~/.cursor/mcp.json)', code: cursorConfig },
        {
          kind: 'links',
          items: [
            { label: 'VS Code, the Claude API and other clients', href: '/docs/connect/' },
            { label: 'Set up with a coding agent', href: '/docs/agent-setup/' },
          ],
        },
      ],
    },
    {
      id: 'tools',
      topic: 'Tools',
      heading: { soft: `${facts.toolCount} tools, each with a JSON Schema.`, strong: 'Reads are marked read-only.' },
      lede: `${facts.readToolCount} tools read and ${facts.writeToolCount} write. Bookings and holds take an idempotency key, so a retried call books once.`,
      blocks: [
        {
          kind: 'table',
          caption: 'The Slotlock MCP tools',
          columns: ['Tool', 'What it does', 'Access'],
          rows: facts.tools.map((tool) => [`\`${tool.name}\``, tool.title, access(tool)]),
        },
        { kind: 'links', items: [{ label: 'Every input, output and error code', href: '/docs/tools/' }] },
      ],
    },
    {
      id: 'flow',
      topic: 'How an agent books',
      heading: { soft: 'Find, hold, let a person pick,', strong: 'then book or let it lapse.' },
      blocks: [
        {
          kind: 'steps',
          items: [
            {
              title: 'Find free time',
              body: '`slotlock_find_available_slots` or `slotlock_find_next_available` searches one resource or several, with each resource\'s own hours, time zone and booking rules applied.',
            },
            {
              title: 'Hold the options',
              body: `\`slotlock_hold_slots\` holds up to ${facts.holdSlotsMax} candidates as one group for ${facts.holdTtlMin} to ${facts.holdTtlMax} seconds. Nobody else can book them meanwhile.`,
            },
            {
              title: 'Let a person pick in the chat',
              body: 'Read tools link to an MCP App, a calendar view that hosts render in a sandbox. The person picks a time and presses Book this time.',
            },
            {
              title: 'Book it',
              body: '`slotlock_confirm_slot` books the chosen hold and releases the others. A hold nobody books expires on the database clock.',
            },
            {
              title: 'Act on a refusal',
              body: 'A taken time comes back as a tool result, `{"error":{"code":"overlap"}}`, not a protocol error, so the agent can search again and offer the next free time.',
            },
          ],
        },
        { kind: 'links', items: [{ label: 'MCP Apps', href: '/docs/connect/#mcp-apps' }, { label: 'Holds', href: '/docs/concepts/#holds' }] },
      ],
    },
    {
      id: 'guarantees',
      topic: 'What it guarantees',
      heading: { soft: 'The database decides every overlap.', strong: 'Unknown time is never free.' },
      blocks: [
        {
          kind: 'list',
          items: [
            'Every booking, hold and event is a row checked by a PostgreSQL exclusion constraint on the resource and its time range. Two agents racing for one slot get one booking and one `overlap`.',
            'Busy time imported from other calendars is tracked with how far each feed has been read. Time no feed has proven is `uncertain`, never free, and `requireCertain` can refuse bookings there.',
            'The tenant comes from the API key, never from a tool argument, and row-level security keeps tenants apart.',
            'Self-hosted, each write can wait for a person to confirm it in the client (MCP 2026-07-28 with form elicitation).',
          ],
        },
        { kind: 'links', items: [{ label: 'Why agents double-book', href: '/blog/why-ai-agents-double-book/' }, { label: 'Security model', href: '/docs/security/' }] },
      ],
    },
    {
      id: 'protocols',
      topic: 'Protocols',
      heading: { soft: 'MCP for tools, A2A for agents,', strong: 'REST for everything else.' },
      blocks: [
        {
          kind: 'list',
          items: [
            `MCP over Streamable HTTP: ${facts.mcpModern} to clients that ask for it, and ${facts.mcpLegacy} or ${facts.mcpOlder} to the rest.`,
            `A2A ${facts.a2a}: the same operations as skills, with an agent card at \`/.well-known/agent-card.json\`.`,
            'REST under `/v1`, described by an OpenAPI 3.1 document, for code that calls Slotlock directly ([Booking API](/booking-api/)).',
            'Listed in the MCP Registry as `io.github.PILOTAAI/slotlock`.',
          ],
        },
      ],
    },
    {
      id: 'faq',
      topic: 'FAQ',
      heading: { soft: 'Questions', strong: 'about the MCP server.' },
      blocks: [
        {
          kind: 'faq',
          items: [
            { q: 'Which clients work?', a: 'Any MCP client that speaks Streamable HTTP: Claude Code, Cursor, VS Code, the Claude API\'s MCP connector and the MCP SDKs. The [connect guide](/docs/connect/) has each one\'s setup.' },
            { q: 'Does it read my Google or Outlook calendar?', a: 'Not by itself. Your adapter brings each feed in as iCalendar busy time, and Slotlock records how much of it has been read ([External calendars](/docs/external-calendars/)).' },
            { q: 'Is it for meetings between people?', a: 'It books things and staff hours that take one booking at a time: vans, rooms, courts, machines, a technician\'s afternoon. For a meeting link between two people, a scheduling page does that already.' },
            { q: 'Can I run the MCP server myself?', a: `Yes. The server is ${facts.license}; run the image or \`slotlock serve\` against your own PostgreSQL ([self-hosting](/docs/self-host/)).` },
            { q: 'What does it cost?', a: 'Slotlock Cloud starts free, with no card ([pricing](/pricing/)). Self-hosting costs nothing.' },
          ],
        },
      ],
    },
  ],
  closing: {
    heading: { soft: 'Give your agent a calendar it cannot double-book.', strong: 'Connect it in a minute.' },
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Quickstart', href: '/docs/quickstart/' },
    ],
  },
  jsonLd: [softwareApplication(description)],
};
