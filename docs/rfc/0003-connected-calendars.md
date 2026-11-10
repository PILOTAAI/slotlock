# RFC 0003: Connected calendars, write-back and meeting links

| | |
| --- | --- |
| Status | Proposed |
| Target | 0.7.0 for the core changes; the connector ships after, provider by provider |
| Decision | GOVERNANCE.md: changes the data model, the agent contract, key scopes and a published boundary (provider credentials), and the hosted privacy notice; needs the maintainer's approval and an independent, non-AI security review of this RFC and of every PR marked T2 below |

## Summary

People want to connect the calendars they already use (Google, Microsoft 365 and Outlook.com,
iCloud and other CalDAV servers, and Calendly) so that Slotlock counts their existing meetings as
busy, puts what it books on their calendar, and gives the meeting a Google Meet, Teams or Zoom link.

This RFC proposes two parts:

- **Core gains four things and no credentials.** Busy time recorded with coverage, outside the
  EXCLUDE constraint. Freshness judged per source in seconds. A rule that a booking's calendars
  were read again after its hold was placed. Write-back state and a meeting link on events. Core
  still makes no network call and holds no provider credential (CONTRIBUTING.md).
- **A separate connector holds the credentials.** It does the OAuth, sync, write-back and link
  creation, and talks to core only through the application API with a new, narrow `sync` key
  scope. Self-hosters may run it; hosted Slotlock runs it for its users.

Slotlock builds the provider integrations itself. No unified-API vendor goes into the open-source
package.

No provider lets anyone write "only if this slot is still free", and no provider's change
notifications are reliable. So this RFC narrows the window in which a booking made elsewhere can
collide with one made through Slotlock, and reports every collision it finds. It does not claim to
remove that window.

## Where 0.6.3 stands

| | Today | Gap |
| --- | --- | --- |
| Coverage | Per tenant, resource and source: window, revision, `observed_at`, last error, `coverage.stale`; `PUT /v1/resources/{id}/coverage/{source}` | Records *that* a calendar was read, not what was busy in it |
| External busy time | Free/busy and `bookingJudge` read busy time only from `slotlock.reservations`; `normalizeExternalCalendarChange` produces changes nothing stores | Imported as reservations (`createExternalReservation`), two overlapping external events, or one over a booking, are refused as `overlap`; each counts against `tenant_reservations` (100,000) and leaves a tombstone kept until the tenant is erased |
| Certainty | `requireCertain` requires every recorded source, fresh within `CERTAIN_COVERAGE_MAX_AGE_MS` (24 hours, `src/store.ts`) | A day is too coarse for a live calendar; recording the same revision again is a no-op, so `observed_at` moves only when the revision does |
| Holds | Agents hold 30-900 s (`slotlock_hold_slots`) and book with `hold_id`; `hold.created` is on the feed; webhooks are delivered every 2 s by default (`src/webhooks.ts`) | Nothing proves a calendar was read after the hold |
| Several people | `slotlock_book_together` books 2-20 resources, all or none | It takes no organizer, attendees or hold, and its events share no identifier, so they cannot become one invitation |
| Events | Title, description, location, organizer, attendees, reminders, recurrence; iCalendar and iTIP export | No meeting-link field; no record of a copy on an outside calendar |
| Secrets | `src/assistant.ts` seals provider keys with AES-256-GCM under an HKDF-derived key, bound to the tenant | Nothing for OAuth tokens |
| Boundary | README: "Provider adapters (Google, Microsoft, CalDAV) stay in your application, with their credentials"; production checklist item 4; CONTRIBUTING.md: "Do not add provider credentials, product-specific authorization, or network calls to the core"; RFC 0002 P2-4 | Hosted Slotlock cannot offer "connect your calendar" without someone holding credentials |

## Goals

1. A person connects a Google or Microsoft account from the dashboard, chooses which calendars
   count, and from then on those calendars' busy time blocks their resource.
2. Time Slotlock has not read recently is unproven, never free: today's rule, judged in seconds.
3. A booking made through Slotlock appears on the organizer's calendar, invitations go to the other
   people, and the meeting carries a Meet, Teams or Zoom link when one was asked for and can be
   made.
