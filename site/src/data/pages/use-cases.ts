// /use-cases/ and one page per industry. Each page says what to make a resource, which booking
// rules matter and what the agent calls, in the terms of docs-src/use-cases.md and the tools
// reference; rule and tool names are the real ones (the docs pages linked check them). A page that
// had nothing of its own to say would stay a section of the hub (docs/rfc/0005-search.md, Phase 2).
import type { Heading } from '../landing';
import type { Block, MarketingPage } from '../../lib/page';
import { SIGN_IN_URL } from '../landing';

interface UseCase {
  slug: string;
  name: string;
  /** For the <title>: what someone in this business searches for. */
  title: string;
  description: string;
  imageAlt: string;
  summary: string;
  heading: Heading;
  lede: string;
  problem: string[];
  resources: string[];
  rules: string[];
  agent: { title: string; body: string }[];
  limits: string[];
  /** One booking, start to finish, as the agent makes it. */
  example: string[];
  faq: { q: string; a: string }[];
}

const USE_CASES: UseCase[] = [
  {
    slug: 'car-rental',
    name: 'Car and van rental',
    title: 'Car and van rental booking API for AI agents | Slotlock',
    description:
      'Let AI agents book cars and vans: each vehicle a calendar, each class a pool, quoted cars held while the renter pays, and a second booking refused.',
    imageAlt: 'Car and van rental with Slotlock: every vehicle a calendar, and a second booking refused.',
    summary: 'Each vehicle is a calendar; a second booking is refused.',
    heading: { soft: 'Every vehicle a calendar.', strong: 'A second booking is refused.' },
    lede: 'Slotlock started inside Pylota, the AI fleet manager for independent car rental operators, which checks every booking with it. Agents quote, hold and book vehicles over MCP, A2A or REST, and PostgreSQL refuses any overlap.',
    problem: [
      'A rental fleet is booked from several places at once: your own site, phone agents, marketplaces and now AI agents. Each checks availability and then writes, and two writers who check at the same moment both see the car free.',
      'A renter who is quoted a car and starts to pay needs that car kept for them, but not for ever. Cleaning and inspection need time between hires, and a marketplace booking can arrive after your system has already offered the car.',
    ],
    resources: [
      'Each vehicle, in its depot\'s time zone.',
      'A pool per vehicle class, such as any SUV, so a class sells out at its size and an agent can book any free member.',
      'Marketplace bookings imported as iCalendar busy time through your adapter ([External calendars](/docs/external-calendars/)).',
    ],
    rules: [
      '`turnaroundMinutes` for cleaning and inspection between hires.',
      '`minNoticeMinutes` and `maxAdvanceDays` for how soon and how far ahead a car can be booked.',
      '`checkInMinutes` to release a car nobody collects.',
      '`requireCertain` to refuse bookings in time no marketplace feed has proven free.',
    ],
    agent: [
      { title: 'Search the class', body: 'For "any SUV, Friday to Sunday", `slotlock_get_pool_availability` says how many are free and when.' },
      { title: 'Hold while the renter picks', body: '`slotlock_hold_slots` holds two candidates as one group. With `payment_required`, a hold is booked only once your system records the payment.' },
      { title: 'Book the chosen car', body: '`slotlock_create_event` with the `hold_id` books it and releases the other. `slotlock_book_pool` takes the first free member instead.' },
      { title: 'Change or cancel', body: '`slotlock_reschedule` moves a hire to another time or car, refused on overlap like any write; `slotlock_cancel` frees it.' },
    ],
    limits: [
      'Slotlock does not price hires or take payment; it holds the car while your checkout does.',
      'It cannot see a booking a marketplace has not published yet. It marks time no sync has read as unproven instead of free.',
    ],
    example: [
      'A renter asks a chat agent for any SUV from Friday 09:00 to Sunday 18:00 at the airport branch. The agent asks for the SUV pool\'s availability, sees two free, and holds both for ten minutes while the renter compares them in the chat.',
      'The renter picks the white one and pays. Your checkout marks the hold paid, the agent books it with its `hold_id`, and the other SUV is released at once. At the same moment a marketplace channel tries to book the same white SUV for Saturday: the database refuses it with `overlap`, and that channel offers the next free car instead.',
    ],
    faq: [
      { q: 'Can a multi-week hire be one booking?', a: 'Yes. An event can last up to 3,660 days, and `slotlock_find_next_available` searches up to 367 days ahead for a long enough free run.' },
      { q: 'Can I try it with a fleet?', a: 'Yes. A test key\'s sandbox can be seeded with a car rental scenario: cars and vans in pools at two branches ([sandbox](/docs/api/sandbox-seed/)).' },
    ],
  },
  {
    slug: 'equipment-hire',
    name: 'Equipment hire',
    title: 'Equipment hire booking and scheduling API | Slotlock',
    description:
      'Book diggers, drills and trailers by the day with AI agents: inspection time kept between hires, any machine of a class, several booked together or none.',
    imageAlt: 'Equipment hire with Slotlock: machines booked by the day, with inspection time kept.',
    summary: 'Diggers to drills, with inspection time kept between hires.',
    heading: { soft: 'Machines booked by the day.', strong: 'Inspection time kept between hires.' },
    lede: 'Each machine is a calendar and each class a pool. Agents find what is free, hold it while the customer confirms, and book a digger with its trailer as one booking: all of it, or none.',
    problem: [
      'A hire desk takes bookings for machines that need preparing before a job and inspecting after it. A spreadsheet or a bookings table can show a machine free while it is still being refuelled, and two staff can promise the same digger.',
      'Jobs often need several things at once. Booking a digger without the trailer to move it is worse than booking nothing.',
    ],
    resources: [
      'Each machine or tool, in the depot\'s time zone.',
      'A pool per class, such as any 3-tonne digger, so customers book a kind of machine and the agent picks a free one.',
    ],
    rules: [
      '`turnaroundMinutes` for inspection and refuelling after each hire.',
      '`bufferBeforeMinutes` for preparation before it.',
      '`slotStepMinutes` when hires start on the hour or the half day.',
    ],
    agent: [
      { title: 'Find what is free together', body: '`slotlock_find_available_slots` with `require_free` lists only times when the digger and the trailer are free together.' },
      { title: 'Hold it', body: '`slotlock_hold_together` holds the set as one group while the customer confirms.' },
      { title: 'Book all or none', body: '`slotlock_book_together` books every machine in one transaction; if any is taken, nothing is booked and the refusal names it.' },
    ],
    limits: [
      'Slotlock tracks time, not stock levels or delivery routes. Model delivery as buffer time.',
    ],
    example: [
      'A contractor asks for a 3-tonne digger and a trailer for Tuesday and Wednesday. The agent searches with `require_free` and finds both free from Tuesday 07:00, after the digger\'s inspection time from Monday\'s hire.',
      'It holds the pair as one group while the contractor checks with the site manager, then books them together. When another customer later asks for the same digger on Wednesday afternoon, the pool offers a different 3-tonne digger instead, and the inspection time after Wednesday\'s hire stays blocked for the yard.',
    ],
    faq: [
      { q: 'Can a customer book any machine of a type?', a: 'Yes. Book from the pool with `slotlock_book_pool`; members are tried in the pool\'s order.' },
      { q: 'How long can a hire last?', a: 'Up to 3,660 days as one event, so long-term hires are one booking.' },
    ],
  },
  {
    slug: 'clinics',
    name: 'Clinics',
    title: 'Clinic room and clinician booking API for AI agents | Slotlock',
    description:
      'Book a clinician, a treatment room and shared equipment together with AI agents: one transaction, cleaning time kept, no-shows released, and no double bookings.',
    imageAlt: 'Clinics with Slotlock: room, clinician and equipment booked together, or not at all.',
    summary: 'Room, clinician and equipment booked together, or not at all.',
    heading: { soft: 'Room, clinician and equipment.', strong: 'Booked together, or not at all.' },
    lede: 'An appointment needs a person, a room and often a machine at the same time. Slotlock finds when all three are free, holds options while the patient chooses, and books them in one transaction.',
    problem: [
      'Clinic diaries fail at the joins: the clinician is free but the room is not, or the ultrasound is booked twice by two rooms. An assistant that books one and then the other can be beaten in between.',
      'Rooms need cleaning between patients, and a patient who does not arrive should free the room for someone waiting.',
    ],
    resources: [
      'Treatment rooms, each clinician\'s hours and shared equipment such as an ultrasound.',
      'A weekly course of sessions as a [recurring event](/docs/recurring-events/).',
    ],
    rules: [
      '`slotStepMinutes` for appointment starts.',
      '`turnaroundMinutes` for cleaning between patients.',
      '`checkInMinutes` to release a booking nobody checks in to.',
    ],
    agent: [
      { title: 'Find the first joint time', body: '`slotlock_find_available_slots` with `require_free` finds when the clinician, the room and the equipment are all free.' },
      { title: 'Hold a few options', body: 'The agent holds options while the patient chooses, so nobody takes them meanwhile.' },
      { title: 'Book all three', body: '`slotlock_book_together` books them in one transaction, or none of them.' },
    ],
    limits: [
      'Free/busy answers say when a resource is busy, never whose booking it is or what for. Keep clinical notes in your clinical system, not in a booking\'s title.',
      'Where a practice management system owns the diary, Slotlock suits the people building that software.',
    ],
    example: [
      'A patient asks a clinic\'s assistant for an ultrasound appointment next week, after 16:00. The agent searches for times when the sonographer, a scanning room and the ultrasound machine are free together, on the clinic\'s 15-minute steps, and finds three.',
      'It holds the three while the patient chooses. The patient picks Thursday at 16:30; the agent books the sonographer, the room and the machine in one transaction, and the other two options go back on offer. Cleaning time after the appointment is kept free for the room automatically.',
    ],
    faq: [
      { q: 'Where is the data kept?', a: 'On Slotlock Cloud, in the United Kingdom ([privacy notice](/docs/privacy/)). Self-hosted, in your own PostgreSQL.' },
      { q: 'Can a course of sessions be booked at once?', a: 'Yes, as a recurring event; the whole series counts as one booking on the hosted plans.' },
    ],
  },
  {
    slug: 'courts',
    name: 'Courts',
    title: 'Padel and tennis court booking API for AI agents | Slotlock',
    description:
      'Book padel and tennis courts with AI agents: fixed start times, any free indoor court, coaches\' hours, and cancellations offered to the waitlist as holds.',
    imageAlt: 'Courts with Slotlock: padel and tennis on fixed starts, with no-shows offered on.',
    summary: 'Padel and tennis on fixed starts, with no-shows offered on.',
    heading: { soft: 'Padel and tennis on fixed starts.', strong: 'Cancellations go to the next player.' },
    lede: 'Courts sell in fixed blocks and empty courts earn nothing. Slotlock keeps starts on the hour or half hour, books any free court of a kind, and offers freed time to the waitlist in the order players joined.',
    problem: [
      'A club\'s best hours sell out, and a cancellation at short notice usually goes unsold because nobody hears about it in time.',
      'Players book through an app, at the desk and now through assistants. Each one can promise the same court at 19:00.',
    ],
    resources: [
      'Each padel or tennis court, and a pool such as any indoor court.',
      'Coaches\' hours, so a lesson books the coach and the court together.',
      'A weekly league slot as a recurring event.',
    ],
    rules: [
      '`slotStepMinutes` of 60 or 90, with `stepOffsetMinutes` for starts at quarter past.',
      '`checkInMinutes` to release a court nobody claims.',
    ],
    agent: [
      { title: 'Offer the open starts', body: '`slotlock_find_available_slots` lists free starts on the club\'s steps, for one court or the pool.' },
      { title: 'Book or join the waitlist', body: 'A full evening puts the player on the waitlist, through the REST application API with a full key ([join a waitlist](/docs/api/join-waitlist/)).' },
      { title: 'Offer cancellations on', body: 'When a court is freed, the next player in line gets it as a hold, to book or decline.' },
    ],
    limits: [
      'Slotlock books one booking per court at a time. Group classes with several places need a resource for each place.',
    ],
    example: [
      'A player asks the club\'s assistant for an indoor padel court on Thursday at 19:00. Every indoor court is booked, so the agent offers 20:30 and adds the player to the 19:00 waitlist.',
      'At 15:00 on Thursday another group cancels. Slotlock offers the court to the first player on the waitlist as a hold, and the club\'s assistant messages them. They accept, the hold is booked, and the court that would have stood empty is played. Had they declined, the next player in line would have had the offer.',
    ],
    faq: [
      { q: 'Can a lesson book the coach and the court?', a: 'Yes: book both together with `slotlock_book_together`, all or none.' },
      { q: 'Who gets a cancelled court?', a: 'The first player on the waitlist, in join order, as a hold they can book or decline.' },
    ],
  },
  {
    slug: 'garage-service-bays',
    name: 'Garage service bays',
    title: 'Garage service bay scheduling API for AI agents | Slotlock',
    description:
      'Book a service bay, a technician and a courtesy car in one booking with an AI agent on the call, holding the options while the driver decides.',
    imageAlt: 'Garage service bays with Slotlock: bay, technician and courtesy car in one booking.',
    summary: 'Bay, technician and courtesy car in one booking.',
    heading: { soft: 'Bay, technician and courtesy car.', strong: 'In one booking, during the call.' },
    lede: 'A service needs a bay or lift, a qualified technician and often a courtesy car. A voice or chat agent finds when all are free, holds the options while the driver decides, and books them together.',
    problem: [
      'Service desks juggle lifts, technicians\' skills and a small courtesy fleet. Booking them one at a time on a call leaves gaps where another booking slips in.',
    ],
    resources: [
      'Each bay or lift, and technicians\' and testers\' hours.',
      'Courtesy cars as a pool, so any free car will do.',
    ],
    rules: [
      '`slotStepMinutes` for the start times the workshop uses.',
      '`turnaroundMinutes` between jobs on a lift.',
      '`minNoticeMinutes` so nothing is booked for the next ten minutes.',
    ],
    agent: [
      { title: 'Find a joint time', body: 'The agent searches when the bay and a technician are free together, and a courtesy car from the pool.' },
      { title: 'Hold while the driver decides', body: '`slotlock_hold_together` keeps the set for the length of the call.' },
      { title: 'Book it', body: 'The bay and technician book together; the courtesy car books from its pool with `slotlock_book_pool`.' },
    ],
    limits: [
      'Slotlock does not estimate job length or parts; your system decides how long a service takes and asks for that time.',
    ],
    example: [
      'A driver calls about a brake service. The voice agent asks for a bay with a lift and a brakes-qualified technician free together for two hours, plus a courtesy car for the day, and finds Tuesday at 08:30 and Wednesday at 13:00.',
      'It holds both options while the driver checks their diary. The driver picks Wednesday; the agent books the bay and the technician together and a courtesy car from the pool, and Tuesday\'s hold is released. A second caller asking for Wednesday at 13:00 a minute later is offered the next free bay.',
    ],
    faq: [
      { q: 'Does it work with a voice agent?', a: 'Any agent that can call MCP, A2A or REST can book; holds keep the options while the driver thinks.' },
    ],
  },
  {
    slug: 'salons-and-spas',
    name: 'Salons and spas',
    title: 'Salon and spa booking API for AI agents | Slotlock',
    description:
      'Book treatment rooms, therapists and stylists with AI agents: cleaning time built in, couples\' treatments booked as one, and no double-booked chairs.',
    imageAlt: 'Salons and spas with Slotlock: rooms and therapists, with cleaning time built in.',
    summary: 'Rooms and therapists, with cleaning time built in.',
    heading: { soft: 'Rooms and therapists.', strong: 'Cleaning time built in.' },
    lede: 'A treatment needs a therapist and a room, and the room needs resetting after. Slotlock books both together and keeps the reset time out of the diary.',
    problem: [
      'Front desks and booking assistants both sell the same therapist\'s afternoon, and a couples\' treatment needs two therapists and the double room at once.',
    ],
    resources: [
      'Treatment rooms and chairs, therapists\' and stylists\' hours, and machines.',
    ],
    rules: [
      '`turnaroundMinutes` for cleaning and resetting a room.',
      '`slotStepMinutes` for the start times you sell.',
      '`maxAdvanceDays` for how far ahead people can book.',
    ],
    agent: [
      { title: 'Find a time for both', body: 'The agent finds when the therapist and a suitable room are free together.' },
      { title: 'Book the couples\' treatment', body: 'Two therapists and the double room are booked together with `slotlock_book_together`, or none of them.' },
    ],
    limits: [
      'Slotlock books time, not services or prices; your system maps a treatment to how long it takes and what it needs.',
    ],
    example: [
      'Two guests ask a spa\'s assistant for a couples\' massage on Saturday afternoon. The agent searches for times when two therapists and the double treatment room are free together, with the room\'s reset time after the previous booking already kept out.',
      'It offers 14:00 and 16:30, holds both while the guests decide, and books 16:30 for the two therapists and the room in one transaction. A single-guest booking made at the front desk for one of those therapists at 16:30 a moment later is refused, so nobody is promised the same hour twice.',
    ],
    faq: [
      { q: 'Can clients rebook a cancelled slot?', a: 'Yes: freed time can go to the waitlist as a hold for the next client.' },
    ],
  },
  {
    slug: 'rooms-and-desks',
    name: 'Rooms and desks',
    title: 'Meeting room and desk booking API for AI agents | Slotlock',
    description:
      'Let AI agents book meeting rooms, desks and phone booths: opening hours enforced, rooms nobody checks in to released, and freed rooms offered to the waitlist.',
    imageAlt: 'Rooms and desks with Slotlock: rooms nobody checks in to go back on offer.',
    summary: 'Rooms nobody checks in to go back on offer.',
    heading: { soft: 'Rooms, desks and booths.', strong: 'Unclaimed ones go back on offer.' },
    lede: 'Assistants book rooms for meetings they arrange. Slotlock enforces opening hours, releases rooms nobody checks in to, and offers them to whoever is waiting.',
    problem: [
      'Office rooms are booked and then left empty, while teams who need one cannot find it. Room calendars live in Outlook or Google, and assistants need to see them before they book.',
    ],
    resources: [
      'Each room, desk or phone booth, with pools by type or floor.',
      'Room calendars from Outlook or Google, brought in by your adapter as iCalendar busy time.',
    ],
    rules: [
      '`enforceHours` so nothing is booked outside opening hours.',
      '`checkInMinutes` to release a room nobody claims; the waitlist offers it on.',
    ],
    agent: [
      { title: 'Find a room of a kind', body: '`slotlock_get_pool_availability` finds a free room on the floor or of the size asked for.' },
      { title: 'Book it', body: '`slotlock_book_pool` books the first free room of the pool.' },
    ],
    limits: [
      'Slotlock does not sync Google or Microsoft calendars by itself; your adapter brings their feeds in.',
    ],
    example: [
      'An assistant arranging a meeting for six asks for a room on the third floor on Monday at 10:00. The agent checks the third-floor pool, finds two free rooms of the right size, and books the first with the pool.',
      'On Monday nobody checks in by 10:15, so the room is released and offered to the team waiting for a room at that time. The room calendar imported from the office system shows its existing meetings as busy, and the agent never offers a time that feed has not proven free.',
    ],
    faq: [
      { q: 'Is it a replacement for a scheduling link?', a: 'No. For meetings between two people a scheduling page does that already; Slotlock books the rooms and things those meetings need.' },
    ],
  },
  {
    slug: 'field-service',
    name: 'Field service',
    title: 'Field service scheduling API for AI agents | Slotlock',
    description:
      'Schedule technicians and vans with AI agents: hold three windows when a qualified technician and the right van are free, let the customer pick, tell dispatch.',
    imageAlt: 'Field service with Slotlock: technician and van, held while the customer chooses.',
    summary: 'Technician and van, held while the customer chooses.',
    heading: { soft: 'Technician and van.', strong: 'Held while the customer chooses.' },
    lede: 'A visit needs a technician with the right skill and a van with the right kit. Slotlock holds the windows where both are free, lets the customer pick one, and tells your dispatch system.',
    problem: [
      'Customers are offered windows that turn out to be taken, because the technician\'s diary and the van\'s are checked separately and the offer is not held.',
    ],
    resources: [
      'Technicians\' hours, grouped by skill.',
      'Vans and specialist kit.',
    ],
    rules: [
      '`bufferBeforeMinutes` and `turnaroundMinutes` for travel between jobs.',
      '`minNoticeMinutes` for how soon a visit can be booked.',
    ],
    agent: [
      { title: 'Hold three windows', body: 'The agent holds three windows where a qualified technician and the right van are free together.' },
      { title: 'Let the customer pick', body: 'The customer picks one; the agent books it and the other holds are released.' },
      { title: 'Tell dispatch', body: '[Webhooks](/docs/api/list-changes/) send each booking and change to your dispatch system as CloudEvents.' },
    ],
    limits: [
      'Slotlock does no routing. Model travel as fixed buffer time, and let your routing tool decide the order of visits.',
    ],
    example: [
      'A customer reports a boiler fault and asks for a visit this week. The agent looks for windows where a gas-qualified technician and a van carrying the right parts are free together, allowing travel time before each job, and holds three windows.',
      'The customer picks Thursday morning. The agent books the technician and the van together, the other two windows are released, and a webhook tells the dispatch system, which adds the visit to Thursday\'s route. If the customer had stopped replying, the holds would have lapsed and gone back to the next caller.',
    ],
    faq: [
      { q: 'Can I use it with a route optimiser?', a: 'Yes: Slotlock decides what is free and keeps bookings from overlapping; the optimiser decides the order of the day ([Scaling](/docs/scaling/)).' },
    ],
  },
];

