# RFC 0004: The agent calendar baseline: where Slotlock stands, and the plan to close the gaps

| | |
| --- | --- |
| Status | Proposed |
| Target | P0 now; then 0.7.0 to 0.9.0 |
| Decision | GOVERNANCE.md: the maintainer approves; every T2 line below needs an independent security review. Part 3 reverses two non-goals of RFC 0002 and is the owner's call. |

## Summary

An external review described what a calendar for agents needs:
- the industry baseline (an availability engine, resources and capacity, a booking lifecycle,
  notifications and the platform basics);
- what makes it agent-native (holds with a TTL, idempotency, recoverable errors, a small semantic
  tool set, scoped agent identity, guardrails, contention, a sandbox);
- how to build it (PostgreSQL with an exclusion constraint, holds as rows, availability computed
  on read, API first, event-driven).

This RFC checks every item against the code on `claude/inspiring-dijkstra-bfvqif` at `d10e16d`. It
records a verdict and evidence for each, and plans the work that is missing. The checks were done
on 2026-11-10 by reading the code paths and their tests, not the docs.

In brief:

- **The architecture the review recommends is the one Slotlock has.** It uses PostgreSQL with a
  `tstzrange` exclusion constraint per resource (and per composite). Holds are rows reaped on write
  and hourly. Availability is computed on read. There is a REST API with OpenAPI, wrapped by MCP and
  A2A, and an outbox drives webhooks, history and usage. The review's Phase 1 is complete. Its
  Phase 2 is complete except provider free/busy adapters.
- **Of 42 items, 20 are present, 17 partial and 5 absent.** The absences are availability
  exceptions and holidays, cancellation policies, customer payments, notifications, and data
  export.
  - The first three are product gaps.
  - Notifications were a deliberate non-goal in RFC 0002, as were provider sync adapters, which
    are partial: the coverage machinery is in core, but nothing fetches from Google or Microsoft.
  - Export is promised in PRIVACY.md but done by hand.
- **The agent-native core is ahead of the market.** Holds, idempotent agent writes, rows held by
  the database and RLS-scoped keys are all in place. Its gaps are about recovery and control:
  - a refused write gets no alternative slots;
  - there is no dry run;
  - there are no conditional approval policies;
  - there is no simulated clock or seeded sandbox.
- **The audit found seven small defects** (P0). For example, a no-show is also announced as a
  cancellation, and confirming a hold through the application API leaves its sibling holds held.
  One is fixed in this change: the webhook limit stated in the API.

## Part 0: is RFC 0003 complete end to end?

**No.** Every planned item and gap is built and tested against real PostgreSQL, and against
fakes of each third party's documented API. None has run against the live third parties, and
nothing is deployed. These are the owner's checks before launch:

| What | Verified so far | Still to run |
| --- | --- | --- |
| Stripe checkout, portal, cancellation | Test mode: checkout sessions with Managed Payments are created by Slotlock's own code | One paid checkout and one cancellation, live |
| Metered overage | Test mode: a metered price is accepted in a Managed Payments checkout, and meter events and resent events behave as coded | A paid test subscription showing the meter on its invoice |
| Partner invoice items | Against a fake of the documented API | One real month close against a Stripe customer |
| Google sign-in, GitHub Teams | Against fakes, with real signature checks | A sign-in with real accounts on the deployed Worker |
| OpenTelemetry | Payload shapes | One export to a real collector |
| Cloudflare Worker | `wrangler deploy --dry-run` bundles | A deploy |
| Dashboard | Rendered in Chromium on real PostgreSQL, desktop and phone | Real GitHub sign-in |
| T2 changes of RFC 0003 | Tests | The independent security reviews |
| CI | Green on `54418cf` | The run on `d10e16d` |

## Part 1: the scorecard

Present means a code path and a test. Partial means part of the item is missing, as stated.
Evidence names the function or table. Line numbers move, so they are given only where they matter.

### Availability engine

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| Working hours | Partial (B2 built since) | `resources.availability_rules`, `expandRules` (rules.ts), tests in resource-hours | Tenant hours are only copied onto existing resources (`setTenantAvailability`), so a new resource does not inherit them. Hours block writes only with the `enforceHours` rule |
| Exceptions and holidays | **Absent** (B1 built since) | — | Closed dates, extra openings and holiday calendars, per tenant, location or resource. The VAVAILABILITY import refuses RDATE and EXDATE (interop.ts) |
| Buffers before and after | Present | The occupied range under the constraint (ddl.ts), `bookingJudge` | — |
| Minimum notice, booking horizon | Present | `bookingRuleBroken` on the database clock | The agent search uses the server clock (`new Date()`) where writes use the database's |
| Slot duration rules | Partial | Step and offset (booking-rules.ts) | A default duration, allowed durations, and a minimum or maximum length |
| RFC 5545 recurrence | Present | ical.js for events, rrule for hours, an RFC 5545 oracle test; shapes it cannot do right fail closed | — |
| UTC plus IANA zone, DST | Present | timezone.ts on `Intl`; DST oracle, corpus and property tests | Zone rule changes reach future one-off events only: series occurrences and reservations are not re-checked |