4. A collision Slotlock could not prevent (a meeting accepted elsewhere between Slotlock's last read
   and its write) is reported within one sync round, never left silent.
5. Agents never see the content of a connected calendar: only busy intervals.
6. Core holds no provider credential and makes no network call. A deployment that does not run the
   connector sees no change in behaviour.

## Non-goals

- Mirroring calendars: Slotlock does not import titles, descriptions, locations or attendees of
  outside events.
- Treating unread time as free, under any setting (RFC 0002's non-goal stands).
- Exchange on-premises and EWS. EWS in Exchange Online is switched off tenant by tenant from
  1 October 2026 and fully on 1 April 2027, and Graph has not reached hybrid on-premises mailboxes
  since July 2023. Such a mailbox is reported as unreadable, so its time is unproven.
- Sending email from Slotlock. The organizer's provider sends invitations; iTIP by email for
  organizers with no connected calendar can come later.
- Room and resource mailboxes in the first version. Exchange accepts or declines a room
  asynchronously, so a room needs a "pending" state of its own.
- A unified-API vendor inside the Apache-2.0 package.

## Design

### Two components

```text
         Google, Microsoft, CalDAV, Calendly, Zoom
                   ▲
                   │ OAuth, sync, push, write-back, links
                   ▼
┌────────────────────────────────────┐  sync key   ┌────────────────────────────────────┐
│ Connector (separate process)       │────────────►│ Core (slotlock serve, the library) │
│ sealed tokens, provider ids,       │             │ busy blocks and coverage, rules,   │
│ sync tokens, channels, destination │◄────────────│ holds, EXCLUDE constraint, events, │
│ calendars, in its own schema       │  webhooks   │ conflicts, write-back state, feed  │
└────────────────────────────────────┘             └──────────────────┬─────────────────┘
                                                                      │ MCP, A2A, REST
                                                                    agents
```

The connector is a separate package in this repository (working name `slotlock-connect`). It has
its own process, PostgreSQL schema, database role and image. It reaches core only through the
application API, with one `sync` key per tenant it serves, and hears about holds and events through
that tenant's webhooks. Everything that identifies a provider object (event ids, iCalendar UIDs,
sync tokens, channel and subscription ids, the destination calendar) stays in the connector's
schema. Core stores intervals, opaque source names and states.

### Busy blocks on coverage (core, T2)

`PUT /v1/resources/{id}/coverage/{source}` (`recordCalendarCoverage`) takes an optional `busy`
list: at most 2,000 half-open intervals inside the window, which core merges.

- `busy` absent: today's behaviour. Coverage only; the source's blocks are untouched.
- `busy: []`: the source is free across the window.
- `busy` present: in the transaction that already locks the coverage row `FOR UPDATE` and checks
  the revision, core deletes all of the source's blocks, inserts the new ones and advances coverage.
  It then looks for bookings, live holds and opaque event occurrences on the resource that the new
  blocks overlap, and records an `external.conflict` change for each. A conflict is never refused:
  the outside meeting has already happened elsewhere.

Blocks live in a new table, `slotlock.calendar_busy` (tenant, resource, source, `tstzrange`), with:

- a GiST index and no EXCLUDE constraint;
- forced, fail-closed row-level security like `calendar_coverage`;
- deletion with their coverage row;
- a tenant limit of their own (`tenant_busy`, proposed 500,000).

They hold no identifier and no text. A source with more than 2,000 intervals in its window records
a shorter window, and the time beyond it is unproven, as with any partial coverage.

What a block does:

- **Blocks writes.** Every booking write (hold, reservation, event, bundle, pool) refuses time in a
  block, as `overlap` with the source's opaque `source_id` (`src_…`) in place of a reservation id.
  Agents already know what `overlap` means.
- **Counts as busy.** Free/busy, `listBusy` and slot search fold blocks into busy time. Known busy
  time stays busy even after its source goes stale; staleness adds uncertainty, never free time.
- **Announces changes.** A replacement that changes a source's blocks records `busy.changed` (ids
  only), so live updates announce it.

**Serialization.** A booking and a replacement must never both commit without seeing each other.
Under READ COMMITTED a plain read cannot guarantee that, and `bookingJudge` reads coverage with a
plain `SELECT` today.