const list = (items: string[]): Block => ({ kind: 'list', items });

function useCasePage(u: UseCase): MarketingPage {
  return {
    path: `/use-cases/${u.slug}/`,
    title: u.title,
    description: u.description,
    image: `use-case-${u.slug}`,
    imageAlt: u.imageAlt,
    crumbs: [
      { name: 'Use cases', path: '/use-cases/' },
      { name: u.name, path: `/use-cases/${u.slug}/` },
    ],
    hero: {
      topic: `${u.name}: booking for AI agents`,
      heading: u.heading,
      lede: u.lede,
      actions: [
        { label: 'Start free', href: SIGN_IN_URL },
        { label: 'Modelling guide', href: '/docs/use-cases/' },
      ],
    },
    sections: [
      {
        id: 'problem',
        topic: 'The problem',
        heading: { soft: 'Several channels, one calendar.', strong: 'Only one booking may win.' },
        blocks: [{ kind: 'text', paragraphs: u.problem }],
      },
      {
        id: 'model',
        topic: 'How to model it',
        heading: { soft: 'Resources for what is booked,', strong: 'rules for how.' },
        blocks: [
          list(u.resources),
          { kind: 'table', caption: 'Booking rules that matter', columns: ['Rule', ''], rows: u.rules.map((rule) => {
            const [name, ...rest] = rule.split(' ');
            return [name ?? '', rest.join(' ')];
          }) },
          { kind: 'links', items: [{ label: 'Booking rules', href: '/docs/booking-rules/' }, { label: 'Concepts', href: '/docs/concepts/' }] },
        ],
      },
      {
        id: 'agent',
        topic: 'What the agent does',
        heading: { soft: 'Find, hold, book.', strong: 'Every write checked by the database.' },
        lede: 'Each write goes through a PostgreSQL exclusion constraint, so a race between two agents, or an agent and your own site, ends in one booking and one refusal the agent can act on.',
        blocks: [
          { kind: 'steps', items: u.agent },
          { kind: 'links', items: [{ label: 'Tools reference', href: '/docs/tools/' }, { label: 'MCP server', href: '/mcp-server/' }] },
        ],
      },
      {
        id: 'example',
        topic: 'An example',
        heading: { soft: 'One booking,', strong: 'from the first message to the last.' },
        blocks: [{ kind: 'text', paragraphs: u.example }],
      },
      {
        id: 'limits',
        topic: 'What it does not do',
        heading: { soft: 'It books time.', strong: 'The rest stays in your system.' },
        blocks: [list(u.limits)],
      },
      {
        id: 'faq',
        topic: 'FAQ',
        heading: { soft: 'Questions', strong: `about ${u.name.toLowerCase()}.` },
        blocks: [
          { kind: 'faq', items: u.faq },
          {
            kind: 'links',
            items: USE_CASES.filter((other) => other.slug !== u.slug)
              .slice(0, 3)
              .map((other) => ({ label: other.name, href: `/use-cases/${other.slug}/` })),
          },
        ],
      },
    ],
    closing: {
      heading: { soft: 'Connect an agent today.', strong: 'Start free on Slotlock Cloud.' },
      actions: [
        { label: 'Start free', href: SIGN_IN_URL },
        { label: 'Pricing', href: '/pricing/' },
      ],
    },
  };
}

