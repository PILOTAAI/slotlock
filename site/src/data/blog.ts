// The blog: articles on booking, calendars and AI agents, each grounded in Slotlock's code, tests
// or docs and linking the page it deepens (docs/rfc/0005-search.md, Phase 3). Posts are data, like
// the other pages outside the docs, so the HTML (src/pages/blog/) and the Markdown twin say the
// same thing and the strict CSP needs nothing inline. Text takes `code` and [links](/path).
import facts from '../generated/facts.json';
import type { PageLink } from '../lib/page';
import { PYLOTA_URL, RACE_TEST_URL, REPO_URL } from './landing';

export type Part =
  | { h2: string }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { code: string; caption?: string }
  | { table: { columns: string[]; rows: string[][] } };

export interface Post {
  slug: string;
  title: string;
  /** The <title>, when the headline is longer than 65 characters. */
  seoTitle?: string;
  description: string;
  /** ISO dates. */
  date: string;
  updated?: string;
  image: string;
  imageAlt: string;
  tags: string[];
  body: Part[];
  related: PageLink[];
}

/** Until a person is named (RFC 0005, D7). */
export const AUTHOR = { name: 'The Slotlock maintainers', url: `${REPO_URL}/blob/main/MAINTAINERS.md` };

const constraintPost: Post = {
  slug: 'postgresql-exclusion-constraint-double-booking',
  title: 'Preventing double bookings with a PostgreSQL exclusion constraint',
  seoTitle: 'Prevent double bookings with a PostgreSQL exclusion constraint',
  description:
    'Why a check-then-insert booking races, and how an exclusion constraint on a tstzrange makes PostgreSQL refuse the overlap: the SQL, the error, the edge cases.',
  date: '2026-11-11',
  image: 'blog-postgresql-exclusion-constraint',
  imageAlt: 'Preventing double bookings with a PostgreSQL exclusion constraint.',
  tags: ['PostgreSQL', 'double booking', 'concurrency'],
  body: [
    { p: 'Most booking code checks that a slot is free and then inserts the booking. Under load, and above all when AI agents book on their own, that check is the bug. This post shows why, and the one constraint that fixes it: the one Slotlock\'s schema is built on.' },
    { h2: 'The race in check-then-insert' },
    { p: 'The usual code reads, then writes:' },
    { code: `SELECT 1 FROM bookings
 WHERE resource_id = $1
   AND starts_at < $3 AND ends_at > $2;   -- any overlap?
-- none found, so:
INSERT INTO bookings (resource_id, starts_at, ends_at) VALUES ($1, $2, $3);` },
    { p: 'Two requests that run this at the same moment both see no overlap, because neither has inserted yet, and both insert. Under the default isolation level, PostgreSQL does nothing to stop it: each statement saw a consistent snapshot, and the two rows do not conflict on any unique key.' },
    { p: 'The usual patches each cost something. `SELECT … FOR UPDATE` locks rows that exist, but the conflicting row does not exist yet. An advisory lock per resource works until a code path forgets to take it. Serializable isolation catches the anomaly, at the price of retries on every write path. A unique index cannot help, because two overlapping ranges are not equal.' },
    { h2: 'An exclusion constraint says what you mean' },
    { p: 'An exclusion constraint generalises a unique constraint: instead of "no two rows are equal", it says "no two rows satisfy these operators together". For bookings: no two rows have the same resource and overlapping time.' },
    { code: `CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE bookings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id uuid        NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  CHECK (starts_at < ends_at),
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);` },
    { p: '`btree_gist` lets a GiST index compare the plain `uuid` with `=` beside the range overlap operator `&&`. The index the constraint builds is the one that checks every insert and update, inside the transaction, against every committed and in-flight row. Two concurrent inserts for overlapping times cannot both commit: one waits for the other, then fails.' },
    { h2: 'What the losing writer sees' },
    { p: 'The loser gets SQLSTATE `23P01`, `exclusion_violation`. Match on the code, never the message, which changes between versions and locales. In Slotlock the store turns `23P01` into a result, `{ ok: false, code: "overlap" }`, and every interface passes that on as data: a tool result over MCP, a `409` problem over REST. An agent can then search again and offer the next free time.' },
    { p: 'One more case belongs in the handler. Concurrent inserts into the same exclusion index can deadlock inside the constraint check itself (`40P01`). PostgreSQL rolls the victim back completely, so retrying it once either wins or fails cleanly with `23P01`. Slotlock\'s store does exactly that.' },
    { h2: 'Half-open ranges' },
    { p: 'Write ranges as `[start, end)`: the start is in, the end is out. A booking from 10:00 to 12:00 and another from 12:00 to 14:00 then do not overlap, which is what everyone expects. With closed ranges, `[]`, they would share the instant 12:00 and the second would be refused.' },
    { h2: 'Cleaning time, holds and cancellations' },
    { p: 'Real bookings occupy more than their own time. A rental car needs cleaning after the hire; a room needs setting up before the meeting. Slotlock stores an occupied range beside the booked one and constrains that instead, so turnaround and buffers are protected by the same rule:' },
    { code: facts.excludeConstraint, caption: 'The constraint in Slotlock\'s schema' },
    { ul: [
      'Holds sit under the same constraint, so a hold blocks a booking, and a booking a hold, with no second check. A hold carries an expiry on the database clock, and the next writer that wants its time removes it; nothing waits for a cron job.',
      'Cancelled rows must not block the time. Delete them, move them to another table, or add a `WHERE (status <> \'cancelled\')` predicate to the constraint, which PostgreSQL supports for exclusion constraints.',
      'Several resources at once, such as a van and its driver, are several rows written in one transaction: if any one fails the constraint, the whole booking rolls back.',
    ] },
    { h2: 'Test the race, not the happy path' },
    { p: `Slotlock's integration suite runs two overlapping inserts in parallel against a real PostgreSQL and asserts that exactly one wins and the other is refused with \`overlap\`. [Read the race test](${RACE_TEST_URL}). If your own booking code has no such test, the race is still there, waiting for traffic.` },
    { h2: 'When to use the product instead of the pattern' },
    { p: 'The constraint is a few lines, and you can add it to your own schema today. What takes longer is everything around it: each resource\'s hours in its own time zone, holds that lapse, imported busy time you cannot yet trust, retries that must not book twice, and the tools an agent calls. That is what Slotlock adds, on the same PostgreSQL. [How it compares with building it yourself](/compare/diy/).' },
  ],
  related: [
    { label: 'Concepts: the exclusion constraint', href: '/docs/concepts/#the-exclusion-constraint' },
    { label: 'Open source', href: '/open-source/' },
    { label: 'Why AI agents double-book', href: '/blog/why-ai-agents-double-book/' },
  ],
};

