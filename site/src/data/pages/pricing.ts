// /pricing/: the plans, read from facts.plans (src/plans.ts through scripts/sync-content.mjs), and
// what counts against them, as docs/hosted/README.md publishes it.
import facts from '../../generated/facts.json';
import type { MarketingPage } from '../../lib/page';
import { softwareApplication } from '../../lib/seo';
import { REPO_URL, SIGN_IN_URL } from '../landing';

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

const plans = ((facts as { plans?: HostedPlan[] | null }).plans ?? []) as HostedPlan[];
const plan = (id: string) => {
  const found = plans.find((p) => p.id === id);
  if (!found) throw new Error(`pricing: no ${id} plan in facts.plans`);
  return found;
};
const free = plan('free');
const developer = plan('developer');
const team = plan('team');
const n = (value: number | undefined) => (value === undefined ? 'None' : value.toLocaleString('en-GB'));
const price = (p: HostedPlan) => (p.monthly === 0 ? `${p.symbol}0` : `${p.symbol}${p.monthly} a month, or ${p.symbol}${p.yearly} a year`);
const contact = (facts as { planContact?: { label: string; href: string } | null }).planContact ?? {
  label: 'Write to support@pylota.io',
  href: 'mailto:support@pylota.io',
};

const description =
  'Slotlock Cloud plans: Free with no card, Developer and Team for production agents, or self-host the Apache-2.0 server at no charge. Limits and billing, in full.';

