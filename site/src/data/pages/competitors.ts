// The comparisons that name another product. Every claim about it comes from its own docs or
// pages, listed under `sources` and checked on the date in `checked`; "not documented" means its
// docs say nothing, not that it cannot. Re-check each page when its date is a quarter old.
import facts from '../../generated/facts.json';
import type { Comparison } from './compare';

const CHECKED = '11 November 2026';
const plans = ((facts as { plans?: { id: string; monthly: number }[] | null }).plans ?? []).filter((p) => p.monthly > 0);
const paid = plans.map((p) => `$${p.monthly}`).join(' or ');

/** Slotlock's side of the rows every comparison shares, from the docs. */
const US = {
  builtFor: 'Resources that take one booking at a time: vehicles, rooms, courts, machines, staff hours',
  resources: 'Every resource is a calendar with its own time zone, hours and booking rules, and pools book any one of a class',
  holds: `Up to ${facts.holdSlotsMax} candidates as one group, ${facts.holdTtlMin} to ${facts.holdTtlMax} seconds over MCP or up to ${facts.maxHoldDays} days over REST, expiring on the database clock`,
  race: 'A PostgreSQL exclusion constraint admits one; the other gets `overlap`, with the conflict as data',
  mcp: `${facts.toolCount} tools, hosted or self-hosted, with an MCP App to pick a slot in the chat`,
  a2a: `A2A ${facts.a2a} skills and an agent card`,
  licence: `${facts.license}: the server, the dashboard and the clients`,
  pricing: `A free plan, paid plans at ${paid} a month, or self-host at no charge`,
  sync: 'Not by itself: your adapter imports feeds as iCalendar busy time, and unread time stays uncertain',
};

const ROWS = (them: Record<keyof typeof US, string>): [string, string, string][] => [
  ['Built for', them.builtFor, US.builtFor],
  ['Bookable resources', them.resources, US.resources],
  ['Holds', them.holds, US.holds],
  ['Two bookings for one slot at once', them.race, US.race],
  ['MCP server', them.mcp, US.mcp],
  ['A2A', them.a2a, US.a2a],
  ['Licence', them.licence, US.licence],
  ['Pricing', them.pricing, US.pricing],
  ['Calendar sync', them.sync, US.sync],
];