const agentsPost: Post = {
  slug: 'why-ai-agents-double-book',
  title: 'Why AI agents double-book, and what the calendar has to do about it',
  seoTitle: 'Why AI agents double-book, and how the calendar must stop it',
  description:
    'Agents retry, run in parallel and trust what an API tells them. Four ways that turns into double bookings, and what a calendar for agents has to do instead.',
  date: '2026-11-11',
  image: 'blog-why-ai-agents-double-book',
  imageAlt: 'Why AI agents double-book, and what the calendar has to do about it.',
  tags: ['AI agents', 'MCP', 'double booking'],
  body: [
    { p: 'An AI agent with a calendar tool can book a meeting room, a rental van or a court in seconds. Give several agents the same tool and the bookings start to collide. The cause is rarely the model. It is a calendar API built for people clicking one button at a time.' },
    { h2: '1. Agents run in parallel' },
    { p: 'A person books, waits and looks. Agents are deployed in fleets: a phone agent, a chat agent and a partner\'s agent can all ask for the same van in the same second. Any calendar that checks availability and then writes, in two steps, lets more than one of them through. The fix is to make the write itself conditional, in one place every path goes through. Slotlock puts that condition in PostgreSQL as an exclusion constraint, so a race has one winner however many agents run ([how the constraint works](/blog/postgresql-exclusion-constraint-double-booking/)).' },
    { h2: '2. Agents retry' },
    { p: 'Tool calls time out, connections drop, and agent frameworks retry. If the first call actually booked and the retry books again, the customer has two vans. Every write needs an idempotency key: the same key with the same arguments answers the first result instead of booking twice. In Slotlock, event writes and holds take an `idempotency_key`, and a retry answers `replayed`. The same key with different arguments is refused, because it means a bug.' },
    { h2: '3. Agents trust what they are told' },
    { p: 'A model treats an empty busy list as free time. If the busy time comes from a marketplace feed that failed to sync overnight, "nothing is booked" and "we do not know" look the same, and the agent books into a gap that is not there.' },
    { p: 'A calendar for agents has to tell those apart. Slotlock records how far each imported feed has been read, and marks unread time `uncertain` rather than free. Search tools never offer an uncertain slot, and a resource with `requireCertain` refuses a booking there. "Unknown" stays unknown, and the agent can say so.' },
    { h2: '4. Agents need a person in the loop, briefly' },
    { p: 'Most bookings end with a person choosing: which of three times, which car. While they decide, the options must not be sold to someone else, and if they walk away, the options must come back. A calendar without holds forces agents to book first and cancel later, which shows the slot as taken to everyone else in the meantime.' },
    { p: `Slotlock's agents hold up to ${facts.holdSlotsMax} candidates as one group for ${facts.holdTtlMin} to ${facts.holdTtlMax} seconds; booking one releases the rest, and a hold nobody books lapses on the database clock ([holds, in detail](/blog/holds-keep-a-slot-while-a-person-decides/)).` },
    { h2: 'Refusals an agent can act on' },
    { p: 'When a write is refused, an agent needs to know why, in a form it can branch on. A protocol error or a stack trace ends the conversation; a result with a code continues it. Slotlock answers a taken time as a tool result, `{"error":{"code":"overlap"}}` over MCP or a `409` RFC 9457 problem over REST, so the agent searches again and offers the next free time.' },
    { h2: 'A checklist for any calendar your agents use' },
    { ol: [
      'Is the overlap check part of the write, enforced where every path goes through?',
      'Does every write take an idempotency key?',
      'Can the calendar say "unknown" instead of "free" when its data is stale?',
      'Can an agent hold options while a person decides, with an expiry it does not have to clean up?',
      'Are refusals data with a code, not errors?',
      'Does the tenant come from the credential, never from an argument the model fills in?',
    ] },
    { p: 'Slotlock was built to answer yes to each, first for [Pylota](/blog/pylota-car-rental-case-study/)\'s car rental agents. You can [connect it to an agent](/mcp-server/) in a minute, or [read the code](/open-source/).' },
  ],
  related: [
    { label: 'Booking MCP server', href: '/mcp-server/' },
    { label: 'Free/busy certainty', href: '/docs/concepts/#freebusy-certainty' },
    { label: 'Security model', href: '/docs/security/' },
  ],
};