export const pricingPage: MarketingPage = {
  path: '/pricing/',
  title: 'Slotlock pricing: Free, Developer, Team or self-host',
  description,
  image: 'pricing',
  imageAlt: 'Slotlock pricing: start free on Slotlock Cloud, or run it yourself.',
  crumbs: [{ name: 'Pricing', path: '/pricing/' }],
  hero: {
    topic: 'Pricing',
    heading: { soft: 'Start free on Slotlock Cloud.', strong: 'Upgrade as you grow, or run it yourself.' },
    lede: `Every account starts on Free, with no card. Developer and Team add room for agents in production. The server is ${facts.license}, so running it on your own PostgreSQL costs nothing.`,
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Self-hosting guide', href: '/docs/self-host/' },
    ],
  },
  sections: [
    {
      id: 'plans',
      topic: 'Plans',
      heading: { soft: 'Four ways to run it.', strong: 'Three hosted, one yours.' },
      lede: 'Every hosted plan has the same server, the same tools and the same dashboard. They differ in how much each account can hold and do.',
      blocks: [
        {
          kind: 'table',
          caption: 'Slotlock plans compared',
          columns: ['', 'Free', 'Developer', 'Team', 'Self-host'],
          highlight: 2,
          rows: [
            ['Price', price(free), price(developer), `${price(team)}, for the whole workspace`, `${developer.symbol}0 (${facts.license})`],
            ['Resources', n(free.resources), n(developer.resources), n(team.resources), 'No limit from us'],
            ['Active API keys', n(free.apiKeys), n(developer.apiKeys), n(team.apiKeys), 'No limit from us'],
            ['Webhook endpoints', n(free.webhookEndpoints), n(developer.webhookEndpoints), n(team.webhookEndpoints), 'No limit from us'],
            ['Operations a month', n(free.operations), n(developer.operations), `${n(team.operations)}, shared`, 'No limit from us'],
            ['Bookings a month', n(free.bookings), n(developer.bookings), `${n(team.bookings)}, shared`, 'No limit from us'],
            ['People in a team workspace', 'Up to 3', 'Up to 3', 'No limit', 'No limit from us'],
            ['Who hosts it', 'We do, in the United Kingdom', 'We do, in the United Kingdom', 'We do, in the United Kingdom', 'You, on PostgreSQL 16 to 18'],
          ],
        },
        {
          kind: 'links',
          items: [
            { label: 'Start free', href: SIGN_IN_URL },
            { label: 'Hosted Slotlock in detail', href: '/docs/hosted/#plans' },
            { label: 'Self-hosting', href: '/docs/self-host/' },
          ],
        },
      ],
    },
    {
      id: 'allowances',
      topic: 'What counts',
      heading: { soft: 'Operations and bookings,', strong: 'counted each calendar month.' },
      blocks: [
        {
          kind: 'list',
          items: [
            'An operation is a call that runs: an MCP tool call, an A2A task or a REST request, the assistant\'s included. A request refused before it runs, for bad arguments or a rate limit, is not one.',
            'A booking is a reservation, a calendar event (a whole recurring series is one) or a confirmed hold.',
            'At 80% and 100% of either allowance, your change feed records `usage.threshold_reached`, your webhooks receive it, and the dashboard says so.',
            'On Free, calls past an allowance are refused with `429 quota_exceeded` until the month ends. You can still read your usage, read your bookings and cancel. On Developer and Team the same happens at 110%.',
            'Nothing is ever charged for use past an allowance. The monthly allowances apply from 10 December 2026.',
          ],
        },
      ],
    },
    {
      id: 'billing',
      topic: 'Billing',
      heading: { soft: 'Pay in your currency.', strong: 'Cancel from the dashboard.' },
      blocks: [
        {
          kind: 'text',
          paragraphs: [
            'Upgrade on the dashboard\'s Plan page. Stripe takes the payment as merchant of record, in your currency, with any sales tax or VAT added. Manage billing on the same page shows invoices, changes the payment method, switches between monthly and yearly, and cancels.',
            'A cancelled plan runs to the end of the period it was paid for. When a plan ends, the account returns to Free: nothing is deleted, but nothing more can be added while it holds more than Free allows.',
            'Team is for a shared workspace: a team workspace you create on the dashboard\'s Teams page, or a GitHub organization an owner has turned Slotlock on for. Everyone in it shares its resources, keys and history, and the price does not change with how many people use it. On Free or Developer, a team workspace has up to 3 people, open invitations included; Team lifts that limit. Only the workspace\'s Owners and Billing managers buy or manage it.',
          ],
        },
      ],
    },
    {
      id: 'self-host',
      topic: 'Self-host',
      heading: { soft: 'The same server on your PostgreSQL.', strong: 'No limits from us.' },
      blocks: [
        {
          kind: 'text',
          paragraphs: [
            `Run the published image, or \`npm install slotlock@${facts.version} postgres\`, against PostgreSQL 16 to 18. You get the same ${facts.toolCount} tools over MCP and A2A, the REST API, the dashboard and the clients for ${facts.clients.join(', ')}. You run it, back it up and upgrade it; nothing is sent to us.`,
            `Need your own servers with support and a contract? [${contact.label}](/about/#contact).`,
          ],
        },
        {
          kind: 'links',
          items: [
            { label: 'Self-hosting guide', href: '/docs/self-host/' },
            { label: 'Open source', href: '/open-source/' },
            { label: 'Source on GitHub', href: REPO_URL },
          ],
        },
      ],
    },
    {
      id: 'faq',
      topic: 'FAQ',
      heading: { soft: 'Questions', strong: 'about plans and billing.' },
      blocks: [
        {
          kind: 'faq',
          items: [
            { q: 'Do I need a card to start?', a: 'No. Sign in with GitHub and every account starts on Free.' },
            { q: 'What happens at a limit?', a: 'A write that would pass a resource, key or webhook limit is refused with an error code that names it. Past a monthly allowance, calls are refused with `429 quota_exceeded`; nothing is charged.' },
            { q: 'Where is my data?', a: 'In the United Kingdom, on OVHcloud\'s London servers, behind Cloudflare. The [privacy notice](/docs/privacy/) says what is kept and for how long.' },
            { q: 'Can I move from Cloud to my own server?', a: `Yes. It is the same server and the same API, ${facts.license} licensed, so agents keep their tools and only the address and key change.` },
            { q: 'Is it ready for production?', a: `${facts.version} is a 0.x release: a minor release may change the API, with 90 days\' notice before anything under \`/v1\` changes on Slotlock Cloud ([versioning](/docs/versioning/)).` },
            { q: 'What currency are prices in?', a: 'Prices are set in pounds sterling. At checkout Stripe, which sells the plans as merchant of record, can show and charge the amount in your own currency, and adds any sales tax or VAT.' },
          ],
        },
      ],
    },
  ],
  closing: {
    heading: { soft: 'Connect an agent today.', strong: 'Upgrade when it books for real.' },
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Read the docs', href: '/docs/' },
    ],
  },
  jsonLd: [softwareApplication(description)],
};