export const COMPETITORS: Comparison[] = [
  {
    slug: 'cal-com',
    name: 'Cal.com',
    title: 'Slotlock vs Cal.com: booking resources or scheduling meetings',
    description:
      'Cal.com schedules meetings between people; Slotlock books vans, rooms and machines for AI agents. Holds, double booking, MCP and licences, with sources.',
    heading: { soft: 'Cal.com schedules meetings with people.', strong: 'Slotlock books the things agents sell.' },
    lede: 'Both have an MCP server and both let an agent book. Cal.com is built around people\'s availability and meeting types; Slotlock around resources that take one booking at a time, with the database refusing every overlap.',
    summary: [
      'Cal.com calls itself scheduling infrastructure: event types, hosts, round-robin and collective events, routing forms and hosted booking pages, with Google, Apple and Outlook calendar sync and video links. Its official MCP server runs hosted at mcp.cal.com or locally, with 82 tools.',
      'Since April 2026 Cal.com is closed source. Its open code continues as Cal.diy under the MIT licence, without teams, organizations or routing forms, and its README recommends it for personal, non-production use.',
    ],
    rows: ROWS({
      builtFor: 'Meetings between people: event types, hosts, round robin and collective events',
      resources: 'No resource type in the API; its blog describes booking a room by connecting the room\'s calendar to a room account',
      holds: 'Slot reservations, 5 minutes by default and longer for signed-in callers; how expiry is enforced is not documented',
      race: 'Availability is checked when a booking is created, and `allowConflicts` can skip it; concurrent writes are not documented',
      mcp: 'Official: hosted with OAuth, or local over stdio; 82 tools',
      a2a: 'None found',
      licence: 'Closed source since April 2026; the open fork Cal.diy is MIT',
      pricing: 'Free for one user; teams and organizations per user per month',
      sync: 'Google, Apple and Outlook calendars, with video links',
    }),
    chooseThem: [
      'People book meetings with people, and you want booking pages, round robin, routing forms and video links.',
      'Your users\' calendars live in Google, Apple or Outlook and must stay in sync.',
    ],
    chooseUs: [
      'Agents book vans, rooms, courts, machines or staff hours that take one booking at a time.',
      'Two agents or channels may race for one slot, and the loser needs an answer it can act on.',
      'You want to read and run the code yourself.',
    ],
    together: ['Cal.com can own people\'s meetings while Slotlock owns the resources those meetings or rentals need.'],
    checked: CHECKED,
    sources: [
      { label: 'Cal.com', href: 'https://cal.com/' },
      { label: 'Cal.com API v2: reserve a slot', href: 'https://cal.com/docs/api-reference/v2/slots/reserve-a-slot' },
      { label: 'Cal.com API v2: create a booking', href: 'https://cal.com/docs/api-reference/v2/bookings/create-a-booking' },
      { label: 'Cal.com MCP server', href: 'https://cal.com/docs/mcp-server' },
      { label: 'Cal.com v6.4: closed source', href: 'https://cal.com/blog/calcom-v6-4' },
      { label: 'Cal.diy: from AGPL 3.0 to MIT', href: 'https://cal.com/blog/cal-diy-open-source-to-closed-source' },
      { label: 'Cal.com on room booking', href: 'https://cal.com/blog/best-room-booking-software' },
      { label: 'Cal.com pricing', href: 'https://cal.com/pricing' },
    ],
  },
  {
    slug: 'cronofy',
    name: 'Cronofy',
    title: 'Slotlock vs Cronofy: resource booking or calendar sync',
    description:
      'Cronofy syncs calendars and schedules meetings inside other products; Slotlock books resources for AI agents. Rooms, holds, double booking and MCP compared.',
    heading: { soft: 'Cronofy connects people\'s calendars.', strong: 'Slotlock is the calendar of the things.' },
    lede: 'Cronofy adds calendar sync and scheduling to other products across Google, Microsoft and Apple. Slotlock is a calendar engine of its own, for resources booked by agents, where a race for a slot has one winner.',
    summary: [
      'Cronofy adds calendar sync, scheduling and meeting transcription to other products on one integration, across Google, Microsoft 365, Exchange and Apple calendars. Rooms and equipment come from Google or Microsoft directories, and Application Calendars are calendars Cronofy hosts with no provider behind them; one documented use is tracking workshop equipment.',
      'Its official MCP server is hosted, needs a Scheduler account, and offers three tools: create a scheduling link, suggest times to meet, and choose a suggested time.',
    ],
    rows: ROWS({
      builtFor: 'Calendar sync and scheduling for meetings between people, inside other products',
      resources: 'Rooms and equipment from Google or Microsoft directories, room pools in availability queries, and hosted Application Calendars',
      holds: 'Not documented; tentative is a transparency value, with no expiry',
      race: 'Not documented: creating an event answers `202 Accepted`, with no conflict check described',
      mcp: 'Official, hosted, with a Scheduler account; 3 tools for scheduling links and suggested times',
      a2a: 'None found',
      licence: 'Proprietary, hosted in Cronofy\'s data centres',
      pricing: 'API plans metered on synchronised calendar accounts, listed from $819 a month; Scheduler per seat',
      sync: 'Google, Microsoft 365, Exchange and Apple calendars',
    }),
    chooseThem: [
      'Your product schedules meetings in people\'s own Google, Microsoft or Apple calendars and must keep them in sync.',
      'You need ISO 27001, SOC 2 or a HIPAA BAA from your calendar vendor, or meeting transcription.',
    ],
    chooseUs: [
      'The calendar belongs to a resource, not a person: a van, a court, a bay, a machine.',
      'Agents hold options while a person picks, and every write must be refused on overlap.',
      'You want to self-host, or start on a free plan.',
    ],
    together: ['Cronofy can sync people\'s calendars while Slotlock books the resources, with their busy time imported as iCalendar.'],
    checked: CHECKED,
    sources: [
      { label: 'Cronofy', href: 'https://www.cronofy.com/' },
      { label: 'Cronofy: scheduling', href: 'https://docs.cronofy.com/developers/scheduling/' },
      { label: 'Cronofy: meeting rooms', href: 'https://docs.cronofy.com/developers/scheduling/meeting-rooms/' },
      { label: 'Cronofy: Application Calendars', href: 'https://docs.cronofy.com/developers/calendars-events/application-calendars/' },
      { label: 'Cronofy API: upsert event', href: 'https://docs.cronofy.com/api-reference/calendar-control/calendar-events/upsert-event/' },
      { label: 'Cronofy MCP server', href: 'https://docs.cronofy.com/developers/mcp-server/' },
      { label: 'Cronofy plans and pricing', href: 'https://docs.cronofy.com/developers/plans-pricing/' },
      { label: 'Cronofy pricing', href: 'https://www.cronofy.com/pricing' },
    ],
  },
  {
    slug: 'nylas',
    name: 'Nylas',
    title: 'Slotlock vs Nylas: resource booking or a unified calendar API',
    description:
      'Nylas unifies email, calendar and contacts across providers; Slotlock books resources for AI agents with no double bookings. Holds, rooms and MCP compared.',
    heading: { soft: 'Nylas reaches people\'s inboxes and calendars.', strong: 'Slotlock books the resources.' },
    lede: 'Nylas is one API across hundreds of email and calendar providers, with a scheduler for meetings. Slotlock is a booking engine for resources, where the database refuses the second booking.',
    summary: [
      'Nylas is one API for more than 250 email, calendar and meeting providers. Its Scheduler handles one-to-one, collective, round-robin and group meetings, Notetaker records meetings, and its hosted MCP server has 38 tools across email, calendar, contacts and Notetaker.',
      'Rooms and equipment can be booked where a Google Workspace or Microsoft 365 directory holds them; a taken room is declined by the provider and shows in the event\'s resource status, not as an error. Nylas documents that its Scheduler path prevents double bookings, and that its Calendar API has no atomic conditional create, so the application must guard the slot.',
    ],
    rows: ROWS({
      builtFor: 'Email, calendar and contacts across providers, and meetings between people',
      resources: 'Rooms and equipment from a Workspace or Microsoft 365 directory; a taken room is declined by the provider, not refused at create',
      holds: 'No timed hold with expiry documented; Nylas\'s own guide says the app owns hold status and expiry',
      race: 'Scheduler: one success and one rejection. Calendar API: no atomic conditional create, so guard the slot yourself',
      mcp: 'Official, hosted in the US and the EU; 38 tools',
      a2a: 'None found',
      licence: 'Hosted API; scheduling pages can be embedded in your app',
      pricing: 'A free plan with 5 connected accounts; paid plans per connected account',
      sync: 'More than 250 email, calendar and meeting providers',
    }),
    chooseThem: [
      'Your product needs people\'s email, calendars and contacts from many providers through one API.',
      'You want hosted scheduling pages, round robin and meeting recording.',
    ],
    chooseUs: [
      'Agents book resources that are not in anyone\'s Workspace directory: a fleet, courts, bays, kit.',
      'You need holds that lapse on their own and a refusal at write time, not a decline later.',
      'You want to self-host the engine.',
    ],
    together: ['Nylas can read people\'s calendars; your adapter passes their busy time to Slotlock, which books the resources.'],
    checked: CHECKED,
    sources: [
      { label: 'Nylas', href: 'https://www.nylas.com/' },
      { label: 'Nylas Scheduler', href: 'https://developer.nylas.com/docs/v3/scheduler/' },
      { label: 'Nylas: book room resources', href: 'https://developer.nylas.com/docs/cookbook/calendar/book-room-resources/' },
      { label: 'Nylas: prevent double booking', href: 'https://developer.nylas.com/docs/cookbook/scheduler/prevent-double-booking/' },
      { label: 'Nylas: holds and confirmation', href: 'https://cli.nylas.com/ai-answers/calendar-booking-hold-and-confirmation-workflow.md' },
      { label: 'Nylas MCP server', href: 'https://developer.nylas.com/docs/dev-guide/mcp/' },
      { label: 'Nylas pricing', href: 'https://www.nylas.com/pricing/' },
    ],
  },
  {
    slug: 'google-calendar-api',
    name: 'the Google Calendar API',
    title: 'Slotlock vs the Google Calendar API for bookings',
    description:
      'Can the Google Calendar API stop double bookings? Rooms decline overlaps, other calendars do not. How it compares with Slotlock for agents that book resources.',
    heading: { soft: 'Google Calendar holds people\'s days.', strong: 'Slotlock refuses the second booking.' },
    lede: 'Many booking agents start by writing events into Google Calendar. It is the calendar people already have, but outside room resources it does not refuse an overlapping event, and nothing expires a tentative one.',
    summary: [
      'The Google Calendar API is a REST API over Google Calendar. Workspace admins can create resources, conference rooms and "other" resources such as a company car, which an event books by inviting them as attendees. A room declines an event that overlaps one it has accepted.',
      'For other calendars, inserting an event documents no overlap check, and a tentative event has nothing to expire it. An official Calendar MCP server is in Developer Preview.',
    ],
    rows: ROWS({
      builtFor: 'People\'s calendars in Google Calendar',
      resources: 'Workspace resources: rooms and "other" resources such as a company car, booked as attendees',
      holds: 'Tentative events, with nothing to expire them',
      race: 'Rooms decline an overlapping event, though admins can accept double bookings by hand; inserting into other calendars documents no overlap check',
      mcp: 'Official, in Developer Preview: list, search, create, update and delete events, and suggest a time',
      a2a: 'Not documented',
      licence: 'Proprietary, hosted by Google',
      pricing: 'No additional cost for standard use, within quotas',
      sync: 'It is the calendar; other providers are not part of it',
    }),
    chooseThem: [
      'Your team lives in Google Workspace and books meeting rooms for its own meetings.',
      'The booking must appear in people\'s own Google calendars.',
    ],
    chooseUs: [
      'Agents sell or allocate resources to customers, not invitations to colleagues.',
      'A race for a slot must end in one booking, with holds that lapse on time.',
      'Resources need booking rules: notice, steps, turnaround and opening hours.',
    ],
    together: ['Import a Google calendar\'s busy time into Slotlock through your adapter, so a resource is never booked over it ([External calendars](/docs/external-calendars/)).'],
    checked: CHECKED,
    sources: [
      { label: 'Google Calendar API overview', href: 'https://developers.google.com/workspace/calendar/api/guides/overview' },
      { label: 'Events: insert', href: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/insert' },
      { label: 'Freebusy: query', href: 'https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query' },
      { label: 'Google Workspace: structured resources', href: 'https://knowledge.workspace.google.com/admin/calendar/use-google-calendar-structured-resources' },
      { label: 'Google Workspace Updates: rooms decline overlaps', href: 'https://workspaceupdates.googleblog.com/2019/04/avoid-double-booking-rooms-in-calendar.html' },
      { label: 'Google Calendar MCP server', href: 'https://developers.google.com/workspace/calendar/api/v3/reference/mcp' },
      { label: 'Google Calendar API quotas', href: 'https://developers.google.com/workspace/calendar/api/guides/quota' },
    ],
  },
];