const holdsPost: Post = {
  slug: 'holds-keep-a-slot-while-a-person-decides',
  title: 'Holds: keep a slot while a person decides',
  description:
    'How Slotlock holds booking options while a person chooses: groups of candidates, expiry on the database clock, payment-required holds and long holds over REST.',
  date: '2026-11-11',
  image: 'blog-holds',
  imageAlt: 'Holds: keep a slot while a person decides.',
  tags: ['holds', 'booking', 'MCP'],
  body: [
    { p: 'A booking is rarely one step. An agent finds a few times, a person picks one, sometimes they pay, and only then is it booked. Between the first step and the last, the options have to be kept for that person, and released if they leave. That is what a hold is for.' },
    { h2: 'Why not book, then cancel?' },
    { p: 'Booking the candidates and cancelling the unchosen ones looks simpler, but it lies to everyone else: for those minutes the times show as booked, webhooks fire for bookings that never were, and if the agent crashes before cancelling, the times stay taken. A hold is a different state, visible as occupied but not booked, and it ends on its own.' },
    { h2: 'Holds in Slotlock' },
    { ul: [
      `Over MCP, \`slotlock_hold_slots\` holds up to ${facts.holdSlotsMax} candidate slots as one group, for ${facts.holdTtlMin} to ${facts.holdTtlMax} seconds. Each free one is held; the others are listed with why not.`,
      'Booking one, with `slotlock_confirm_slot` or `slotlock_create_event` and its `hold_id`, books exactly that time and releases the rest of the group.',
      'A hold nobody books expires on the database clock, and the next writer that wants its time removes it. No scheduled job has to run first.',
      `\`slotlock_hold_together\` holds one time on several resources, such as a car and its driver, all or none. Through the REST API, a hold can last up to ${facts.maxHoldDays} days, for a venue date that waits on a contract.`,
    ] },
    { p: 'Holds sit under the same exclusion constraint as bookings, so a hold refuses a booking and a booking refuses a hold, with no second check that could race ([the constraint](/blog/postgresql-exclusion-constraint-double-booking/)).' },
    { h2: 'A person picks in the chat' },
    { p: 'Hosts that support MCP Apps render Slotlock\'s calendar view beside the conversation: days and times to choose from, and a Book this time button. Pressing it sends one chat message naming the slot, and the agent books the hold. The view makes no network requests and never writes; write tools are marked so a host never lets a view call them ([MCP Apps](/docs/connect/#mcp-apps)).' },
    { h2: 'Holds that wait for payment' },
    { p: 'A hold made with `payment_required` is booked only once the system you book for records the payment. Booking it earlier answers `payment_required`, so the agent sends the person to pay and tries again. The car stays theirs while the checkout runs, and goes back on offer if the payment never comes.' },
    { h2: 'Limits that keep holds honest' },
    { ul: [
      `One agent may have ${facts.holderHolds} live holds at once, so a runaway loop cannot freeze a fleet.`,
      'A hold belongs to whoever made it; another key cannot book or release it.',
      'A retried hold with the same idempotency key answers the same holds instead of making new ones.',
    ] },
    { h2: 'Waitlists turn freed time into holds' },
    { p: 'When a booking is cancelled or a hold lapses, a waitlist can offer the time to the next person in line, as a hold of their own to book or decline. Freed time goes in join order, so a cancellation at short notice is sold instead of wasted ([waitlists](/docs/api/join-waitlist/)).' },
  ],
  related: [
    { label: 'Concepts: holds', href: '/docs/concepts/#holds' },
    { label: 'Hold time over REST', href: '/docs/api/acquire-hold/' },
    { label: 'Booking API', href: '/booking-api/' },
  ],
};

