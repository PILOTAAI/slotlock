// /booking-api/: the REST, MCP and A2A API for people searching for a booking or scheduling API.
// Route groups come from scripts/api-reference.mjs; clients and versions from facts.json.
import facts from '../../generated/facts.json';
import type { MarketingPage } from '../../lib/page';
import { softwareApplication } from '../../lib/seo';
import { GROUPS } from '../../../scripts/api-reference.mjs';
import { CLOUD_API_URL, SIGN_IN_URL } from '../landing';

const routeCount = GROUPS.reduce((sum: number, group: { operations: string[] }) => sum + group.operations.length, 0);
const description = `A booking API for AI agents and the code around them: ${routeCount} REST routes with OpenAPI 3.1, the same operations over MCP and A2A, and clients in five languages.`;

const holdExample = `curl -X POST "${CLOUD_API_URL}/v1/holds" \\
  -H "Authorization: Bearer $SLOTLOCK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H 'Idempotency-Key: "checkout-7f3a"' \\
  -d '{ "resource_id": "<resource id>", "start": "2027-03-01T10:00:00Z",
        "end": "2027-03-01T12:00:00Z", "ttl_seconds": 600 }'`;

const conflict = `HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "tag:slotlock.pylota.io,2026:problem:overlap",
  "title": "The time is taken",
  "status": 409,
  "code": "overlap"
}`;

export const bookingApiPage: MarketingPage = {
  path: '/booking-api/',
  title: 'Booking API for AI agents: REST, MCP and A2A | Slotlock',
  description,
  image: 'booking-api',
  imageAlt: 'Slotlock: one booking API over REST, MCP and A2A.',
  crumbs: [{ name: 'Booking API', path: '/booking-api/' }],
  hero: {
    topic: 'Booking API',
    heading: { soft: 'One booking API for agents and the code around them.', strong: 'REST, MCP and A2A, the same rules.' },
    lede: `Resources with their own hours and time zones, free/busy and next available, holds that expire, bookings that cannot overlap, waitlists and a change feed. ${routeCount} REST routes described by OpenAPI 3.1, with the agent operations also over MCP and A2A.`,
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'REST reference', href: '/docs/api/' },
    ],
  },
  sections: [
    {
      id: 'capabilities',
      topic: 'What it does',
      heading: { soft: 'Everything a booking needs,', strong: 'checked by the database.' },
      blocks: [
        {
          kind: 'cards',
          items: [
            { title: 'Resources and rules', body: 'Each van, room, court or person is a calendar with a time zone, weekly hours, exceptions such as holidays, and booking rules: notice, steps, turnaround and buffers.', href: '/docs/booking-rules/' },
            { title: 'Availability', body: `Free/busy, next available, available slots and ranges, over windows up to ${facts.horizonDays} days, for one resource or a set.`, href: '/docs/api/get-free-busy/' },
            { title: 'Holds', body: `Hold time while a customer pays or a person picks. Holds expire on the database clock; through the REST API they can last up to ${facts.maxHoldDays} days.`, href: '/docs/api/acquire-hold/' },
            { title: 'Bookings', body: 'Events and reservations, recurring series, rescheduling and cancelling, all refused on overlap by an exclusion constraint.', href: '/docs/api/create-event/' },
            { title: 'Pools and groups', body: 'Book any one of a class, such as any SUV, or several resources together: all of them, or none.', href: '/docs/api/book-pool/' },
            { title: 'Waitlists and the feed', body: 'Freed time offered to the next in line as a hold, and every change as CloudEvents and signed webhooks.', href: '/docs/api/list-changes/' },
          ],
        },
      ],
    },
    {
      id: 'example',
      topic: 'Example',
      heading: { soft: 'Hold two hours while the customer pays.', strong: 'A race gets one hold and one 409.' },
      lede: 'Every error is an RFC 9457 problem with a `code`, so the caller can tell a taken time from a bad request and act on it.',
      blocks: [
        { kind: 'code', caption: 'POST /v1/holds', code: holdExample },
        { kind: 'code', caption: 'The second caller, a moment later', code: conflict },
        { kind: 'links', items: [{ label: 'Hold time', href: '/docs/api/acquire-hold/' }, { label: 'Errors', href: '/docs/api/#errors' }] },
      ],
    },
    {
      id: 'design',
      topic: 'Built for retries',
      heading: { soft: 'Safe to call twice.', strong: 'Clear about what it does not know.' },
      blocks: [
        {
          kind: 'list',
          items: [
            'Writes take an `Idempotency-Key`. A repeated reservation answers `replayed: true`; the same key with a different request answers `422 idempotency_conflict`.',
            'Times are RFC 3339 and time zones IANA names. Each resource\'s rules follow its own clock, daylight saving included.',
            'Busy time imported from other calendars carries how far each feed was read. Unread time is `uncertain`, and a resource can refuse bookings there.',
            'Keys are read only, read and write, or full, and can expire or be revoked. The tenant always comes from the key.',
          ],
        },
      ],
    },
    {
      id: 'access',
      topic: 'Ways in',
      heading: { soft: 'Call it from code,', strong: 'or let an agent call it.' },
      blocks: [
        {
          kind: 'table',
          caption: 'How to reach the Slotlock API',
          columns: ['Way in', 'What you get', 'Start here'],
          rows: [
            ['REST', `${routeCount} routes under \`/v1\`, an OpenAPI 3.1 document and a Postman collection`, '[REST reference](/docs/api/)'],
            ['MCP', `${facts.toolCount} tools for agents, with an MCP App to pick a slot in the chat`, '[MCP server](/mcp-server/)'],
            ['A2A', `A2A ${facts.a2a} skills and an agent card`, '[MCP and A2A reference](/docs/reference/)'],
            ['Clients', `${facts.clients.join(', ')}, at version ${facts.version}`, '[Language clients](/docs/clients/)'],
            ['TypeScript library', 'The engine inside your own Node.js service and PostgreSQL', '[TypeScript library](/docs/library/)'],
          ],
        },
      ],
    },
    {
      id: 'faq',
      topic: 'FAQ',
      heading: { soft: 'Questions', strong: 'about the API.' },
      blocks: [
        {
          kind: 'faq',
          items: [
            { q: 'Can I call it from a browser?', a: 'No: the API sends no CORS headers, so call it from your server, where the key stays secret.' },
            { q: 'Is there a sandbox?', a: 'Yes. A test key (`slk_test_…`) has an environment of its own: seed it with a scenario such as car rental, fast-forward time so holds lapse, and race up to 200 agents for one slot ([sandbox routes](/docs/api/sandbox-seed/)).' },
            { q: 'How are changes announced?', a: 'Slotlock Cloud gives 90 days\' notice before anything under `/v1` changes ([versioning](/docs/versioning/)).' },
            { q: 'What does it cost?', a: 'Slotlock Cloud starts free; paid plans add room ([pricing](/pricing/)). Self-hosting costs nothing.' },
          ],
        },
      ],
    },
  ],
  closing: {
    heading: { soft: 'Stop checking for conflicts in application code.', strong: 'Let the API refuse them.' },
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'REST reference', href: '/docs/api/' },
    ],
  },
  jsonLd: [
    softwareApplication(description),
    {
      '@type': 'WebAPI',
      name: 'Slotlock REST API',
      description,
      documentation: 'https://slotlock.pylota.io/docs/api/',
      termsOfService: 'https://slotlock.pylota.io/docs/terms/',
      provider: { '@id': 'https://slotlock.pylota.io/#organization' },
    },
  ],
};
