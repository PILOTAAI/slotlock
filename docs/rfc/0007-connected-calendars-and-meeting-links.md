# RFC 0007: Calendars on Cloud, meeting links and invitations

| | |
| --- | --- |
| Status | Proposed. The owner decided its six open questions on 2026-11-18, taking each recommendation ([Decisions](#decisions-owner-2026-11-18)) |
| Target | One sentence in VERSIONING.md before 1.0.0; everything else in 1.x minors and the integration packages' own 0.x releases, additive and opt-in |
| Builds on | RFC 0004 P3 (C1 free/busy adapters, C2 notifications, C4 two-way sync), A4 (approval policies) and B7 (holds together), as built at 0.12.3 in core, `@slotlock/sync` and `@slotlock/notify` |
| Decision | GOVERNANCE.md: adds key scopes, a booking rule, an event field and an agent tool, and puts people's provider tokens and outbound invitations on Cloud; needs the maintainer's approval and an independent, non-AI security review of every PR marked T2 |

## Summary

Slotlock has launched, and RFC 0004 already built the integration layer:
- `@slotlock/sync` reads busy time from Google, Microsoft and iCalendar feeds into core's source
  busy time;
- it writes confirmed bookings back to the calendar as `Busy`;
- it reports a booking the calendar contradicts as `coverage.conflict`;
- `@slotlock/notify` emails a booking's contacts and an event's attendees.

Neither package runs on Cloud yet. Each holds every tenant's admin key. Certainty is judged a day
at a time. Nothing makes a meeting link, no one receives a calendar invitation, and a person who
connects no calendar cannot get a link at all.

This RFC proposes four things. Each is additive and opt-in, so no tenant sees a change until it
turns a feature on:

1. **Calendars on Cloud.**
   - Narrow `sync` and `notify` key scopes in place of admin keys.
   - Self-serve connection from the dashboard.
   - A narrower Google write scope.
   - Google and Microsoft approvals started now.
2. **Certainty in minutes.**
   - Freshness judged per source.
   - An opt-in rule that a booking's calendars were read again after its hold was placed.
3. **Meeting links.** A `conference` field on events. Links come from the organizer's own Google
   or Microsoft event when they connect a calendar, and from a room provider when they do not.
4. **Invitations.**
   - By default Slotlock hands the agent a finished invitation to send from the person's own
     mailbox.
   - Invitations that Slotlock sends come later, through `@slotlock/notify`, behind the controls in
     Part 4.

Three rounds of research on 2026-11-10 back this RFC:
- provider APIs and unified-API vendors;
- delegated access, agent identity and Pylota Identity;
- meeting links for people who connect nothing.

They confirm RFC 0004's shape: build the integrations directly, keep credentials out of core, and
treat unread time as unproven. They add two lessons for an agent-driven product:
- An agent must not be able to make Slotlock mail arbitrary addresses.
- A person who connects nothing is a first-class case, not an edge case.

None of this waits for the OAuth authorization server planned for Claude and ChatGPT (RFC 0004
D2). Part 7 says where the two meet.

## Where 0.12.3 stands

| Area | Built | Gap |
| --- | --- | --- |
| Busy time | `@slotlock/sync` reads Google `freeBusy`, Microsoft `calendarView` or `getSchedule`, and iCalendar URLs every 300 s over 60 days, into `PUT /v1/resources/{id}/coverage/{source}/busy` (`slotlock_put_source_busy`), outside the EXCLUDE constraint. A booking checks source busy time under the resource's write lock, which a replacement takes too. Failures back off and leave coverage to go stale | Polling only. `requireCertain` still judges freshness by one 24-hour limit (`CERTAIN_COVERAGE_MAX_AGE_MS`) |
| Write-back | Confirmed bookings and one-off events, times only, titled `Busy`, with retry-safe ids. The sync's own events are subtracted when read back, and a change made in the calendar is reported as `coverage.conflict`. A daily reconcile runs | No title, attendees or link, so it cannot carry a meeting |
| Credentials | Provider tokens sealed with AES-256-GCM, bound to their tenant, under rotating keys. Both packages call Slotlock with each tenant's admin key | A second store holds admin keys for every tenant. Key scopes are only `read`, `write` and `admin` |
| Connecting | The operator API issues signed, single-use connect links (`SYNC_ADMIN_TOKEN`) | No self-serve page. Not on Cloud. The T2 review is outstanding |
| Scopes asked | Google: `calendar.calendarlist.readonly`, `calendar.freebusy`, and `calendar.events` to write. Microsoft: `Calendars.Read` or `Calendars.ReadWrite` | `calendar.events` reaches every calendar the person can edit |
| Holds | Agent holds, `slotlock_hold_together`, and `slotlock_book_together` with `hold_group_id` | Nothing shows that a calendar was read after a hold |
| Approvals | Approval policies hold a write's time and answer `approval_pending` until a person decides on the dashboard's Approvals page (A4) | Not connected to invitations |
| Notifications | `@slotlock/notify` sends email (Postmark, Resend or SES), SMS and WhatsApp. It covers contacts with per-channel consent and event attendees, keeps a send ledger and honours opt-outs | No calendar invitation and no link. Not on Cloud (RFC 0004 D5) |
| Meeting links | Nothing | No field and no provider |
| Agents | The write confirmation names other fields only by name ("also attendees"). Agent event ids are `agent:<digest>` | An agent cannot be handed a real invitation |

## Goals

1. A person connects Google or Microsoft from the dashboard on Cloud and chooses which calendars
   count. Nothing else in their tenant changes.
2. Unread time stays unproven. For a calendar Slotlock can re-read, it is judged in minutes.
3. A meeting booked through Slotlock can carry a video link. It comes from the organizer's Google
   or Microsoft account when they connect one, and from a room provider when they do not.
4. A person who connects nothing can prompt an agent into a meeting with a link and an invitation
   the agent sends.
5. Slotlock never relays unsolicited mail. Invitations go only to people in a meeting someone asked
   for, and Cloud sends none until Part 4's controls are in place.
6. Agents never see a connected calendar's content. Core holds no provider credential and makes no
   network call (CONTRIBUTING.md).

## Non-goals

- **Mirroring calendars.** Importing titles, descriptions or attendees of outside events would let
  invitation text reach agents. Researchers hijacked Gemini this way, disclosed to Google in
  February 2025, and Miggo Security reported a variant in January 2026. Google's Limited Use rules
  also favour keeping the minimum.
- **Applying edits made in a provider to bookings.** They stay `coverage.conflict`, as C4 decided.
- **Treating unread time as free.**
- **Exchange on-premises and EWS.** EWS in Exchange Online is being switched off from 1 October
  2026 to 1 April 2027, and Graph no longer reaches hybrid on-premises mailboxes.
- **A unified-API vendor inside the packages.** See Alternatives.
- **Events without a resource.** A person who connects nothing is still a resource.
- **A page where invitees pick among offered times.** It needs a separate RFC (Part 5).

## Part 1: calendars on Cloud

### 1.1 Narrow key scopes for the packages (T2)

Each package keeps every connected tenant's admin key, so a stolen package store is admin over all
of them. RFC 0004 D1 cites the Salesloft Drift breach, where stored OAuth tokens were the way in.
Two scopes join `read`, `write` and `admin`:

- **`sync`** may:
  - record coverage, source busy time and failures;
  - report conflicts;
  - read the change feed and the tenant's reservations and events;
  - write meeting-link and write-back state (Part 3).
- **`notify`** may read the change feed, contacts and events.

Neither may manage keys, resources, hours or rules, or erase the tenant. On Cloud, the dashboard
mints the scoped key when a tenant turns a package on and revokes it when the tenant turns the
package off. The packages refuse an admin key on Cloud. Self-hosters can move over when they next
rotate.

### 1.2 Connecting from the dashboard (T2)

- **A Calendars page per resource.**
  - Connect Google or Microsoft.
  - Choose which calendars count, and whether bookings are written back.
  - See health: connected, degraded, or disconnected with a relink link.
  - Disconnect. A disconnect a person chooses retires the sources, as the sync does today. A
    connection that is lost (a revoked token, `invalid_grant`, Workspace's
    `admin_policy_enforced`) never does: its failure is recorded and its coverage goes stale, so
    `requireCertain` fails closed until a person reconnects or removes it.
- **The flow stays where the sync already runs it.** The page asks the sync's operator API for a
  connect link server-side. The OAuth callback lands on the sync's own origin (`SYNC_PUBLIC_URL`),
  so provider tokens never pass through the dashboard Worker.
- **Microsoft needs an organization's admin.** The Microsoft-managed default consent policy
  excludes every `Calendars.*` permission from user consent, read included, so the page offers an
  admin-consent link. A `github-org:<id>` tenant is the natural unit. Personal Outlook.com accounts
  have `calendarView` but neither `getSchedule` nor Teams links.
- **Name it "Calendars".** "Connected apps" is the grants page planned with the authorization
  server (Part 7).

### 1.3 Scopes asked of Google and Microsoft

**Google:**
- Reading stays as built: `calendar.calendarlist.readonly` and `calendar.freebusy`.
- Writing back uses `calendar.events.owned` in place of `calendar.events`, if the Cloud Console
  confirms its label and behaviour. It reaches only calendars the person owns.
- Every Calendar scope is "sensitive" and none is "restricted", so verification needs no CASA
  assessment. Google quotes up to 10 days.
- Until verified, a project is limited to 100 users for its whole life. Calendar sync therefore
  gets its own Cloud project, apart from Google sign-in and from testing.

**Microsoft:** `Calendars.Read` or `Calendars.ReadWrite`, `offline_access` and `User.Read`, as
built. Publisher verification needs a Microsoft partner (Partner One) ID.

**Start the approvals now:** Google brand and scope verification, Microsoft partner enrolment and
publisher verification. Cloud turns each provider on when its approval lands, without a release.
The steps, the blockers to clear first and the texts the forms ask for are in
[docs/hosted/calendar-provider-approvals.md](../hosted/calendar-provider-approvals.md).

### 1.4 Keys and audit (T2)

- On Cloud, the packages' sealing keys (`SLOTLOCK_SYNC_KEYS`, `NOTIFY_SEAL_KEYS`) are data keys
  wrapped by a key-encryption key held outside the database host, in a KMS or an HSM. Which one
  suits OVHcloud is open.
- The IETF's agent identity draft (`draft-ietf-wimse-aims-01`) sets the bar: no model sees a
  credential, keys stay isolated, and the audit is tamper-evident.
- Every token refresh and provider write is recorded with tenant, resource, action and outcome,
  never content.

### 1.5 Hosted documents (T1)

Thirty days before Cloud runs the sync:
- **PRIVACY.md** names the connected account's address, the sealed tokens, busy intervals and
  write-back state.
- Google's Limited Use statement is published, with how to delete data.
- **TERMS.md**'s processing list ("and nothing else") covers reading calendars and writing bookings
  back.
- **PRIVACY.md** names the verified email address kept for a person who turns on invitations
  (Decision 5), and keeps today's rule for everyone else: the address only in the session cookie.
- **The operations guide's checklist** (`site/docs-src/operations.md`, item 4) "keep provider
  credentials out of Slotlock" becomes "out of core".

Google and Microsoft are the person's own providers, not Slotlock's subprocessors.

## Part 2: certainty in minutes

### 2.1 Freshness per source (T1)

Coverage gains two optional fields, set by whoever records the source:
- **`max_age_seconds`** (60 to 86,400). `requireCertain` and free/busy call the source stale after
  the lesser of this and the present 24 hours. The sync records twice its interval, 600 s by
  default.
- **`live`**: the recorder can read this source again on demand. That is true for Google and
  Microsoft, and false for iCalendar URLs.

Without either field, nothing changes. The sync already records the next revision on every pass,
so `observed_at` is the last completed read.

### 2.2 Read again after the hold (T2)

A booking rule, **`confirmAfterRead`**, is set per resource, pool or tenant. It starts on when a
person connects a calendar on the dashboard's Calendars page: the box starts ticked, beside a line
saying agents must hold a time before booking it, and the person can untick it (Decision 2).
Nothing else turns it on: not a connection made through the sync's operator API, not one made
before this release, not a self-hosted or library deployment. On a resource with it:

1. A booking must come from a hold (`hold_id`, `hold_group_id`, or a confirm through the
   application API). Otherwise it is refused with `booking_rule_hold_required`.
2. Every required source marked `live` must have been observed after the hold was created.
   Otherwise the booking is refused with `booking_rule_read_pending`, which names those sources and
   can be retried.

The sync takes `hold.created` by webhook and runs a pass for that resource at once: one `freeBusy`
or `getSchedule` call per mapped calendar, each covering the whole 60 days. The target is under 2
seconds at the 95th percentile after the webhook pass, which runs every 2 seconds by default; this
is a goal, not a measurement. An agent booking such a resource should hold for at least 60 seconds.

No provider offers a write conditional on a slot being free. This rule closes the window between
Slotlock's last read and a meeting accepted elsewhere down to the time it takes to book.
`coverage.conflict` reports whatever still gets through.

### 2.3 Push notifications (later)

Change notifications are left for later.
- **Google:** `freeBusy` has no push. Push needs `events.watch` on an events listing, which needs
  scopes that can read events.
- **Microsoft:** Graph subscriptions last under seven days, and Microsoft says "dropped
  notifications can't be recovered".

Polling every 300 seconds plus the read after a hold covers the moment of booking.

At 300 seconds, one calendar costs 288 `freeBusy` calls a day. Google's daily billing threshold
for new projects is 1,000,000 requests per project, and prices above it are not yet published. That
is about 3,400 calendars per project before batching; one request can cover up to 50 calendars of
an account (estimate). Revisit polling near that scale.

## Part 3: meeting links

### 3.1 The `conference` field (T2)

It ships in two parts (Delivery 6a and 6b). The first takes only `none` and `user_supplied`: a link
the person gave is content, kept with the event's revision like its location, so it needs no side
table and no new key scope. `auto`, the providers and `room` come with the side table, once a
package can make links.

- **Request.** `slotlock_create_event`, `slotlock_update_event` and `slotlock_book_together` take
  `conference`, one of:
  - `none` (the default);
  - `auto`;
  - `google_meet`, `microsoft_teams`, `zoom`, `room`;
  - `user_supplied`, with `conference_url` (https only, length-capped).
- **Output.** `conference` reports:
  - `requested`;
  - `provider`;
  - `status`: `pending`, `ready`, `failed` or `unavailable`;
  - `join_url`.
- **Results are kept outside the event's revision.** They go in a side table that a `sync`-scoped
  key writes (`PUT /v1/tenant/events/{event_id}/conference`), so a package never races an agent's
  expected revision.
- **No host-only URLs.** Core never stores one: not Zoom's `start_url`, nor Whereby's
  `hostRoomUrl`.
- **iCalendar output.** `emitICalendar` and `emitITipCalendar` write RFC 7986 `CONFERENCE`, put the
  link in `LOCATION` when that is empty, and add it to `DESCRIPTION`.
- **`auto` tries, in order:**
  1. Meet or Teams from the organizer's connected calendar with meeting write-back (3.2);
  2. Zoom, if connected (later);
  3. the deployment's room provider (3.3);
  4. otherwise `unavailable`.

  Slotlock never invents a link.

### 3.2 Meeting write-back (T2)

C4 writes `Busy`, times only. A mapping may opt in to `write_back: "meeting"` for events whose
organizer owns that calendar.

- **What the provider event carries:** the title, the attendees and the conference request.
  - Google creates Meet (`conferenceData.createRequest`, `conferenceDataVersion=1`) and invites
    with `sendUpdates=all`.
  - Microsoft creates Teams (`isOnlineMeeting` with `teamsForBusiness`, on work and school accounts
    only) and always invites attendees.
- **Attendees' copies are not imported.** When an attendee's own connected calendar returns its
  copy, the sync recognizes it by iCalendar UID and subtracts it, as C4 subtracts its own `Busy`
  events.
- **It counts as sending invitations.** The provider emails the attendees, so Part 4's controls
  apply, including approval for first-contact recipients on Cloud.

`Busy` write-back stays the default.

### 3.3 Room providers: `@slotlock/rooms` (T2)

A small package with its own process and a `sync`-scoped key. When an event is created or updated
with `conference: room`, or with `auto` falling through to a room, it creates a room and records
the link. It deletes the room when the event is cancelled.

| Adapter | For | Notes |
| --- | --- | --- |
| Daily | Cloud's provider (Decision 4) | Set `geo: eu-west-2` on every room: the default is `us-west-2`, and the setting places media only, so Daily remains a US processor. `privacy: private`, `exp` at the meeting's end, recording off, unguessable names. 10,000 free participant-minutes a month, then $0.004. About $320 a month at 1,000 meetings of 30 minutes with 3 people (estimate) |
| Whereby Embedded | EU-company alternative | `endDate` required, and the room is deleted an hour after it; `roomNamePattern: uuid`; `isLocked` gives a waiting room. $10.99 a month plus $0.0042 per participant-minute |
| Jitsi (self-hosted) and 8x8 JaaS | Self-host default | One JWT adapter. Jitsi is Apache-2.0. JaaS is priced per active user (from $99 for 300), so it is not Cloud's default |
| Static link | Any deployment | An operator setting |
| Zoom, Meet or Teams from operator accounts | Opt-in only | Their lobbies expect a human host. Teams guests wait for a verified participant, Meet guests without a Google account knock unless access is `OPEN`, and Zoom needs a licensed host per concurrent meeting |

- **Links.** One room per meeting. Per-invitee tokens only where invitations are rendered per
  attendee (4.3).
- **Cloud.** Daily becomes a subprocessor, with 30 days' notice, its data processing agreement and
  the transfer mechanism for a US processor named in PRIVACY.md. Whereby stays an adapter for
  operators and self-hosters who want an EU company.

## Part 4: invitations

### 4.1 Return, don't send (T1)

- **The tool.** A read-only agent tool, `slotlock_get_invitation`, takes an event and a method
  (`request`, `cancel` or `publish`).
- **What it returns:**
  - an iTIP iCalendar with:
    - a random `ical_uid` the event keeps, not its internal id or `agent:` digest;
    - its revision as `SEQUENCE`;
    - its organizer as `ORGANIZER`, its attendees, and `CONFERENCE`;
  - the join link;
  - a short plain-text body.
- **How it is delivered.** Over MCP the iCalendar is an embedded `text/calendar` resource beside
  the structured output. Over A2A it is an artifact.
- **Who sends it.** The agent, from the person's own mailbox, so replies go to the person. A
  cancellation is the same UID at a higher `SEQUENCE`.
- **As built (Delivery 7).** Two choices differ from the text above:
  - The UID is derived rather than stored: a version 8 UUID from SHA-256 of the tenant and the
    event's id. It is just as stable and names no id, needs no new column or backfill for events
    made before it, and lets any backend that reads events produce it, since the tool is composed
    from `getEvent`.
  - A2A gets a `text/calendar` part on the reply message, not an artifact: the server keeps no
    tasks, and A2A artifacts belong to tasks.

  `cancel` carries the `SEQUENCE` that cancelling will write, so the agent reads it before
  `slotlock_cancel` and sends it after. Once cancelled, the event has no invitation.

This is the default for everyone. Zoom's "Copy invitation" and Doodle's free tier work the same
way. Slotlock sends nothing, so it is never a relay, never the "transmitter" under PECR, and never
answerable for deliverability.

### 4.2 Confirmation that names the recipients (T1)

Where confirmation is on, the write confirmation lists every attendee address, the organizer and
the link provider, not "also attendees".

### 4.3 Invitations sent by `@slotlock/notify` (T2, later)

notify already emails an event's attendees when it is booked, moved and cancelled. It gains, per
tenant and opt-in:

- **The invitation itself.** A `multipart/alternative` message with an inline
  `text/calendar; method=REQUEST` part and the same file attached. A cancellation sends `CANCEL`; a
  move sends the same UID at a higher `SEQUENCE`.
- **Sender and replies.**
  - The From line reads "<organizer> via <tenant>", on the tenant's verified domain.
  - Reply-To and `ORGANIZER` are both the organizer's verified address (Decisions 3 and 5), so
    answers go to them, as Cal.com does. This mode tracks no RSVPs.
- **AI disclosure.** A disclosure line when an agent made the booking. Article 50(1) of the EU AI
  Act has applied since 2 August 2026, and the Commission's guidelines say a disclosure only in
  terms, or only in machine-readable form, is not enough.
- **Links.** Only links from Slotlock's room adapter, the organizer's own provider, or an
  allow-listed provider domain. Never a URL an agent typed.

Before Cloud sends a single invitation:

- **Terms first.** TERMS, PRIVACY and ACCEPTABLE-USE change with 30 days' notice, and ACCEPTABLE-USE
  forbids cold invitations.
  - PECR regulation 22 requires consent for unsolicited marketing email; regulation 23 requires
    the sender to be identified.
  - In the ICO's view, any promotional element makes a message marketing.
- **Sending infrastructure.**
  - Amazon SES in London, with one SES tenant per Slotlock tenant, as RFC 0004 D1 proposes. That
    gives each tenant its own reputation, automatic pause and suppression list.
  - For invitations, SES or Postmark over Resend: a Resend issue, open since 24 October 2026,
    reports that its relay strips `method=REQUEST`.
- **Who may send.** Only tenants with a verified person and a verified sending domain, on a paid or
  vetted plan.
- **Approval for first-contact recipients.** A new approval-policy condition (A4 has kinds, hours
  and length today), `new_recipients`, holds the booking as `approval_pending` until a person
  approves on the dashboard. That is the out-of-band check the
  agent identity draft asks for ("Local UI confirmation alone is not sufficient").
- **Limits and abuse handling.**
  - Caps per tenant per day on invitations and new recipients, and per meeting on recipients and
    updates.
  - An address for abuse reports, and a pause on complaints.

The reason for this care: on 25 June 2026 Microsoft reported phishing sent through real Calendly
accounts that passed SPF, DKIM and DMARC ("authentication laundering"). Coverage of Check Point's
figures counted more than 302,000 calendar-invitation phishing emails in October 2026.

### 4.4 The agent as organizer, with RSVPs (later)

As an option, `ORGANIZER` can be an address Slotlock receives mail for, so verified replies update
attendee response state. That state lives in a core side table written by a scoped key.

- A reply counts only when its DMARC-aligned From equals the attendee.
- iCloud replies arrive through Apple's `imip.me.com` relay.
- Inbound mail comes through SES receiving, or Pylota Identity once it ships (Part 8).

Invitations from an unknown sender land less reliably:
- Google shows one only as email to people who add invitations from known senders only.
- Exchange adds it as tentative.

## Part 5: a person who connects nothing

**Possible today.** The person is a resource with weekly hours, set in the dashboard, with
`enforceHours` on. Slotlock then prevents clashes with its own bookings only. So for a resource no
source covers, tools and confirmations should say "free in Slotlock", never "free".

**Once Parts 3 and 4.1 ship:**
1. The person prompts their agent.
2. The agent finds a time in the person's hours, or the person picks one in chat in the MCP Apps
   view.
3. `slotlock_create_event` with the attendees and `conference: auto`.
4. A room link.
5. `slotlock_get_invitation`.
6. The agent sends the invitation from the person's mailbox.

**Left to a later RFC** (Decision 6), written once 4.1 and the room adapter have shipped and show
demand: a page where invitees pick among offered times.
- No product researched holds offered times without writing to the host's calendar.
- In Calendly's one-off links and Gmail's offered times, only the first person to book gets the
  meeting.
- Such a page is a public surface, exposed to token leaks, enumeration and bots.
- Its default should be to offer times without holding them and book at the moment of choice.

## Part 6: versions

Slotlock is at 0.12.3, and 1.0.0 is next. VERSIONING.md says:
- from 1.0, breaking changes need a new major version;
- new routes, optional fields, response fields and error codes may come in any release.

It says nothing about new values in an existing enum.

- **Before 1.0.0:** a "Listed values" rule in VERSIONING.md (added with this RFC): a field that
  takes one of a listed set of values may gain values in any release, as error codes already may,
  and clients must not fail on a value they do not know. Without it, each of these could be argued
  breaking after 1.0:
  - a `sync` scope in key listings;
  - a new change type;
  - a new conference provider.

  This is the only part of this RFC that 1.0.0 needs.
- **After 1.0.0:** everything else is additive and opt-in, in 1.x minors.
- **The integration packages** (`@slotlock/sync`, `@slotlock/notify` and the new `@slotlock/rooms`)
  already carry their own versions (0.1.0). They stay separately versioned while their approvals
  and Cloud rollout settle. VERSIONING.md now says so (added with this RFC): the artifacts that
  "carry the same version" are Slotlock's own, and each package keeps its own version, relying only
  on Slotlock's API.

## Part 7: the Claude and ChatGPT connector

The connector plan makes Slotlock an OAuth **authorization server** for MCP clients (RFC 0004 D2,
planned for 1.1), so the Claude and ChatGPT directories can list it. This RFC makes the packages
OAuth **clients** of Google and Microsoft. Neither needs the other first. Where they meet:

- **Order.** 1.0.0, with the enum sentence. Then the authorization server and listings in 1.1, as
  planned. Parts 1 to 4.2 can run in parallel; the independent reviewer is the shared bottleneck.
- **Names.** "Connected apps" means grants to Claude or ChatGPT. "Calendars" means 1.2.
- **Google.** Sign-in, calendar sync and any client marked "Use this client for an AI-powered
  agent" are separate OAuth clients. Calendar sync gets its own project, so its verification and
  user limit never touch sign-in.
- **One notice cycle.** Both need PRIVACY.md and TERMS.md changes with 30 days' notice, so bundle
  them.
- **Directory review.**
  - A tool that sends invitations carries `destructiveHint` and a confirmation.
  - Listing with 4.1's return path, where Slotlock sends nothing, is the simpler story.
  - ChatGPT needs a test account without MFA.
- **Connecting a calendar from chat.** This needs MCP's URL-mode elicitation and the person behind
  the MCP session, which the authorization server's grants provide. Until then, calendars are
  connected from the dashboard.
- **Email addresses.** The connector plan asks whether Cloud keeps users' email addresses. Decision
  5 answers it for both plans: a verified address, kept only for a person who turns on a feature
  that needs one.
- **First experience.** Someone who adds Slotlock in ChatGPT and connects nothing still gets a
  meeting with a link (Part 5).

## Part 8: Pylota Identity

Pylota Identity (pylotamail.com) is pre-release, at milestone M0, under FSL-1.1-ALv2.

- **Not its vault for people's tokens.**
  - Vault items are logins, API keys and sessions, each bound to an agent's own service sign-up
    ledger.
  - Consumer rule C17 forbids a secret in a request body, which an OAuth refresh needs.
  - Grants last at most 90 days.
- **Its calendar invitations fit 4.4,** as a transport adapter after its mail v1.0. Its design was
  written with Kairos, Slotlock's predecessor, as the calendar. It requires `ORGANIZER` to equal the
  sending identity, and it suppresses a first-contact recipient without an allow entry.
- **Its agent assertions** could later become an optional `authenticate` adapter.
- **HTTP only.** GOVERNANCE.md's licence commitment rules out vendoring FSL code.

## Security

| Threat | Mitigation |
| --- | --- |
| A package store leaks | Scoped keys, never admin (1.1); tokens sealed under a key the database host never holds (1.4) |
| An agent mails arbitrary addresses | The return path by default (4.1); Cloud sends only for verified, vetted tenants, after approval for first-contact recipients, under caps (4.3) |
| Phishing through Slotlock's good reputation | Links only from Slotlock's room adapter or allow-listed providers; per-tenant SES reputation with automatic pause; an abuse address |
| Outside event text reaching agents | Busy intervals only. Write-back sends titles and attendees only to the organizer's own calendar, opt-in (3.2) |
| A meeting accepted elsewhere during a booking | `confirmAfterRead` (2.2); `coverage.conflict` afterwards |
| Strangers joining agent-made rooms | Private, unguessable rooms that expire, with recording off; no host-only URL stored |
| A malformed or hostile `.ics` | Bounded parsing on worker threads, as today; invitations are generated from stored data, never forwarded |
| A forged RSVP (4.4) | Counted only when the DMARC-aligned From equals the attendee |

## Alternatives considered

1. **A unified API (Nylas, Cronofy).** Not in the packages:
   - self-hosters need direct adapters anyway;
   - vendors still need Slotlock's own Google verification;
   - they remove neither admin consent nor the race;
   - both had incidents in 2026: Nylas webhooks were delayed or missing for about 7.3 hours on
     19 August, and Cronofy blocked events with integrated conferencing from reaching Microsoft on
     27 February.

   Cronofy, which has a UK data centre and lists $819 a month for 500 accounts, is Cloud's
   contingency if Google verification stalls.
2. **A token vault** (Auth0 Token Vault, AWS AgentCore Identity in London, Pylota Identity). None
   removes per-user grants or Slotlock's own verification. A token-store interface in the sync
   keeps AgentCore possible later.
3. **Agent delegation standards** (Okta Cross App Access, the identity-assertion grant). Neither
   Google nor Microsoft accepts them, and Okta says they are not for background jobs.
4. **Full two-way mirroring.** See Non-goals.
5. **Writing to the provider before confirming.** Invitations would go out for bookings that can
   still fail. This order is kept only for Calendly as a booking target, whose `POST /invitees`
   checks the slot.
6. **Placeholder events on outside calendars during a hold.** Microsoft invites the attendees of
   any event that has them, and holds last seconds.
7. **Slotlock sending invitations from the start.** Rejected because of the abuse evidence and the
   notice cycle (4.3).

## Delivery

Start now: Google verification (in its own project), Microsoft partner enrolment and publisher
verification, the independent reviewer, and counsel on PECR roles and Article 50.

| # | PR | Tier | Release |
| --- | --- | --- | --- |
| 1 | VERSIONING.md: listed values may gain values; integration packages version separately (both added with this RFC) | T0 | 1.0.0 |
| 2 | `sync` and `notify` key scopes; packages take them and refuse admin keys on Cloud | T2 | 1.1 |
| 3 | Dashboard Calendars page, Microsoft admin-consent link, `calendar.events.owned` | T2 | 1.x, with the sync's review |
| 4 | `max_age_seconds` and `live` on coverage | T1 | 1.x |
| 5 | `confirmAfterRead`; the sync re-reads on `hold.created` | T2 | 1.x |
| 6a | `conference` field with `none` and `user_supplied` links, stored with the event's revision; RFC 7986 `CONFERENCE` and JSCalendar export; the confirmation names the link's host | T2 | 1.x |
| 6b | The side table and its `sync`-scoped route for links a package makes; `auto` and `room` | T2 | 1.x, with PR 8 |
| 7 | `slotlock_get_invitation`, `ical_uid`, a confirmation that names recipients | T1 | 1.x |
| 8 | `@slotlock/rooms`: Daily, Whereby, Jitsi/JaaS, static link | T2 | rooms 0.1 |
| 9 | Meeting write-back with Meet and Teams | T2 | sync 0.x |
| 10 | Invitations from notify, with Cloud's controls and the organizer's verified address | T2 | notify 0.x, after the notice cycle |
| 11 | Agent as organizer, with RSVP intake | T2 | later |
| 12 | Hosted documents and limits | T1 | 30 days before each Cloud feature |

Each core PR proves its guarantee with a red-to-green test:
- A booking without a fresh read after its hold is refused.
- A `sync` key cannot manage keys or resources.
- `slotlock_get_invitation` never exposes an internal id.
- A link Slotlock did not make never reaches a message Slotlock sends.

## Decisions (owner, 2026-11-18)

The owner took the recommendation on each of the six open questions.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Does Cloud hold people's provider tokens? (RFC 0004 D1 left it "still the owner's to confirm".) | **Yes.** Cloud runs `@slotlock/sync`, which holds the tokens in its own process, schema and role, sealed under keys wrapped outside the database host (1.4), once its independent review has passed. Core still holds none |
| 2 | Does `confirmAfterRead` start on for a resource with a `live` source? | **Yes, for calendars connected on the dashboard's Calendars page:** the box starts ticked and says agents must hold first; the person can untick it. Nothing else turns it on (2.2) |
| 3 | Who is the default organizer when notify sends invitations? | **The person**, at their verified address, so replies go to them. An agent address with RSVP tracking stays an opt-in for later (4.4) |
| 4 | Daily or Whereby for Cloud's rooms? | **Daily**, with `geo: eu-west-2` set on every room, listed as a US subprocessor with its data processing agreement. Whereby stays an adapter (3.3) |
| 5 | Does Cloud keep users' email addresses? | **Yes, narrowly.** One verified address per person, kept only when they turn on a feature that needs one: sending invitations through notify, and whatever the Claude and ChatGPT connector needs when it ships (Part 7). It is never written to logs, is erased with the account, and is named in PRIVACY.md with 30 days' notice. Everyone else keeps today's rule: the address only in the session cookie |
| 6 | Write the invitee pick page's RFC now, or later? | **Later,** once 4.1 and the room adapter have shipped and show demand. Until then a person picks the time in chat (Part 5) |

Still open, for counsel:
- PECR roles when Cloud sends for a tenant;
- how far Article 50 reaches email agents and a UK provider;
- whether busy intervals reaching another party's agent fit Google's Limited Use rules.

To test before relying on them:
- Google's labels for `calendar.events.owned` and `calendar.freebusy`.
- Meet links from consumer Gmail accounts.
- How MCP clients present a returned `text/calendar` resource.
- How Gmail and Outlook treat an invitation whose `ORGANIZER` domain differs from the sender's.
- Expiry inside Daily tokens.
- Concurrent Zoom meetings per host.

## Sources (read 2026-11-10 to 2026-11-17)

**Slotlock** at `f7fd421`:
- `packages/sync` (README, `src/oauth.ts`, `src/syncer.ts`);
- `packages/notify/README.md`;
- `src/application-api.ts` (`slotlock_put_source_busy`, `slotlock_report_coverage_conflict`);
- `src/store.ts` (`sourceBusyLoss`, `CERTAIN_COVERAGE_MAX_AGE_MS`);
- `src/api-keys.ts`, `src/agent-server.ts`, `src/agent-store-backend.ts`;
- RFC 0004 (P3, A4, B7, D1, D2);
- VERSIONING.md, CONTRIBUTING.md, GOVERNANCE.md, TERMS.md, PRIVACY.md.

**Pylota Identity** at `19e670b`: ADR 0021, `design/vault.md` §8.5, and
`design/calendar-invitations.md` §5 and §15.

**Google:**
[sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
[restricted scopes](https://support.google.com/cloud/answer/13464325),
[unverified apps](https://support.google.com/cloud/answer/15549945),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[quota](https://developers.google.com/workspace/calendar/api/guides/quota),
[create events](https://developers.google.com/workspace/calendar/api/guides/create-events),
[known-sender invitations](https://support.google.com/calendar/answer/13159188),
[Workspace developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

**Microsoft:**
[consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies),
[publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview),
[change notifications](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks),
[online meetings on events](https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings),
[EWS retirement](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online).

**Video:**
[Daily rooms](https://docs.daily.co/reference/rest-api/rooms/create-room),
[Daily pricing](https://www.daily.co/pricing/video-sdk/),
[Whereby meetings](https://docs.whereby.com/reference/whereby-rest-api-reference/meetings),
[JaaS](https://developer.8x8.com/jaas/docs/faq),
[Zoom rate limits](https://developers.zoom.us/docs/api/rate-limits/).

**Mail and abuse:**
[SES pricing](https://aws.amazon.com/ses/pricing/),
[resend-go #179](https://github.com/resend/resend-go/issues/179),
[Calendly phishing report](https://thehackernews.com/2026/06/microsoft-warns-of-photo-zip-phishing.html),
[Doodle invitation limits](https://help.doodle.com/en/articles/9457335-what-are-the-email-invitation-limits).

**Law and standards:**
[PECR regulation 22](https://www.legislation.gov.uk/uksi/2003/2426/regulation/22),
[AI Act Article 50](https://artificialintelligenceact.eu/article/50/),
[RFC 6047](https://www.rfc-editor.org/rfc/rfc6047), [RFC 7986](https://www.rfc-editor.org/rfc/rfc7986),
[draft-ietf-wimse-aims](https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/),
[MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

**Vendors:**
[Cronofy data centres](https://docs.cronofy.com/developers/data-centers/),
[Cronofy status](https://status.cronofy.com/incidents/r7wggzc6hyj9),
[Nylas status](https://status-v3.nylas.com/incidents/r9sp1l8vjzk5),
[Okta Cross App Access](https://developer.okta.com/docs/concepts/xaa/).
