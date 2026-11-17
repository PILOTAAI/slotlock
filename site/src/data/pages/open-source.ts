// /open-source/: Slotlock as an open-source, self-hosted booking engine. The constraint is read from
// the schema (facts.excludeConstraint), the commands from README.md, through facts.json.
import facts from '../../generated/facts.json';
import type { MarketingPage } from '../../lib/page';
import { softwareSourceCode } from '../../lib/seo';
import { RACE_TEST_URL, REPO_URL } from '../landing';

export const openSourcePage: MarketingPage = {
  path: '/open-source/',
  title: 'Open-source booking engine on PostgreSQL | Slotlock',
  description: `Slotlock is an ${facts.license} booking engine and MCP server: self-host it on PostgreSQL 16 to 18 with Docker or npm, and read how it refuses double bookings.`,
  image: 'open-source',
  imageAlt: 'Slotlock: an open-source booking engine on PostgreSQL.',
  crumbs: [{ name: 'Open source', path: '/open-source/' }],
  hero: {
    topic: 'Open source',
    heading: { soft: 'An open-source booking engine on PostgreSQL.', strong: 'Read it, run it, change it.' },
    lede: `The engine, the schema with its row-level security, the MCP, A2A and REST server, the dashboard and ${facts.clientCount} language clients are ${facts.license} on GitHub. Run the same server Slotlock Cloud runs, on your own database.`,
    actions: [
      { label: 'Source on GitHub', href: REPO_URL },
      { label: 'Self-hosting guide', href: '/docs/self-host/' },
    ],
  },
  sections: [
    {
      id: 'run',
      topic: 'Run it',
      heading: { soft: 'One command with Docker.', strong: 'Or one package in your service.' },
      lede: 'The quickstart starts Slotlock and PostgreSQL 18 together. The published image runs `slotlock serve` as an unprivileged user, with a health check.',
      blocks: [
        { kind: 'code', caption: 'From a clone of the repository', code: facts.composeUp ?? 'docker compose up --build --detach' },
        { kind: 'code', caption: 'The image', code: `docker pull ghcr.io/pilotaai/slotlock:${facts.version}` },
        { kind: 'code', caption: 'The library, in a Node.js service', code: `npm install slotlock@${facts.version} postgres` },
        {
          kind: 'links',
          items: [
            { label: 'Quickstart', href: '/docs/quickstart/' },
            { label: 'Self-hosting', href: '/docs/self-host/' },
            { label: 'TypeScript library', href: '/docs/library/' },
          ],
        },
      ],
    },
    {
      id: 'constraint',
      topic: 'How it refuses double bookings',
      heading: { soft: 'One constraint in the schema.', strong: 'No overlap gets past it.' },
      lede: 'Every booking, hold and reservation is a row. PostgreSQL checks each write against this constraint, inside the transaction, so two writers racing for one slot cannot both win.',
      blocks: [
        { kind: 'code', caption: 'The exclusion constraint, from the schema', code: facts.excludeConstraint },
        {
          kind: 'text',
          paragraphs: [
            'Ranges are half-open, `[start, end)`, so a booking that ends at 12:00 and one that starts at 12:00 do not touch. Turnaround and buffers widen the occupied range, so cleaning time is protected by the same constraint.',
            'The integration suite runs the race against a real PostgreSQL: concurrent inserts for the same time: one wins, and the other is refused with `overlap`.',
          ],
        },
        {
          kind: 'links',
          items: [
            { label: 'Read the race test', href: RACE_TEST_URL },
            { label: 'The constraint, explained', href: '/blog/postgresql-exclusion-constraint-double-booking/' },
            { label: 'Concepts', href: '/docs/concepts/#the-exclusion-constraint' },
          ],
        },
      ],
    },
    {
      id: 'contents',
      topic: 'What is in the repository',
      heading: { soft: 'Everything Slotlock Cloud runs.', strong: 'Nothing held back.' },
      blocks: [
        {
          kind: 'cards',
          items: [
            { title: 'Engine', body: 'Rule expansion and availability maths in TypeScript, with no database needed.', href: '/docs/library/' },
            { title: 'Schema and RLS', body: 'Resources, holds, events and the change feed in PostgreSQL, with row-level security per tenant.', href: '/docs/security/' },
            { title: 'Server', body: `\`slotlock serve\`: ${facts.toolCount} MCP tools, A2A ${facts.a2a} skills and the REST API.`, href: '/docs/reference/' },
            { title: 'Dashboard', body: 'Sign in with GitHub, manage resources, hours and keys, and see what every key changed.', href: '/docs/dashboard/' },
            { title: 'Clients', body: `${facts.clients.join(', ')}, released at the server\'s version.`, href: '/docs/clients/' },
            { title: 'Specification', body: 'The normative semantics: what every operation must do, independent of the code.', href: '/docs/specification/' },
          ],
        },
      ],
    },
    {
      id: 'governance',
      topic: 'Licence and governance',
      heading: { soft: `${facts.license}, kept that way.`, strong: 'Contributions welcome.' },
      blocks: [
        {
          kind: 'list',
          items: [
            `${facts.license}: use it, change it and run it commercially. GOVERNANCE.md commits the project to an OSI-approved licence.`,
            'Changes to the public API, the data model, scheduling semantics, tenancy or security boundaries go through an RFC or an issue and an independent security review.',
            'Versions follow semantic versioning; the server, the image and every client carry the same version ([versioning](/docs/versioning/)).',
            'Report security issues privately through GitHub, never in a public issue ([security model](/docs/security/)).',
          ],
        },
        {
          kind: 'links',
          items: [
            { label: 'Contributing', href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
            { label: 'Governance', href: `${REPO_URL}/blob/main/GOVERNANCE.md` },
            { label: 'Changelog', href: '/docs/changelog/' },
          ],
        },
      ],
    },
    {
      id: 'faq',
      topic: 'FAQ',
      heading: { soft: 'Questions', strong: 'about running it yourself.' },
      blocks: [
        {
          kind: 'faq',
          items: [
            { q: 'Which PostgreSQL versions?', a: 'PostgreSQL 16 to 18, as a role that is not a superuser and cannot bypass row-level security: `slotlock serve` refuses one that can.' },
            { q: 'Is the hosted service different?', a: 'It runs the same released server. On Slotlock Cloud writes take effect at once; on your own server each write can wait for a person to confirm it ([hosted Slotlock](/docs/hosted/)).' },
            { q: 'Do I need Node.js?', a: 'Not with the image. To embed the engine in your own service, the library needs Node.js 22.12 or newer.' },
            { q: 'Where do I get help?', a: 'Open an issue on GitHub. For paid plans on your own servers, see [pricing](/pricing/).' },
          ],
        },
      ],
    },
  ],
  closing: {
    heading: { soft: 'Read how every booking is stored and checked.', strong: 'Then run it where you like.' },
    actions: [
      { label: 'Source on GitHub', href: REPO_URL },
      { label: 'Self-hosting guide', href: '/docs/self-host/' },
    ],
  },
  jsonLd: [softwareSourceCode],
};