- Booking writes take `FOR SHARE` on the resource's coverage rows before they check blocks, in
  resource order, as bundles already order their resources.
- A replacement holds `FOR UPDATE` on its own row.
- So either the booking sees the new blocks and is refused, or the replacement sees the booking and
  reports a conflict.
- Only resources with coverage rows pay the cost.

**Disconnection fails closed.**

- A source whose connection is lost keeps its coverage row and its blocks. It stops advancing, goes
  stale, and its time becomes unproven under `requireCertain`.
- Deleting the coverage row (`DELETE /v1/resources/{id}/coverage/{source}`) is the only way to stop
  requiring a source. That stays a deliberate act by a person, never the connector's response to an
  error.

### Freshness in seconds (core, T1)

Coverage gains two optional fields, set by whoever records it:

- **`max_age_seconds`** (60 to 86,400). Free/busy and `requireCertain` judge the source stale after
  the lesser of this and the 24-hour ceiling. Without it, nothing changes.
- **`live`** (boolean). The recorder can read this source again on demand: true for Google,
  Microsoft and CalDAV, false for ICS feeds and Calendly.

The connector records the next revision after every completed sync round, even when nothing
changed, so `observed_at` always means "last completed read", never "last notification".

### Read again after the hold (core, T2)

A new booking rule, **`confirmAfterRead`**, is opt-in like the rest and set per resource, pool or
tenant. On a resource with it:

1. A booking must come from a hold: `hold_id` or a hold group for agents, a hold confirm in the
   application API. A direct write is refused with `booking_rule_hold_required`.
2. Every required source marked `live` must have been observed after the hold was created.
   Otherwise the booking is refused with `booking_rule_read_pending`, which names those sources and
   is retryable. Sources not marked `live` are judged on ordinary freshness.

The connector listens for `hold.created` and runs a sync round on each live source of the held
resource: Google `events.list` with its sync token, Graph `calendarView/delta`, a CalDAV
`sync-collection` or CTag check. It records the result, which raises `observed_at` past the hold.