### Resources and capacity

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| People, rooms, vehicles | Present | Profile kinds (resource-profile.ts) | — |
| Capacity above 1 | Partial | Pools of identical units and composites of parts, both held by constraints | Seats on one resource: `capacity` is informational. A counter cannot be an exclusion constraint (RFC 0002), so this needs a seat pool, not a counter |
| Multi-resource bookings | Partial | `bookTogether`: one transaction, locks in sorted order | A multi-resource hold (`hold_slots` holds alternatives, not a set). The application API has no `book_together` or `book_pool` |
| Round robin, pooled | Present | `pool_settings`, `bookPool`, pools tests | The round-robin pointer is a plain UPDATE (`notePoolBooking`), so concurrent bookings can skew the rotation (never double-book). `least_booked` counts bookings, not hours |
| Multi-day bookings (car rental) | Partial | Hours windows up to a week, events up to 3,660 days, a trailing buffer up to 30 days | A minimum or maximum rental length, pick-up and return times, a day-based search, and rule buffers over a day |

### Booking lifecycle

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| Statuses | Partial | Rows are `held` or `confirmed`; check-in is `checked_in_at`; cancelled and no-show are tombstones and feed events | `completed` and `rescheduled`; why a booking ended (the tombstone has no reason); a written state machine |
| Reschedule | Present | `rescheduleExternalReservation`: same row, revision plus one, with the before state on the feed | A `reservation.rescheduled` type (it is `reservation.updated`) |
| Cancellation and reschedule policies | **Absent** | — | Cutoffs before the start, enforced on writes; a fee recorded for the integrator |
| Waitlists | Present, with gaps | `offerWaitlist` makes a hold; waitlist tests | Matching a range or a pool, not one exact window; `accepted`, `declined` and `lapsed`; join and leave events; an idempotency key on join |
| Deposits and payments | **Absent** | Stripe code is Slotlock's own billing | A hold that waits for a payment, and a payment reference on the booking |
| Check-in and no-show release | Present | `checkInReservation`, `releaseNoShows` | A no-show is announced twice (P0-1) |

### Notifications

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| Email, SMS, WhatsApp | **Absent** (RFC 0002 non-goal) | Reminders are stored (`calendar_event_reminders`), and iTIP text is built (`emitITipCalendar`); nothing sends either | Part 3 |
| Webhooks and an event stream | Present | CloudEvents, Standard Webhooks signatures, ordered at-least-once delivery with a stored cursor, filters, SSRF guard, retries to 10 h, `GET /v1/changes` replay | `hold.expired` is written when the hold is reaped, not when it lapses. There is no public SSE stream |