const pylotaPost: Post = {
  slug: 'pylota-car-rental-case-study',
  title: 'How Pylota checks every car rental booking with Slotlock',
  description:
    'Pylota, the AI fleet manager for car rental operators, runs Slotlock in its own PostgreSQL: each vehicle a resource, quoted cars held, overlaps refused.',
  date: '2026-11-11',
  image: 'blog-pylota',
  imageAlt: 'Case study: how Pylota checks every car rental booking with Slotlock.',
  tags: ['case study', 'car rental', 'Pylota'],
  body: [
    { p: `[Pylota](${PYLOTA_URL}) is the AI fleet manager for independent car rental operators. Its agents quote cars to renters and take bookings. Slotlock started as Pylota's booking engine, and Pylota still checks every booking with it.` },
    { h2: 'The problem: many channels, one car' },
    { p: 'An independent operator can sell the same car through its own site, by phone, on marketplaces and through AI agents. If each channel checks availability and then writes, two that check at the same moment both see the car free, and the operator finds out at the depot, with two renters and one car.' },
    { p: 'Agents made the window wider, not narrower: they answer at any hour, they retry when a call times out, and a renter they quote can take minutes to pay.' },
    { h2: 'How Pylota uses Slotlock' },
    { ul: [
      'Slotlock runs as a library inside Pylota\'s own service and PostgreSQL, not as a separate server.',
      'Each vehicle is a resource.',
      'Every booking Pylota records also writes a Slotlock reservation in the same transaction. The exclusion constraint is the database\'s check against double bookings: if the reservation is refused, the booking is not recorded.',
      'A car an agent has quoted is held, with an expiry, while the renter pays. If they walk away, the hold lapses and the car is back on offer.',
    ] },
    { h2: 'Why a library and a transaction' },
    { p: 'Writing the reservation in the same transaction as Pylota\'s own booking means there is no moment where one exists without the other. If the database refuses the reservation, the whole transaction rolls back and the caller gets `overlap` instead of a second booking.' },
    { p: 'Operators who are not Pylota can do the same with the [TypeScript library](/docs/library/), or call Slotlock over MCP, A2A or REST from any stack ([Booking API](/booking-api/)).' },
    { h2: 'What it means for an operator' },
    { ul: [
      'A car is promised to one renter at a time, whichever channel sold it.',
      'Turnaround for cleaning and inspection is kept between hires by the same constraint.',
      'A renter halfway through paying keeps their car for as long as the hold says, and no longer.',
    ] },
    { p: 'Running a fleet of your own? [Car and van rental with Slotlock](/use-cases/car-rental/) shows how to model it, and you can try it in a sandbox seeded with cars and vans in pools at two branches.' },
  ],
  related: [
    { label: 'Car and van rental', href: '/use-cases/car-rental/' },
    { label: 'TypeScript library', href: '/docs/library/' },
    { label: 'About Slotlock', href: '/about/' },
  ],
};

/** Newest first. */
export const POSTS: Post[] = [constraintPost, agentsPost, holdsPost, pylotaPost];

export const postPath = (post: Post) => `/blog/${post.slug}/`;