The target is a re-read within 2 seconds at the 95th percentile, after the 2-second webhook pass.
That figure is a goal, not a measurement. Agents booking resources with this rule should hold for at
least 60 seconds. If a provider is throttling (Graph's `Retry-After`) and the source stays unread,
the booking is refused rather than let through.

The proof is data in the booking's transaction, not a call core makes. That is the only way to keep
both CONTRIBUTING.md's rule and the guarantee that the database, not the agent, decides.

### Write-back and meeting links (core T2, connector)

Agent-facing changes:

- `slotlock_create_event`, `slotlock_update_event` and `slotlock_book_together` take an optional
  `conference`: `none` (the default), `auto`, `google_meet`, `microsoft_teams` or `zoom`. The
  request is part of the event and is revisioned with it.
- The event output gains `conference`: what was requested, the provider, a status (`pending`,
  `ready`, `failed` or `unavailable`) and `join_url`.
- The event output gains `writeback`: `not_applicable`, `pending`, `written` or `failed`, with an
  error code.
- Export writes RFC 7986 `CONFERENCE` once a link is ready.

The connector's results go in a side table keyed by event, outside the event's revision, so a
connector write never races an agent's expected revision. The connector writes them with
`PUT /v1/tenant/events/{event_id}/writeback`.

Core never stores a host-only URL: not Zoom's `start_url`, which Zoom says must not be shared beyond
the host, and not Whereby's `hostRoomUrl`.

Order: Slotlock commits the booking first, then the connector writes to the provider.

- Invitations then go only to people whose booking committed. Microsoft "sends invitations to all
  attendees" whenever an event has attendees, and that cannot be configured.
- The write runs from `event.created`, `event.updated` or `event.cancelled` on the feed.
- Retries can never create a second copy: Google takes a client-chosen event id (5-1,024 base32hex
  characters; a repeat answers `409 duplicate`), Graph a `transactionId`, CalDAV a stable UID with
  `If-None-Match: *`.
- Google invitations are sent with `sendUpdates=all`.
- A write that fails permanently after commit (a token revoked in that second) records `failed` and
  a `writeback.failed` change. By default it notifies; it does not cancel the booking.

`auto` picks the organizer's own provider:

1. Meet on a Google event (`conferenceData.createRequest`, `hangoutsMeet`,
   `conferenceDataVersion=1`), when the calendar's `allowedConferenceSolutionTypes` lists it.
2. Teams on a work or school Microsoft event (`isOnlineMeeting` with `teamsForBusiness`), when
   `allowedOnlineMeetingProviders` lists it.
3. Zoom, if the organizer connected it.
4. Otherwise `unavailable`. Slotlock never invents a link.

An Outlook.com organizer gets no Teams link: Graph documents no consumer Teams provider, and
`POST /me/onlineMeetings` refuses personal accounts.

### Meetings with several people (core T2, connector)

- **`slotlock_hold_slots` gains `together`.** It holds one interval on 2-20 resources, all or none,
  as one group.
- **`slotlock_book_together` gains `group_id`, `organizer`, `attendees` and `conference`.** It
  records one `meeting_id` on the events it creates.
- **One provider event per meeting.** The connector writes it on the destination calendar of the
  organizer, who is either the resource whose connected account matches `organizer.address`, or,
  failing that, the first resource in the call that has a destination.
- **Everyone else becomes an attendee.** That covers the other participants' resources and anyone
  outside Slotlock, by email.
- **Attendee copies are recognized, not imported.** When other participants' calendars sync, the
  connector recognizes their copies by iCalendar UID and leaves them out of busy time, because they
  are already Slotlock bookings.
- **Invitations come from the organizer's account,** not a central one. Google's anti-spam limits
  (about 10,000 outside invitations "in a short period", per user) apply per organizer.

### Recognizing Slotlock's own events

The connector remembers every provider event it wrote (id and iCalendar UID). While the Slotlock
booking is live, it leaves that event, and attendee copies with the same UID, out of the busy
blocks it sends.

- A copy whose booking was cancelled in Slotlock but is still on the provider counts as busy until
  the connector deletes it.
- A missed recognition shows up in core as a block over Slotlock's own booking, reported as
  `external.conflict`: a visible false alarm, never a silent double booking.
- If someone moves or deletes a Slotlock-written event in their own calendar, the connector does not
  move the booking. The new time counts as busy, and the change is reported, so a person or an agent
  reschedules through Slotlock, where the constraint judges it. Cal.com's code does the opposite: it
  reschedules with `skipAvailabilityCheck: true`, which can double book.

### What counts as busy (connector)

The connector applies one published policy before it sends intervals, so core never sees provider
vocabulary:

| Source | Busy | Not busy |
| --- | --- | --- |
| Google | `transparency` opaque (the default), including out-of-office and focus time, which Google requires to be opaque; the person's own response `tentative` | `transparent` (working location, birthdays), `status: cancelled`, the person's own response `declined` |
| Microsoft | `showAs` `busy`, `tentative`, `oof`, `unknown` | `showAs` `free`; `workingElsewhere` (configurable); `isCancelled`; the person's response `declined` |
| CalDAV, ICS | Everything else | `TRANSP:TRANSPARENT`, `STATUS:CANCELLED`, the person's own `PARTSTAT=DECLINED` where the person can be identified |

All-day events occupy whole local days, as SPEC.md already reads them. Tentative and
working-elsewhere can be changed per connection; the defaults are a decision for this RFC.

### The connector

- **Connecting.**
  - OAuth 2.0 follows RFC 9700: PKCE with S256, state, exact redirect matching, and the RFC 9207
    `iss` check, since the connector talks to several authorization servers.
  - The OAuth callback lands on the connector's own origin, so tokens never pass through the
    dashboard Worker. The dashboard only starts the flow, with a signed, short-lived state naming
    the tenant and resource.
- **Tokens.**
  - Sealed with AES-256-GCM under a key derived (HKDF-SHA-256) from the connector's master secret,
    with the tenant and connection as additional data, as `src/assistant.ts` does. Google's policy
    requires tokens to be encrypted at rest.
  - Microsoft's rotating refresh tokens are replaced in the same write that uses them.
  - On disconnect, a token is revoked at the provider and then deleted.
- **Choosing calendars.** Per connection: which calendars count as busy, and one destination for
  bookings. The page says exactly which calendars are checked. In Cal.com's code a connected but
  unselected calendar counts for nothing, which users mistake for protection.
- **Syncing.**

  | Provider | Read | Change notifications |
  | --- | --- | --- |
  | Google | `events.list` with sync tokens; a `410` means a full resync | `events.watch`, renewed around day 6 of its 7-day default, jittered |
  | Microsoft | `calendarView/delta` per calendar; `syncStateNotFound` or `410` means a full resync | `/me/events` subscriptions, at most 10,080 minutes; a `missed` or `subscriptionRemoved` lifecycle notice means a full delta |
  | CalDAV | `sync-collection` or CTag polling | None; poll |
  | ICS | Polled through `createICalendarWorkerPool`; never `live` | None |

  - A notification only triggers a pull. It is never trusted as data.
  - A backstop round runs per source, skipping sources read recently. Google's 1,000,000
    requests-a-day billing threshold, not its per-minute quota, is the first ceiling a fixed short
    interval meets.
- **Health.**
  - Each connection is `connected`, `degraded` or `disconnected`, with a relink link.
  - Errors are recorded with `POST …/coverage/{source}/failure`.
  - `invalid_grant` and Workspace's `admin_policy_enforced` mean disconnected. Coverage stays, so
    the time becomes unproven.
- **Inbound webhooks.**
  - Each channel has its own secret (Google's `X-Goog-Channel-Token`, Graph's `clientState`),
    compared in constant time.
  - Graph's validation handshake is answered only while a subscription is being created. Graph is
    acknowledged within 3 seconds, before any work.
  - Cloudflare rules must let through Google's `APIs-Google` agent and Graph's posts.
- **Fetching CalDAV and ICS.** The connector checks every address a name resolves to when it
  connects, and refuses private ones, as `src/webhooks.ts` (`slotlockPrivateAddressLookup`) already
  does for webhook URLs. Like webhook delivery, it follows no redirects.

### Providers

| | Google Calendar | Microsoft 365 and Outlook.com | iCloud and CalDAV | Calendly | Zoom |
| --- | --- | --- | --- | --- | --- |
| Access | `calendar.events.owned` for calendars the person owns, `calendar.events.freebusy` for others they choose (labels to confirm in the Cloud Console) | `Calendars.ReadWrite`, `offline_access`, `User.Read` | App-specific password (iCloud: two-factor on, 25 at most, all revoked when the Apple password changes); OAuth on Fastmail; app passwords on Nextcloud | Self-serve OAuth app, PKCE required, granular scopes | General OAuth app, `meeting:write:meeting` |
| Approval | Sensitive, not restricted: verification without a CASA assessment, no fee found, "up to 10 days" (longer stalls reported); 100 users for the project's life until verified | The Microsoft-managed default consent policy excludes every `Calendars.*` and `OnlineMeetings.*` permission from user consent, so an admin approves for each organization; publisher verification needs a Partner One ID | None | None documented | Marketplace review with an OWASP Top 10 security review; a beta app allows 100 users |
| Busy time | `events.list`, sync tokens | `calendarView/delta`; `getSchedule` is work and school only | `calendar-query`, `sync-collection` | Optional, not `live`: `user_busy_times`, 7 days ahead at most; `424` means unproven | — |
| Change notifications | `events.watch`, 7-day default, "not 100% reliable" | Subscriptions under 7 days; "dropped notifications can't be recovered" | None | No busy-time webhook | — |
| Limits | New projects: 10,000 a minute per project, 600 per user | 10,000 requests per 10 minutes and 4 at once per app and mailbox | Undocumented; poll gently | Free plan: 5 API bookings a person a day | 100 meeting creates or updates per host a day |
| Writing | Client-chosen id | `transactionId` | UID with `If-None-Match` | `POST /invitees`, which checks the slot is open: written *before* the hold is confirmed | Update one stored meeting in place |
| Link | Meet | Teams on work and school accounts | None | Calendly's own | Zoom |

**Calendly is a place to book, not a calendar.** The calendars under it are where busy time comes
from. Its booking call is the one conditional write in the set ("start_time must correspond to a
valid open slot at booking time"), so for a Calendly target the connector books first, then confirms
the Slotlock hold with Calendly's event, or releases the hold if Calendly refuses.

### Key scope, confirmation and the agent contract

- **A `sync` scope** joins `read`, `write` and `admin`. It may:
  - record coverage and busy blocks, and record failures;
  - read the tenant's events and holds;
  - write write-back state;
  - manage its own webhook.

  It cannot manage keys, resources, hours or rules, or erase the tenant. The connector never holds
  an `admin` key.
- **New refusals:** `booking_rule_hold_required` and `booking_rule_read_pending`. `overlap` may
  carry `source_id`.
- **Free/busy and search keep their shape.** Missing sources are named as recorded; the connector
  names sources opaquely (`google:<connection>:<n>`), never by address or URL.
- **Invitations need a person's confirmation.** A write that sends invitations reaches real people
  outside the tenant. `SLOTLOCK_CONFIRM_WRITES` gains `invites`, which guards exactly those writes.
  Google's Workspace developer policy asks that apps "granularly require users to confirm" agentic
  tool invocations. Whether hosted Slotlock turns this on is a decision for this RFC.
- **Tool descriptions say so.** They state that writes on connected resources send real invitations.

### Hosted Slotlock

- **Where the connector runs:** beside `slotlock serve` in OVHcloud London, in its own process,
  schema (`slotlock_connect`) and role.
- **Dashboard:** gains a Calendars page per resource: connect, choose calendars and a destination,
  and see health. Connecting the first calendar mints the tenant's `sync` key, which the connector
  stores sealed. A `github-org:<id>` tenant is the natural unit for a Microsoft admin's approval.
- **Approvals:** Google verification needs the homepage, privacy policy and redirect on one
  Search Console-verified domain, plus a demo video. The 100-user cap counts for the project's
  life, so testing uses a separate project.
- **PRIVACY.md** must add:
  - the connected account's address;
  - sealed tokens;
  - busy intervals, replaced each round and deleted with their source;
  - write-back state and meeting links;
  - Google's Limited Use statement, with deletion instructions.

  Google, Microsoft, Apple, Calendly and Zoom are the user's own providers, separate controllers,
  not Slotlock's subprocessors.
- **README checklist item 4** becomes "keep provider credentials out of core".

### Self-hosters

Nothing changes unless they run the connector. If they do, they bring their own registrations:

- a Google project, capped at 100 users unless it is an Internal app in their own Workspace. Google
  deletes OAuth clients unused for six months.
- an Entra app, with an admin's approval;
- a Zoom private or Server-to-Server app.

## Security

| Threat | Mitigation |
| --- | --- |
| A database copy leaks tokens | Sealed under a key the database never holds, bound to tenant and connection; tokens live only in the connector's schema |
| Forged provider notifications | Per-channel secrets in constant time; a notification only triggers a pull |
| The connector reaches into another tenant | One `sync` key per tenant; core's row-level security is unchanged; the connector never holds `admin` |
| SSRF through a CalDAV or ICS address | Every resolved address checked at connect and private ones refused; no redirects followed |
| Prompt injection through outside events | No text crosses into core (SPEC.md, "External calendars"); agents read intervals only. Researchers from SafeBreach, Tel Aviv University and Technion reported hijacking Gemini through invitation text (disclosed to Google in February 2025), and Miggo Security reported a January 2026 variant that leaked private meetings |
| Someone fills a calendar with invitations | Inherent to any busy import: the time becomes busy, and conflicts name the source |
| Authorization mix-up across providers | RFC 9207 `iss` check, exact redirects, PKCE |
| Google's data policy | No training on calendar data beyond the user's own model, no permanent copies, an in-app disclosure before consent |

## Alternatives considered

1. **Import outside events as reservations or trusted events.** Rejected:
   - overlapping outside events are refused as `overlap`;
   - they use the booking limit and leave tombstones;
   - trusted events carry text agents would read.
2. **Core calls the provider at booking time.** Rejected: it puts credentials and network calls in
   core, and a provider round trip inside the write transaction.
3. **Buy a unified API (Nylas, Cronofy).** Not for the package: self-hosters need direct adapters
   anyway, and a vendor removes neither admin consent, nor unreliable notifications, nor the race.
   Vendors have their own outages: Nylas webhooks were delayed or missing for about 7.3 hours on
   19 August 2026, and Cronofy blocked events with integrated conferencing from reaching Microsoft
   calendars on 27 February 2026. For hosted Slotlock only, Cronofy is the contingency if Google
   verification stalls. It has a UK data centre and costs $819 a month billed annually for 500
   accounts, list. Nylas's European region is labelled London in current documents and Ireland in
   older ones.
4. **Blocks keyed by provider event (a delta API).** Not in the first version. Merged intervals are
   smaller, carry no identifier and reconcile themselves on every round, and recognition already
   happens in the connector. Revisit if 2,000 intervals per request proves tight.
5. **Write to the provider before confirming.** Rejected for Google and Microsoft: invitations would
   go out for bookings that can still fail. Kept for Calendly, whose booking call is the conditional
   step.
6. **Placeholder events on outside calendars during a hold.** Rejected: no product surveyed does it,
   Microsoft sends invitations for any event with attendees, and holds last seconds.

## Delivery

Other organizations' approvals take longest, so they start with the RFC: Google brand and
sensitive-scope verification, Microsoft partner enrolment and publisher verification, and the Zoom
app's registration and review. The independent reviewer is arranged before the first T2 PR.

| # | PR | Tier | Release |
| --- | --- | --- | --- |
| 1 | Busy blocks on coverage, `overlap` with `source_id`, `external.conflict`, `busy.changed`, `FOR SHARE` serialization, `tenant_busy` | T2 | 0.7.0 |
| 2 | `max_age_seconds` and `live` on coverage | T1 | 0.7.0 |
| 3 | `confirmAfterRead`, `together` holds, `slotlock_book_together` with a group, organizer and attendees, `meeting_id` | T2 | 0.7.0 |
| 4 | `conference`, write-back state, the `sync` scope, RFC 7986 export, `SLOTLOCK_CONFIRM_WRITES=invites` | T2 | 0.7.0 |
| 5 | Connector: framework, sealed tokens, webhooks, Google sync, write-back and Meet | T2 | connector 0.1 |
| 6 | Connector: Microsoft, with admin-consent onboarding and Teams | T2 | connector 0.2 |
| 7 | Connector: CalDAV and iCloud, ICS | T2 | connector 0.3 |
| 8 | Connector: Calendly as a booking target, Zoom once approved | T2 | connector 0.4 |
| 9 | Hosted: dashboard Calendars page, PRIVACY.md, README boundary text | T2 | with 5 |

Each core PR proves its guarantee with a red-to-green test:

- Overlapping outside events are accepted.
- A booking and a replacement racing each other never both commit unseen.
- A disconnected source makes time unproven.
- A booking without a read after its hold is refused.

The connector's exit test is a test tenant syncing for 30 days with no conflict left unreported.

## Open questions

1. Hosted Slotlock holding users' provider credentials, in the connector, reverses today's README
   wording. Agreed?
2. The defaults for tentative and Microsoft's working-elsewhere: busy or free?
3. When someone moves a Slotlock-written event in their own calendar: report it (proposed), or
   reschedule the booking through the constraint automatically?
4. Should hosted Slotlock turn on `SLOTLOCK_CONFIRM_WRITES=invites`, given Google's wording on
   confirming agentic tool calls?
5. Should `confirmAfterRead` default to on for resources with a `live` source, as RFC 0002 asked of
   `requireCertain`?
6. Should a refused `booking_rule_read_pending` wait a bounded few seconds inside the call, which
   costs a database poll in the request, or always answer at once?
7. Should write-back cover reservations, which have no title or attendees, as plain busy events?
8. The connector's package name and directory.
9. For legal review: whether busy intervals reaching a third party's agent is a "transfer" under
   Google's Limited Use policy, and Slotlock's controller or processor position for connected
   calendars under UK GDPR.

To test before relying on them:

- Google's per-scope sensitivity labels, and whether `calendar.events.owned` lists events.
- Whether a consumer Gmail account can create Meet links.
- The date of Microsoft's consent policy change, which rests on a community thread and a
  third-party blog.
- Whether Graph's v1.0 delta works on non-default calendars.
- Which reports iCloud supports, and whether Apple's 2025 third-party sign-in is open to developers.
- How fresh a directly fetched ICS feed is.
- How long Zoom's first review takes.

## Sources (read 2026-11-10)

**Slotlock code** (at `a54136b`): `src/ddl.ts` (`slotlock.reservations`, `slotlock.calendar_coverage`),
`src/store.ts` (`recordCalendarCoverage`, `bookingJudge`, `CERTAIN_COVERAGE_MAX_AGE_MS`, `listBusy`),
`src/sync.ts` (`normalizeExternalCalendarChange`), `src/agent-server.ts` (`slotlock_hold_slots`,
`slotlock_book_together`), `src/event-feed.ts`, `src/webhooks.ts`, `src/api-keys.ts`,
`src/assistant.ts`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `README.md`, `PRIVACY.md`, RFC 0002.

**Google:** [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
[restricted scopes](https://support.google.com/cloud/answer/13464325),
[unverified apps](https://support.google.com/cloud/answer/15549945),
[OAuth 2.0](https://developers.google.com/identity/protocols/oauth2),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[push](https://developers.google.com/workspace/calendar/api/guides/push),
[quota](https://developers.google.com/workspace/calendar/api/guides/quota),
[events](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[create events](https://developers.google.com/workspace/calendar/api/guides/create-events),
[event types](https://developers.google.com/workspace/calendar/api/guides/event-types),
[errors](https://developers.google.com/workspace/calendar/api/guides/errors),
[anti-spam limits](https://support.google.com/a/answer/2905486),
[Meet limits](https://developers.google.com/workspace/meet/api/guides/limits),
[API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
[Workspace developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy),
[Workspace app access](https://support.google.com/a/answer/7281227).

**Microsoft:** [consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies),
[MC1163922 thread](https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922),
[publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview),
[refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens),
[getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0),
[delta](https://learn.microsoft.com/en-us/graph/delta-query-overview),
[subscription](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0),
[webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks),
[throttling](https://learn.microsoft.com/en-us/graph/throttling-limits),
[create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0),
[online meetings on events](https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings),
[EWS retirement](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online),
[hybrid support](https://learn.microsoft.com/en-us/graph/hybrid-rest-support).

**Others:** Calendly [release notes 2026-11-03](https://developer.calendly.com/release-notes/2026/11/3),
[rate limits](https://developer.calendly.com/api-docs/overview/rate-limits),
[busy times](https://developer.calendly.com/api-docs/calendly-api/availability/list-user-busy-times),
[AI agents](https://developer.calendly.com/docs/api-guides/schedule-events-with-ai-agents); Zoom
[beta apps](https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/),
[app review](https://developers.zoom.us/docs/distribute/app-review-process/),
[rate limits](https://developers.zoom.us/docs/api/rate-limits/),
[meetings](https://developers.zoom.us/docs/api/meetings/); Apple
[app-specific passwords](https://support.apple.com/en-us/102654),
[third-party apps](https://support.apple.com/en-us/121539);
[RFC 4791](https://www.rfc-editor.org/rfc/rfc4791), [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578),
[RFC 7986](https://www.rfc-editor.org/rfc/rfc7986), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html);
Cal.com [CalendarSyncService](https://github.com/calcom/cal.com/blob/main/packages/features/calendar-subscription/lib/sync/CalendarSyncService.ts),
[getCalendarsEvents](https://github.com/calcom/cal.com/blob/main/packages/features/calendars/lib/getCalendarsEvents.ts);
[Cronofy pricing](https://www.cronofy.com/api/markdown/api-pricing),
[Cronofy data centres](https://docs.cronofy.com/developers/data-centers/),
[Cronofy status](https://status.cronofy.com/incidents/r7wggzc6hyj9),
[Nylas pricing](https://www.nylas.com/pricing/),
[Nylas data residency](https://developer.nylas.com/docs/dev-guide/platform/data-residency/),
[Nylas status](https://status-v3.nylas.com/incidents/r9sp1l8vjzk5);
[Gemini invitation research](https://www.bitdefender.com/en-us/blog/hotforsecurity/gemini-ai-compromised-through-malicious-calendar-invites-researchers-warn),
[Miggo report](https://www.bleepingcomputer.com/news/security/gemini-ai-assistant-tricked-into-leaking-google-calendar-data/amp/).