export const useCasePages = USE_CASES.map(useCasePage);

export const useCasesHub: MarketingPage = {
  path: '/use-cases/',
  title: 'Booking API use cases: rental, clinics, courts | Slotlock',
  description:
    'What Slotlock books: vehicles, machines, rooms, courts, bays and staff hours. One page per industry, with the resources, rules and agent calls each needs.',
  image: 'use-cases',
  imageAlt: 'Slotlock use cases: anything booked by the hour or the day.',
  crumbs: [{ name: 'Use cases', path: '/use-cases/' }],
  pageType: 'CollectionPage',
  hero: {
    topic: 'Use cases',
    heading: { soft: 'Anything booked by the hour or the day.', strong: 'Built first for car rental.' },
    lede: 'Slotlock books things and staff hours that take one booking at a time: a van, a court, a treatment room, a technician\'s afternoon. Pick your business for what to make a resource, which rules matter and what the agent does.',
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Modelling guide', href: '/docs/use-cases/' },
    ],
  },
  sections: [
    {
      id: 'industries',
      topic: 'Industries',
      heading: { soft: 'Eight businesses,', strong: 'one calendar engine.' },
      blocks: [
        {
          kind: 'cards',
          items: USE_CASES.map((u) => ({ title: u.name, body: u.summary, href: `/use-cases/${u.slug}/` })),
        },
      ],
    },
    {
      id: 'how',
      topic: 'How every business is modelled',
      heading: { soft: 'Resources, rules and pools.', strong: 'The same three ideas everywhere.' },
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Make each bookable thing a resource', body: 'A van, a court, a treatment room or a technician\'s hours: each is a calendar with its own time zone and weekly hours, so its rules follow its own clock.' },
            { title: 'Add the rules of the business', body: 'Notice before a booking, how far ahead, start times on fixed steps, cleaning or travel time between bookings, and release when nobody checks in ([booking rules](/docs/booking-rules/)).' },
            { title: 'Group what customers book by kind', body: 'A pool such as any SUV or any indoor court lets an agent book whichever member is free, and sells out at its size.' },
            { title: 'Let agents find, hold and book', body: 'Agents search with each resource\'s rules applied, hold options while a person picks, and book; PostgreSQL refuses every overlap, whichever channel it comes from.' },
          ],
        },
      ],
    },
    {
      id: 'also',
      topic: 'Also a fit',
      heading: { soft: 'Docks, tee times and studios', strong: 'book the same way.' },
      blocks: [
        list([
          'Loading docks: doors by type as pools, turnaround for unloading, check-in at the gate. Over A2A, a carrier\'s agent can book with the warehouse\'s agent.',
          'Golf tee times: starts every few minutes with `slotStepMinutes`, a booking window with `maxAdvanceDays`, and waitlists for cancellations.',
          'Event venues and studios: holds made through the REST API last days, not minutes, so a date can wait while a client decides.',
        ]),
      ],
    },
    {
      id: 'not',
      topic: 'Where it does not fit',
      heading: { soft: 'Some bookings', strong: 'belong elsewhere.' },
      blocks: [
        list([
          'Restaurant tables: tables are combined and turned by covers, and reservation networks own the demand.',
          'Hotels and holiday lets: nights are sold by rate through channel managers.',
          'Meetings between two people: a scheduling link does that already.',
          'Classes and group places: Slotlock books a resource once at a time, so each place needs a resource of its own.',
        ]),
      ],
    },
  ],
  closing: {
    heading: { soft: 'Your business not here?', strong: 'If it books one thing at a time, it fits.' },
    actions: [
      { label: 'Start free', href: SIGN_IN_URL },
      { label: 'Read the docs', href: '/docs/' },
    ],
  },
};
