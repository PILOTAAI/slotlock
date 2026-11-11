// /compare/ and one page per alternative. A claim about another product links the page it comes
// from and carries the date it was checked (docs/rfc/0005-search.md, D5); check each again when
// that date is a quarter old. Slotlock's side states only what its docs say.
import type { Heading } from '../landing';
import type { MarketingPage, PageLink } from '../../lib/page';
import { RACE_TEST_URL, SIGN_IN_URL } from '../landing';
import { COMPETITORS } from './competitors';

export interface Comparison {
  slug: string;
  name: string;
  title: string;
  description: string;
  heading: Heading;
  lede: string;
  /** What the other one is, in its own terms. */
  summary: string[];
  /** Rows: what is compared, the other, Slotlock. */
  rows: [string, string, string][];
  chooseThem: string[];
  chooseUs: string[];
  together?: string[];
  checked: string;
  sources: PageLink[];
}

const DIY: Comparison = {
  slug: 'diy',
  name: 'A bookings table and a cron job',
  title: 'Slotlock vs building bookings yourself: table, cron, checks',
  description:
    'Why a read-then-insert check double-books under load, what a cron job misses, and when a bookings table of your own is still the right call.',
  heading: { soft: 'A bookings table and a cron job,', strong: 'or a calendar that refuses for you.' },
  lede: 'Most booking systems start as a table, a query that checks for overlaps before inserting, and a scheduled job that clears abandoned holds. It works until two writers arrive at the same moment, which agents make routine.',
  summary: [
    'The usual design checks for a free slot with a SELECT, then INSERTs the booking. Between the two, another request can do the same check and see the same free slot. Both inserts succeed, unless the database itself refuses the second.',
    'Holds become rows with an expiry that a cron job deletes later, so an expired hold blocks the slot until the job runs. Busy time from other calendars is copied in on a schedule, and a feed that failed overnight reads as free time.',
  ],
  rows: [
    ['Two writers, one slot', 'A read-then-insert check can pass for both; locking or serializable transactions must be added and tested by hand.', 'An exclusion constraint admits one; the other gets `overlap`, as data.'],
    ['Abandoned holds', 'A scheduled job deletes them later; until it runs, the slot stays blocked.', 'Holds expire on the database clock; the next writer that wants the time removes them.'],
    ['A stale calendar feed', 'Missing data reads as free time.', 'Unread time is `uncertain`, and `requireCertain` can refuse bookings there.'],
    ['Time zones and daylight saving', 'Stored as UTC; weekly hours drift by an hour twice a year unless handled.', 'Each resource\'s rules follow its own IANA time zone, daylight saving included.'],
    ['Several resources at once', 'Several inserts in one transaction, with the race on each.', '`slotlock_book_together` books 2 to 20 resources, all or none.'],
    ['Retries', 'A retried request can book twice.', 'Idempotency keys answer a retry with the first result.'],
    ['Agents', 'Tools, schemas and error shapes to design.', 'MCP tools, A2A skills and REST with OpenAPI, ready.'],
  ],
  chooseThem: [
    'Only one process ever writes bookings, and nothing books concurrently.',
    'Your needs are a single resource type with no holds, no imports and no time zones.',
    'You want the technique, not the product: an exclusion constraint on a `tstzrange` is a few lines of SQL ([how it works](/blog/postgresql-exclusion-constraint-double-booking/)).',
  ],
  chooseUs: [
    'Agents, your site and other channels book the same resources at once.',
    'People need options held while they decide, and holds must lapse on time.',
    'You import busy time from other calendars and must not treat a stale feed as free.',
  ],
  checked: '11 November 2026',
  sources: [
    { label: 'The race test in the Slotlock repository', href: RACE_TEST_URL },
    { label: 'PostgreSQL: exclusion constraints', href: 'https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION' },
  ],
};

const ALL: Comparison[] = [DIY, ...COMPETITORS];