### Platform

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| Multi-tenancy | Present | Forced RLS on every tenant table, isolation tests | — |
| RBAC | Partial | Key scopes `read`, `write`, `admin`, `partner`; keys limited to locations or groups by RLS | People have only GitHub's owner and member. Any member may make a full `admin` key. There are no viewer role, invites outside GitHub, or per-person resource limits |
| Audit log | Partial | The outbox records actor, origin and key for every change; history API; dashboard activity | It is kept 30 days, erased with the tenant, and the serving role may UPDATE and DELETE it, so it is not append-only. Reads are not recorded |
| GDPR deletion | Partial | `erase_tenant`, `POST /v1/tenant/erase`, `slotlock tenant erase` | Erasing one person (an attendee's email, a waitlist holder, a reference kept in tombstones) without erasing the tenant |
| GDPR export | **Absent** | PRIVACY.md promises a copy on request | A tenant export command and API |

### What makes it agent-native

| Item | Verdict | Evidence | What is missing |
| --- | --- | --- | --- |
| Holds with a TTL, search, hold, confirm | Present | `slotlock_hold_slots` (30–900 s), linked alternatives released on booking, reaped on write and hourly | An expired hold is `hold_not_found` to agents but `hold_expired` in the application API. The application API's `confirm_hold` leaves sibling holds held (P0-3) |
| Idempotency on every write | Partial | Required on every agent write; same key with another payload is `idempotency_conflict`; event keys kept 30 days | `join_waitlist`, `create_webhook`, `create_location`, `create_group` and the partner and maintenance POSTs take no key |
| Structured errors with alternatives | Partial | RFC 9457 problems with stable codes; the store names the booking in the way | **No alternative slots.** The agent surface drops the conflicting booking's id (`operationError`). `hold_slots` refusals carry only an index and a code |
| MCP plus OpenAPI, few semantic tools | Present | 14 tools, A2A skills from the same list, OpenAPI and five clients generated and tested | No tools named confirm, reschedule or cancel (they are `create_event` with `hold_id`, `update_event`, `delete_event`). Some parameters are nested, and some descriptions are jargon |
| Agent identity and scoped credentials | Partial | Per-key scopes, keys limited by RLS, per-holder hold caps, per-key rate buckets, the actor on every change | An OAuth authorization server (only discovery metadata is published). Limits set per key (hold caps, rates, which writes need confirmation) |
| Guardrails, human in the loop, dry run | Partial | `SLOTLOCK_CONFIRM_WRITES` per operation (428), assistant approve and dismiss | Approval policies ("over 4 hours needs approval"), per tenant or per key. Holds cannot be guarded. **No dry run** |
| Contention | Present | Exclusion constraints, sorted locks, one retry, races of 2–6 in tests | A high fan-out test (100 agents on one slot through REST), and benchmarks against the real store, not a stand-in schema |
| Sandbox and simulation | Partial | `slk_test_` keys in `<tenant>~test`, held apart by the database | Seed data, a simulated clock and a scenario runner |
| Untrusted text in tool results | Partial | The dashboard assistant treats tool results as data; confirmation prompts are sanitised | The MCP instructions do not say that titles, descriptions and locations are data, not instructions |
| Rate limits | Present | Token buckets per address, key, tenant and server; `RateLimit` fields; shared limits optional | — |

### How it is built (the review's "best way")

| Item | Verdict | Note |
| --- | --- | --- |
| PostgreSQL, `tstzrange`, exclusion constraint per resource | Present | The core. Composites add `composite_claims` under a second constraint |
| Holds are rows, released by a worker | Present | Reaped by the next write and by hourly maintenance. No Redis |
| Availability computed on read, cached briefly | Present, no cache | Bounded instead (10,000 busy intervals and 100,000 rule windows per request). A cache is not needed at today's sizes, and a stale cache is a correctness risk for agents |
| API first, MCP second | Present | The application API and the agent API share one backend. MCP and A2A wrap it |
| Don't hand-roll time logic | Partial | ical.js and rrule for recurrence. Zone arithmetic is hand-written on `Intl`, held by DST oracle and property tests. Move to Temporal once every supported runtime ships it |
| Sync read-mostly first | Partial | Coverage, feed parsing and staleness are in core, as designed. The adapters that fetch from Google, Microsoft or an ICS URL are missing (part 3) |
| Event-driven internals | Present | The outbox drives webhooks, history, usage and waitlist offers |

### The review's phases

- **Phase 1** (resources, rules, holds, bookings, exclusion constraint, REST, webhooks): complete.
- **Phase 2** (MCP, agent keys and scopes, idempotency, structured errors, Google and Microsoft
  free/busy): complete except the free/busy adapters, alternatives in errors, and idempotency on
  four application writes.
- **Phase 3** (two-way sync, payments, approvals and policies, multi-resource bookings, sandbox):
  - multi-resource bookings are done, but not holds;
  - the sandbox is half done;
  - approvals are per operation only;
  - two-way sync and payments are absent.

## Part 2: the plan

Each line is one PR with its own red-to-green test, as before. Tiers follow GOVERNANCE.md.

### P0: defects from this audit (now, T1 unless marked)

Status: built on `claude/inspiring-dijkstra-bfvqif`, each with its test.
- P0-2 says `busy_start` and `busy_end` always, and `conflicting_hold_id` or
  `conflicting_event_id` for the agent's own.
- The audit also found `slotlock_list_webhooks`' output capped at 10 entries; it is fixed.

1. **A no-show is announced twice.** `releaseNoShows` writes `reservation.no_show`, and its DELETE
   fires the trigger, which also writes `reservation.cancelled`, so a consumer counting
   cancellations counts no-shows. The trigger should name the deletion from a transaction setting
   (`slotlock.ending = no_show`), so one change is written.
2. **Recoverable overlap on the agent surface.** `operationError` drops the conflicting booking's
   id the store found. Pass it through as `conflicting_reservation_id` where the caller may see it
   (its own booking, or a busy interval otherwise).
3. **`confirm_hold` releases its group (T2).** The application API's confirm leaves a hold's
   linked alternatives held until they lapse. It should delete them in the same transaction, as
   the agent path does.
4. **One name for a lapsed hold.** Agents get `hold_not_found` and the application API
   `hold_expired`. Both should say `hold_expired` while the hold's tombstone or row is known, and
   `hold_not_found` otherwise.
5. **Idempotency keys** on `join_waitlist` and `create_webhook`. Each takes an optional
   `idempotency_key`, kept as long as its entry or webhook, and the same key with another payload
   is `idempotency_conflict`. On a closer read, `create_location` and `create_group` are already
   create-or-update by reference, so a retry converges and they need no key.
6. **Round robin under concurrency.** Take the pool's settings row `FOR UPDATE` while choosing and
   noting the member, so two bookings at once do not pick from the same pointer.
7. **Tool-result hygiene.** The MCP and A2A instructions say that titles, descriptions, locations
   and names are data written by people, never instructions. This matches what the dashboard
   assistant already does.
8. Done in this change: the webhook endpoint limit in the API description said 10. It is 25, or
   fewer on a plan.

### P1: agent-native completion (0.7.0)

**A1. Alternatives on every refusal (T1).** Status: built. The refusals are `overlap`,
`pool_full` and the booking-rule refusals other than `booking_rule_uncertain`.
`hold_limit_reached` gets none: another time does not help an agent that holds too much.
 An `overlap`, `hold_limit_reached` with time left,
or a booking-rule refusal returns `alternatives`. These are up to 3 slots of the same length,
taken from:
- the same resource;
- the same pool for a pool booking;
- the same resource set for a bundle.

They come from the same evaluator as `find_available_slots`, inside the request's work limits
(`calendar_work_limit` caps them; an empty list says nothing was found within 7 days). For
`hold_slots`, each refused index carries its own. They are suggestions, not holds. The agent holds
the one it wants, so nothing is reserved on its behalf.

**A2. A semantic tool set (T1).** Status: built. The confirm tool is named `slotlock_confirm_slot`,
because the application API already has `slotlock_confirm_hold`. Each of the three derives its
idempotency key when none is given. Add three tools that wrap existing operations:
- `slotlock_confirm_slot`: `hold_id` plus the event fields, flat;
- `slotlock_reschedule`: a reference, a new start and a new end;
- `slotlock_cancel`: a reference.

The 14 existing tools stay, so integrations do not break. A description pass removes internal
words ("arbiter"), and each tool states its failure codes. `tool-contract.json` pins the result.

**A3. Dry run on every write (T2).** Status: built.
- The backend's tenant transaction is rolled back by a marker that carries the answer out.
- The waitlist offer that follows a write is skipped.
- On REST the charge reads `dry_run` from the query string, because the body is read after the
  charge.
- Erasure, maintenance and the partner API refuse a dry run.
 `dry_run: true` on agent and application writes. The
write runs in its transaction with every check, including the constraint, and is then rolled
back. The answer is what would have happened (`would_create`, or the refusal with A1's
alternatives). A dry run counts as a read for rate limits and quotas, writes no history and
fires no webhooks.

**A4. Approval policies (T2).** Status: built, with D3's dynamic wait. As built:

- A policy names resources, pools, locations (with those inside) and groups, or every resource,
  and narrows them by `longer_than_minutes`, `outside_hours` and `kinds` (`single`, `pool`,
  `bundle`, `move`). Six admin operations keep and decide them (`/v1/approval-policies`,
  `/v1/approvals`, `POST /v1/approvals/{id}/decision`), and the dashboard has an Approvals page.
- A covered write is first tried as A3's dry run, so it meets every check and the constraint as it
  would. `require_approval` then holds the exact time it would occupy (a move only what its event
  does not already take), with the approval as the holder, so the agent cannot release it and it
  does not count against the agent's hold caps. The agent sees `409 approval_pending` with the
  approval's id and expiry.
- A grant runs the stored request as the agent that asked, in one transaction with letting the
  holds go and marking the approval granted. The agent's retry with the same key answers the
  booking as a replay; a decline or expiry frees the time and the retry says so.
- The two conditions on agents (a key without a `trusted` flag, more than N bookings a day) belong
  to A5's per-key settings and are not built here. A recurring series is refused
  (`approval_series_unsupported`): its occurrences cannot all be held.

The plan as proposed: a tenant's policies, each a condition and an outcome:

- Conditions:
  - longer than N minutes;
  - outside the resource's hours;
  - a pool or bundle booking;
  - a booking by a key without the `trusted` flag;
  - more than N bookings by one agent in a day.
- Outcomes:
  - `require_approval`: the write becomes a hold with status `held`, an approval record, and a
    TTL up to 24 hours;
  - `refuse`.

People approve or decline in the dashboard, or with `POST /v1/approvals/{id}`. The feed records
`approval.requested`, `approval.granted` and `approval.declined`. An agent sees
`approval_pending` with the hold's id and expiry, and can wait on the feed. This replaces nothing:
`SLOTLOCK_CONFIRM_WRITES` stays for interactive confirmation.

**A5. Agent identity (T2).** Status: per-key settings built; OAuth waits on decision D2.
- Built: a key's live holds, held hours and requests a minute, each only lowering the server's,
  and `requires_approval`, which holds every booking it makes for a person under A4 (policy
  `api-key`). Kept in `api_key_limits` (owner-only), set from the CLI, the dashboard and the
  partner API, carried on the principal, and enforced by the store's hold caps, the limiter and
  A4's gate. Per-write confirmation stays the server's (`SLOTLOCK_CONFIRM_WRITES`).
- As proposed: settings per key: a hold cap, a rate, and which writes need confirmation or approval. These
  override the tenant's settings, never upwards past the plan.
- OAuth 2.1 for MCP clients, for the hosted service. An authorization server with client ID
  metadata documents (no open dynamic registration) issues tokens bound to a key's scopes. Owner
  decision: build it, or use a provider such as WorkOS or Stytch behind the existing
  protected-resource metadata.

**A6. Sandbox and simulation (T2).** Status: built, but for the simulated clock.
- Built: seed (`car-rental`, `clinic`, `desks`), reset, race and fast-forward, from the CLI
  (`slotlock sandbox …`), four admin operations (`/v1/sandbox/seed`, `/race`, `/fast-forward`,
  `/reset`) and the dashboard's Test overview. Each refuses a live tenant; the database's
  `reset_test_tenant` refuses one too, and any tenant but the one the caller acts in.
- Instead of a simulated clock, fast-forward makes what would lapse within N minutes lapse now
  (holds, waitlist offers, approvals) and runs maintenance. That covers what agents most need to
  rehearse (a hold that lapsed, an approval that expired, an offer passed on) without touching
  how production code reads the time. No-shows and series rolls follow the real clock: a
  per-tenant clock offset in every rule, hold and maintenance check would change the write path
  for every tenant, which the T2 review should weigh before it is built.

As proposed:
- `slotlock sandbox seed --scenario car-rental|clinic|desks`, and the same from the dashboard in
  Test. It creates resources, pools, locations, hours and bookings in the test tenant.
  `slotlock sandbox reset` empties it.
- A simulated clock for test tenants only. `slotlock.now()` replaces `statement_timestamp()` in
  rule, hold and maintenance checks: it reads a per-tenant offset kept in a table that live
  tenants cannot write. `POST /v1/sandbox/clock` moves time forward, so holds lapse, no-shows
  release and series roll on demand.
- `slotlock sandbox race --agents 100 --slot ...` runs a contention scenario and reports winners,
  refusals and alternatives.

**A7. Contention at scale (T1).** Status: built.
- `contention.integration.test.ts`: 100 REST clients, each its own agent, race for one slot after
  a warm-up round. One books it, 99 get `overlap` with alternatives, none a 5xx, p99 under a second
  (about 0.45 s locally).
- What the test found: writers racing for the same time each inserted, then waited at the
  exclusion constraint for one another, and PostgreSQL broke each such deadlock only after its
  `deadlock_timeout` (a second). About one race in three took 4 to 20 seconds, though every answer
  was right. Booking writes now lock the resource (and a part's composite parent), in id order,
  `FOR NO KEY UPDATE`, right before they write its occupied time: writers take turns for that
  last step only, each meets the winner's committed row and is refused at once. The checks before
  it keep a key-share lock, which never conflicts with the one that follows, so two writers cannot
  deadlock upgrading. Archive and delete wait for a write as before.
- Also: a refusal's alternatives now come from one read (`findNextSlots`) instead of one
  transaction a slot (67 queries a refused request down to 49), and time zone names resolve once
  a process.
- `scripts/bench.mjs` runs three write workloads against the real schema too, where it is applied
  (the release job applies it), as a fourth column: about 4,100 bookings a second on 1,000
  resources locally, against 11,900 for the bare constraint.

As proposed:
- A CI test where 100 concurrent REST clients race for one slot. Exactly one wins; 99 get
  `overlap` with alternatives; no 5xx; p99 under 1 s on the CI database.
- The pgbench workloads run against the real schema, not the stand-in.

### P2: booking model completion (0.8.0)

**B1. Availability exceptions and holidays (T2).** Status: built. A table `availability_exceptions`:
- scope: tenant, location (inherited by its resources) or resource;
- a date range in the scope's zone;
- an outcome: `closed`, or `open` with its own hours for those dates;
- a label.

One evaluator applies them to search and, with `enforceHours`, to writes. Holiday calendars are
imported from an ICS URL or file as `closed` exceptions. VAVAILABILITY import and export carry
RDATE and EXDATE.

As built:
- Each exception covers whole local days, read in each resource's own time zone. A tenant has no
  zone, and a location's is optional, so the day a holiday names is the day where the resource is.
- Where several fall on one day, they apply widest first: the tenant's, then each location's from
  the outermost in, then the resource's own. The nearest wins.
- At most 5,000 a tenant, each at most 367 days and 4 windows.
- A holiday calendar's all-day events become closures. Recurring ones are expanded over a span of
  at most three years. Timed and cancelled events are skipped. An import keys each closure by the
  event's UID and day, so importing again updates instead of adding.
- `serve` fetches a URL through the guarded fetch. A library backend fetches none unless given one.
- The export writes the coming year's closures as EXDATEs on the weekly AVAILABLEs. Special hours
  are AVAILABLEs repeated by RDATE. The import turns EXDATE, RDATE and single AVAILABLEs into the
  resource's own exceptions, replacing those its last import made.
- Exceptions are tenant data under row-level security. A key limited to some resources reads the
  tenant's and locations' exceptions, which shape its resources' hours, and only its own
  resources' exceptions.

**B2. Hours that inherit (T1).** Status: built. Stored hours per tenant and per location. A resource without
its own uses its location's, then its tenant's, then the server's. A new resource inherits.
`setTenantAvailability` stops copying.

As built: `availability_defaults` holds the tenant's and each location's rules. The database
function `slotlock.inherited_availability` finds the nearest, and every resource read carries it.
`setTenantAvailability` now answers `{ inheriting, ownHours }`. Hours an earlier version copied stay
a resource's own until `overrideResources` clears them. Clearing them silently would have changed
hours an owner may have set on purpose.

**B3. Durations and multi-day (T1).** Status: built.
- Booking rules gain:
  - `minDurationMinutes`, `maxDurationMinutes`, `allowedDurations` and `defaultDuration`;
  - `pickupTimes` and `returnTimes`: daily windows a multi-day booking must start and end in;
  - turnaround over a day.
- `find_available_ranges` finds N-day ranges for a resource or a pool, from a pick-up window to
  a return window. This is the car-rental search.

As built:
- The default is `defaultDurationMinutes`. A search that names no length takes it when its
  resources agree on one, else answers `400 duration_required`.
- A hire is a booking whose last moment falls on a later local day than its start. One ending at
  midnight stays on its day. Pick-up times are half-open, and a return may end exactly at its
  window's end.
- Under `enforceHours`, a hire needs only its start and end inside the hours. The resource is out
  between them.
- Turnaround goes to a week. The calendar event's buffer check was widened to match, added
  `NOT VALID` first.
- `slotlock_find_available_ranges` answers one range per resource, the earliest. It takes a
  number of days (the same local time N days on, across clock changes) or a return window (the
  earliest return it allows). The search judges each candidate with the write's own rules, so an
  offered range is one the write accepts. Searches always honour hours, as slot searches do.
- Building B3 found a bug: a tenant's store judged enforced hours against no hours for resources
  on the server's default, and refused every such write. Fixed.

**B4. A written lifecycle (T2).** Status: built.
- Each status and transition is documented, with a table test of every allowed move and a
  refusal for each other.
- The tombstone keeps why the booking ended: `cancelled`, `no_show`, `released`, `expired` or
  `erased`.
- New feed types `reservation.rescheduled` and `reservation.completed`. The second is written by
  maintenance when a confirmed booking ends; it holds no row.
- `reservation.updated` stays for compatibility.

As built: `src/lifecycle.ts` holds the table. It was written from what the store does, not from
what it might do. A booking that has ended may still be moved (a system of record's correction) or
cancelled (a void), and only check-in and no-show refuse it (`reservation_ended`). Holds leave no
tombstone, so `released` and `expired` live on the feed. Erasure removes the tombstones with
everything else. `reservation.completed` covers bookings that ended in the last week, so the first
pass after an upgrade does not flood the feed with old ones.

**B5. Cancellation and reschedule policies (T2).** Status: built.
- Rules `cancelCutoffMinutes` and `rescheduleCutoffMinutes`, enforced on writes
  (`booking_rule_cancel_cutoff`). An admin key may override with a reason, which goes into
  history.
- `cancellationFee` is recorded on the cancellation for the integrator to charge. Slotlock never
  moves money for it.

As built:
- The application API is admin-only, so its cancel and move take `override_reason`. Agents' cancels
  and moves of their own events are held to the cutoffs with no override.
- The fee is `{ amountMinor, currency, withinMinutes? }`. A late cancellation answers it, and its
  tombstone and feed change keep it.
- A recurring series is not held to the cutoffs: cancelling it cancels what is still to come.

**B6. Waitlists that match (T1).**
- An entry matches any slot of its length within its window, on a resource or a pool.
- Entries can be `accepted`, `declined` and `lapsed`, with feed events for join, offer, accept,
  decline and leave.
- Join is idempotent (P0-5).

**B7. Holds across resources (T2).** `hold_together` holds a set (driver and car) all or
nothing, under one group with one TTL. Confirming it books the set. The application API gains
`book_together` and `book_pool`.

**B8. Seats (T2).** `capacity: N` on create makes N seat resources in a pool behind one
resource. A booking of `seats: k` takes k free seats in one transaction. The guarantee stays the
exclusion constraint; the API shows one resource with capacity.

**B9. Zone rule changes reach everything (T1).** `followZoneRules` also re-checks stored series
occurrences, and reservations that carry a wall time (a new optional `local_start`).

### P3: integrations (0.9.0, the owner's decision)

RFC 0002 made notifications and provider sync non-goals of core. The review treats them as
baseline, and buyers do too. The proposal keeps core as it is (it never sends a message and never
holds a provider token). It adds three packages on the event feed and the coverage API, and runs
them on Cloud:

**C1. Free/busy adapters (T2).**
- `@slotlock/sync-google` (the Calendar freeBusy API), `@slotlock/sync-microsoft` (Graph
  `getSchedule`) and an ICS URL poller.
- Each tenant connects with OAuth, and tokens are kept encrypted in the adapter's store.
- The adapter writes busy intervals through the coverage API, so staleness and `requireCertain`
  apply as now.
- Read-only.

**C2. Notifications (T1 for the package, T2 for Cloud's sending).**
- `@slotlock/notify` subscribes to the feed and sends confirmations and reminders by email
  (SES or Postmark), SMS and WhatsApp (Twilio).
- Reminders come from `calendar_event_reminders`.
- Per-tenant templates and sender, with an opt-out per recipient.
- On Cloud it is a paid add-on with per-message pricing.

**C3. Payments for bookings (T2).**
- A hold may require a payment (`payment_required: true`, TTL up to 30 minutes, a
  `payment_ref`). Confirming it needs the integrator's payment confirmation, through
  `POST /v1/holds/{id}/paid` or a Stripe adapter verifying a PaymentIntent on the tenant's own
  Stripe account.
- Slotlock records payment state and never processes money. Managed Payments cannot carry
  marketplace flows, so this is the tenant's own account, not Slotlock's.

**C4. Two-way sync (T2, last).** Confirmed bookings are written to the connected Google or
Microsoft calendar by the C1 adapters. Slotlock stays the source of truth. A change made in the
provider comes back as coverage and is reported as a conflict, never applied silently.

### P4: platform (alongside)

**D1. Roles for people (T2).**
- Roles `owner`, `admin`, `member` and `viewer` within a tenant, from GitHub or by invitation
  (for Google accounts).
- Only `owner` and `admin` make `admin` keys, webhooks and policy changes.
- `viewer` reads.
- A person's access may be limited to locations or groups, reusing G6's policy.

**D2. An audit log that cannot be edited (T2).**
- Revoke UPDATE and DELETE on the outbox from the serving role, and prune through a definer
  function.
- Retention by plan: 30 days Free, 90 Developer, 400 Team.
- `GET /v1/audit` exports it.
- Optionally, a hash chain per tenant, checked by `slotlock audit verify`.

**D3. Data export and per-person erasure (T2).**
- `slotlock tenant export` and `POST /v1/tenant/export` write NDJSON per table to a signed
  download, asynchronously for large tenants.
- `slotlock subject erase --email | --holder | --reference` removes:
  - one person's attendee entries;
  - their waitlist entries;
  - references in tombstones and the feed.

  The bookings stay, as time taken.
- PRIVACY.md's "on request" becomes self-service.

**D4. The enterprise track** stays as RFC 0003 lists it (SOC 2, an SLA, a second region, SSO and
SCIM). It is company work.

## For car rental (Pylota's case)

- Model vehicles as resources of kind `vehicle`.
- Put them in pools by class (ACRISS codes), at locations for branches.
- Book multi-day ranges with pick-up and return windows (B3).
- Make turnaround the cleaning and hand-over buffer: explicit buffers already reach 30 days, and
  B3 lifts the rule limit past a day.
- Take deposits through payment-required holds (C3).
- Holidays close branches (B1).

What the review calls the main design choice is already Slotlock's: whole ranges under an
exclusion constraint, not short slots. B3 adds the search that range booking needs.

## Delivery

| # | PR | Tier | Release |
| --- | --- | --- | --- |
| 1 | P0-1 to P0-7 audit defects | T1 (P0-3 T2) | 0.6.4 |
| 2 | A1 alternatives on refusal | T1 | 0.7.0 |
| 3 | A2 semantic tools and descriptions | T1 | 0.7.0 |
| 4 | A3 dry run | T2 | 0.7.0 |
| 5 | A7 contention at scale | T1 | 0.7.0 |
| 6 | A6 sandbox: seed, reset, clock, race | T2 | 0.7.0 |
| 7 | A4 approval policies | T2 | 0.7.0 |
| 8 | A5 per-key limits; OAuth decision | T2 | 0.7.x |
| 9 | B1 exceptions and holidays, B2 inherited hours | T2 | 0.8.0 |
| 10 | B3 durations and multi-day search | T1 | 0.8.0 |
| 11 | B4 lifecycle, B5 policies | T2 | 0.8.0 |
| 12 | B6 waitlists, B7 holds across resources, B8 seats | T1–T2 | 0.8.0 |
| 13 | B9 zone rules | T1 | 0.8.0 |
| 14 | D1 roles, D2 audit, D3 export and subject erasure | T2 | 0.8.x |
| 15 | C1 free/busy adapters | T2 | 0.9.0 |
| 16 | C2 notifications | T1/T2 | 0.9.0 |
| 17 | C3 payment holds | T2 | 0.9.0 |
| 18 | C4 two-way sync | T2 | after 0.9.0 |

## Decisions under discussion (researched 2026-11-10)

The owner asked for research on five open questions before deciding. Each gives a recommendation
and the evidence for it; none is built until the owner agrees.

### D1. Notifications and calendar sync: in core, or packages?

**Recommendation: keep both out of core, as packages on the feed, but put four primitives in core
first.**

What other products do:
- Cal.com moved its main code private in April 2026 and kept calendar sync in the MIT edition.
  Reminders, SMS and WhatsApp became commercial
  ([Cal.com](https://cal.com/blog/cal-diy-open-source-to-closed-source)).
- Nylas makes sending an optional layer that can be turned off
  ([Nylas](https://developer.nylas.com/docs/v3/scheduler/customize-scheduler.md)).
- Cronofy leaves sending to the application
  ([Cronofy](https://docs.cronofy.com/developers/smart-invites/)).
- Stored provider tokens are the target: in the Salesloft Drift breach, stolen OAuth tokens were
  the way in
  ([Google](https://cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift)).
  Core keeps three runtime dependencies and no secrets that a self-hoster never uses.

What core adds first:
- a `reminder.due` change when a stored reminder falls due;
- the feed's change id documented as the send key;
- a reference to the recipient's channel and consent, erased with the person;
- a per-booking "do not notify" flag.

The order, each a separate process with its own schema, role and secrets (core's role cannot read
tokens):
1. An ICS URL poller, guarded against SSRF.
2. Read-only Google and Microsoft adapters on the narrowest scopes: `calendar.freebusy`, and
   `Calendars.ReadBasic` for `getSchedule`
   ([Graph](https://learn.microsoft.com/en-us/graph/permissions-reference)). Calendar scopes are
   Google "sensitive" (app verification, no CASA assessment).
3. Email: the self-hoster's own SMTP, SES, Postmark or Resend. On Cloud, only from a domain the
   tenant has verified, with SES tenant isolation.
4. SMS through the tenant's own Twilio or Vonage first, so the tenant is the sender of record
   (A2P 10DLC registers a brand and campaign per sender:
   [Twilio](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv.md)).
5. WhatsApp through the tenant's own WhatsApp Business account.
6. Two-way write-back last.

Every send is recorded first under a unique key (change id, channel, recipient), so an outbox
replay never sends twice.

### D2. OAuth for MCP clients: build, or a provider?

**Recommendation: build the authorization server into `slotlock serve`, on panva's `oidc-provider`
(OpenID Certified, MIT) and PostgreSQL, and keep `slk_` keys for headless agents.**

Why build:
- Self-hosters cannot depend on a SaaS.
- Every peer probed (Stripe, Linear, Notion, Sentry, Cal.com, Atlassian, Calendly) issues MCP
  tokens from its own domain.

How it works:
- Each grant becomes a delegated key: the same scopes, location and group limits, row-level
  security and history.
- Clients register by CIMD and DCR, and air-gapped installs can pre-register. Claude and ChatGPT
  prefer CIMD, Cursor has only DCR, and MCP 2026-07-28 deprecates DCR. DCR is therefore
  rate-limited, and a client unused for 90 days expires. This reverses A5's "no open DCR".
- Tokens are opaque and stored hashed. Access tokens last an hour; refresh tokens rotate and
  expire after 30 days idle or 90 days in all.
- Grants can be revoked (RFC 7009), and the dashboard gets a "Connected apps" page.
- `slotlock:write` comes by step-up; `admin` stays for keys only.

Cost and stopgap:
- About 4–6 engineer-weeks and an external security review: running an authorization server is
  security-critical, and `workers-oauth-provider` had a PKCE bypass in 2025.
- If Cloud needs OAuth sooner, WorkOS AuthKit (free up to 1M monthly active users) can stand in
  behind the same protected-resource metadata.

### D3. How long an approval may wait

**Decision (owner): it depends on the rules and the business, not a fixed 24 hours.**

A4 builds it this way (built):
- Each policy sets its own wait (`approval_ttl_minutes`, a day when it names none).
- The wait is always bounded:
  - by the booking's start, less the policy's lead time (`lead_minutes`), so an approval cannot
    outlive the time it holds; one too close to its start is `approval_too_late`;
  - by the server's maximum: 30 days, which a library user can lower with the agent backend's
    `maxApprovalMinutes`.
- Where several policies apply, the one that must be decided soonest sets the wait.
- A pending approval holds its time, so a long wait is a business choice the policy makes
  explicit.

### D4. Seats for large venues

**Recommendation: not N unit resources. One resource whose bookings each claim a span of seat
indices, under `EXCLUDE (resource_id =, occupied &&, seat_span &&)`.** This is the mechanism
composites already use.

Measured on PostgreSQL 16, with 32 clients and 2,000 seats, N unit resources fail three ways:
- Pool booking tries members one by one, so contention made 7 bookings in 60 s, with 97
  deadlocks.
- Pools stop at 100 members.
- Seat-level rows refuse bookings that fit: at capacity 2, after 9–10 and 11–12, a 9:30–11:30
  booking is refused although the peak is 2.

Span claims:
- One row per booking, however many seats.
- General admission is any free span; a named seat is a fixed index; "4 together" is a contiguous
  span; the whole venue is `[0,∞)`.
- 425–880 bookings a second, with a per-resource lock for throughput only.
- The guarantee stays declarative: the constraint, a CHECK that a span lies inside
  `[0, capacity)` and a generated `seats` column prove that the seats in use at any instant never
  exceed capacity.

Risks:
- The new constraint cannot be added `NOT VALID`, so the migration takes an exclusive lock and
  needs a window on Cloud.
- A three-column index costs every insert; to be benchmarked.
- Fragmentation can under-admit. A booking can be split into fragments under one group.
- An exact counted mode can come later if under-admission matters.

Cal.com counts seats in application code; ticketing and hotels count at sale and assign later. No
competitor publishes a database guarantee.

### D5. Prices for notifications and sandbox features

**Recommendation:**

Email:
- Included: Free 500 a month, Developer 10,000, Team 50,000 pooled, sent through SES with each
  tenant isolated.
- Then $1 per 1,000 from a prepaid balance.

SMS and WhatsApp:
- A prepaid balance only, with a $25 minimum top-up, never billed afterwards.
- A per-country rate card at Twilio's list price × 1.75, rounded: US SMS $0.025, UK $0.10; US
  WhatsApp utility $0.015. That is about 35% net after Managed Payments (3.5%) and card fees.
- US 10DLC fees are passed on ($25 once, about $3 a month).
- Developer $1 and Team $5 of credit a month, after a first top-up.
- At zero balance, email instead. Rates change with 30 days' notice.
- Benchmarks:
  - Cal.com charges Twilio cost + 80%
    ([Cal.com](https://cal.com/help/billing-and-usage/messaging-credits)).
  - Calendly bundles credits.
  - Fresha sells $0.02 a text after 100.
  - Meta has charged utility templates inside the 24-hour window since 2026-10-01.

Sandbox:
- Free on every plan: test keys, seeded scenarios, the simulated clock, and a race of 10 agents
  (20 runs a day). In Test, SMS and WhatsApp never deliver: they go to a capture inbox.
- Larger by plan, at no extra charge in the first version: Developer 100 agents and runs from CI,
  Team 1,000 agents.
- Stripe, Twilio, Plaid and Clerk all make simulation free with caps.

Caveats:
- Stripe must confirm whether SMS credits are an eligible digital product under Managed Payments.
  If they are not, Cloud offers only the tenant's own provider (D1 step 4) until a second
  processor is set up.
- Top-ups are one-time Checkout payments recorded in Slotlock's own ledger. Stripe credit grants
  apply only to invoices.
- SMS pumping (fraud by triggering sends to premium numbers) is the main fraud risk. Controls:
  sending only to the tenant's own country by default, mobile numbers only, a per-tenant rate,
  built-in templates for new accounts, and top-ups capped at $50 for the first 30 days.

## Open questions

1. Part 3 reverses RFC 0002's non-goals as packages outside core. Is that the line: core never
   sends a message and never holds a provider token?
2. OAuth for MCP: build an authorization server, or use a provider?
3. Approval policies: is a 24-hour maximum for a pending approval right? Should a declined
   approval free the slot at once (it does in this design)?
4. Seats (B8): is "N seat resources behind one" acceptable for a 500-seat venue? The constraint
   holds, but each seat is a row in every search.
5. Prices for notifications (per message) and sandbox scenarios (free on every plan?).

## Sources

The external review (supplied by the owner, 2026-11-10). The code at `d10e16d`: `src/ddl.ts`,
`src/store.ts`, `src/agent-server.ts`, `src/agent-store-backend.ts`, `src/application-api.ts`,
`src/booking-rules.ts`, `src/rules.ts`, `src/timezone.ts`, `src/sync.ts`, `src/interop.ts`,
`src/event-feed.ts`, `src/webhooks.ts`, `src/dashboard.ts`, `src/api-keys.ts`, and their tests.
RFC 0002 for the non-goals, and RFC 0003 for the vendor comparison.