function comparePage(c: Comparison): MarketingPage {
  return {
    path: `/compare/${c.slug}/`,
    title: c.title,
    description: c.description,
    image: `compare-${c.slug}`,
    imageAlt: `${c.title.replace(/ \| Slotlock$/, '')}.`,
    crumbs: [
      { name: 'Compare', path: '/compare/' },
      { name: c.name, path: `/compare/${c.slug}/` },
    ],
    hero: {
      topic: `Compare: Slotlock and ${c.name}`,
      heading: c.heading,
      lede: c.lede,
      actions: [
        { label: 'Start free', href: SIGN_IN_URL },
        { label: 'How Slotlock works', href: '/docs/concepts/' },
      ],
    },
    sections: [
      {
        id: 'summary',
        topic: c.slug === 'diy' ? 'The usual design' : `What ${c.name} is`,
        heading: c.slug === 'diy'
          ? { soft: 'Check, then insert.', strong: 'Clear holds on a schedule.' }
          : { soft: 'Different jobs,', strong: 'in their own words.' },
        blocks: [{ kind: 'text', paragraphs: c.summary }],
      },
      {
        id: 'side-by-side',
        topic: 'Side by side',
        heading: { soft: 'Where they differ,', strong: 'row by row.' },
        blocks: [
          {
            kind: 'table',
            caption: `${c.name} compared with Slotlock`,
            columns: ['', c.name, 'Slotlock'],
            highlight: 2,
            rows: c.rows,
          },
        ],
      },
      {
        id: 'choose',
        topic: 'Which to choose',
        heading: { soft: 'Each is right', strong: 'for a different job.' },
        blocks: [
          { kind: 'cards', items: [
            { title: `Choose ${c.name} when`, body: c.chooseThem.join(' ') },
            { title: 'Choose Slotlock when', body: c.chooseUs.join(' ') },
            ...(c.together ? [{ title: 'Or use both', body: c.together.join(' ') }] : []),
          ] },
        ],
      },
      {
        id: 'sources',
        topic: 'Sources',
        heading: { soft: 'Checked against their docs,', strong: 'not from memory.' },
        lede: 'If something here is out of date, open an issue on GitHub and it will be corrected.',
        blocks: [{ kind: 'sources', checked: c.checked, items: c.sources }],
      },
    ],
    closing: {
      heading: { soft: 'Try the race yourself.', strong: 'One slot, two agents, one booking.' },
      actions: [
        { label: 'Start free', href: SIGN_IN_URL },
        { label: 'Quickstart', href: '/docs/quickstart/' },
      ],
    },
  };
}

export const comparePages = ALL.map(comparePage);

export const compareHub: MarketingPage = {
  path: '/compare/',
  title: 'Compare Slotlock: Cal.com, Cronofy, Nylas, Google Calendar',
  description:
    'How Slotlock compares with Cal.com, Cronofy, Nylas, the Google Calendar API and a bookings table of your own, for agents that book resources, with sources.',
  image: 'compare',
  imageAlt: 'Compare Slotlock with the other ways to book.',
  crumbs: [{ name: 'Compare', path: '/compare/' }],
  pageType: 'CollectionPage',
  hero: {
    topic: 'Compare',
    heading: { soft: 'Scheduling tools book people into meetings.', strong: 'Slotlock books the things themselves.' },
    lede: 'Most calendar APIs are built to find a time when people are free and put a meeting in their calendars. Slotlock is built for resources that take one booking at a time, booked by agents, with the database refusing every overlap. Here is how they differ, with sources.',
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Read the docs', href: '/docs/' },
    ],
  },
  sections: [
    {
      id: 'comparisons',
      topic: 'Comparisons',
      heading: { soft: 'Pick the one', strong: 'you are weighing up.' },
      blocks: [
        {
          kind: 'cards',
          items: ALL.map((c) => ({ title: c.name, body: c.description, href: `/compare/${c.slug}/` })),
        },
      ],
    },
    {
      id: 'questions',
      topic: 'What to ask any calendar API',
      heading: { soft: 'Five questions', strong: 'that separate them.' },
      lede: 'Each comparison answers the same questions from the other product\'s own docs, with links, and says where Slotlock is the wrong choice.',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'What does it model?', body: 'People and their meetings, or resources that take one booking at a time, each with its own hours and rules.' },
            { title: 'What happens when two bookings arrive at once?', body: 'A check before the write can pass for both. Ask whether the refusal happens in the write itself.' },
            { title: 'Can it hold a slot while a person decides?', body: 'And does the hold end on its own, or does your code have to clean it up?' },
            { title: 'What can an agent call?', body: 'An MCP server, A2A, REST with OpenAPI, and refusals an agent can act on.' },
            { title: 'Can you run it yourself?', body: 'Licence, self-hosting, and where the data lives.' },
          ],
        },
      ],
    },
    {
      id: 'difference',
      topic: 'The short version',
      heading: { soft: 'Meetings between people,', strong: 'or one booking per resource.' },
      blocks: [
        {
          kind: 'list',
          items: [
            'Choose a scheduling platform when people book meetings with people, and you want booking pages, video links and sync with Google and Microsoft calendars.',
            'Choose Slotlock when agents book vans, rooms, courts, machines or staff hours, two of them may race for the same slot, and a hold must lapse on time.',
            'They work together: a scheduling platform can own people\'s calendars while Slotlock owns the resources they book.',
          ],
        },
      ],
    },
  ],
};
