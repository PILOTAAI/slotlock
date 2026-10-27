# RFC 0002: What Slotlock needs to be world class, and the plan to get there

| | |
| --- | --- |
| Status | Proposed |
| Target | 0.3.x fixes, then 0.4.0 to 0.6.0 |
| Decision | GOVERNANCE.md: adds agent tools, write-time policy, an event outbox and a history table; needs the maintainer's approval, and an independent security review for every PR marked T2 below |

## Summary

A third-party AI write-up described Slotlock and listed features and edge cases it says a
world-class calendar engine needs. This RFC checks every claim against the code at `e5e1d7e`,
checks the industry comparisons against vendors' current documentation, and measures the
architecture claims on PostgreSQL. All sources were read on 2026-10-27.

The result, in brief:

- **Slotlock's core is ahead of the market.** No scheduling vendor surveyed refuses an overlapping
  write in the database at write time: Cronofy, Nylas, Cal.com, Calendly, Google and Microsoft all
  compute availability, then write in a separate step ([Sources](#sources): C1, N1, K3, L1, G4, M5).
  Slotlock's exclusion constraint is the property the others lack.
- **The write-up gets three things wrong about Slotlock.** Agents cannot hold a slot (holds are
  application-API only), "unproven" time is never enforced on writes, and human confirmation is
  off by default and carried by the client rather than waiting on the server.
- **Its architecture verdict is mostly wrong.** Exclusion constraints shard cleanly by resource,
  discrete slot arrays measured 0.84× to 2.3× the constraint's throughput (not "orders of
  magnitude"), and constraint solvers complement Slotlock rather than replace it.
- **The real gaps are in the booking model, not the engine:** agent holds and linked alternatives,
  all-or-nothing bookings across resources, pools of interchangeable resources, booking rules
  enforced on writes, an event feed, history, and time zone rule changes.
- **The audit found two defects to fix first** (P0 below): idempotent recurring creates fail after
  UTC midnight, and a hold's expiry is judged at the start of a caller's transaction.

## How the write-up holds up

### Claims about Slotlock

| Claim | Verdict | What is true |
| --- | --- | --- |
| Overlaps are refused by `EXCLUDE USING gist`; the loser gets an overlap as data | **True** | `EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, COALESCE(occupied_ends_at, ends_at)) WITH &&)` on `slotlock.reservations` (`src/ddl.ts`); 23P01 becomes `{ ok: false, code: 'overlap' }` (`src/store.ts`) |
| MCP and A2A, usable from Claude Code and Cursor | **True** | MCP 2026-07-28, 2025-11-25 and 2025-06-18; A2A 1.0 without streaming or push |
| Find → Hold → Confirm, holds expire on the database clock, no cron | **Partly wrong** | Holds expire on the database's `now()` and are reaped by the next writer. But the agent tools have **no hold step**: holds are in the TypeScript store and the admin-scoped application API, which `src/application-api.ts` says are "never MCP tools or A2A skills". Agents find a slot, then create an event |
| Unread feeds make time unproven, not free | **Partly true** | Free/busy reports coverage for the sources an integrator names in `requiredSources`; `slotlock serve` names none. **No write checks coverage**, so an agent can book into unproven time. Slotlock does not fetch feeds itself |
| Idempotency keys replay the original result | **True, with a defect** | Same key and arguments replay; different arguments give `idempotency_conflict`. Defect: see P0-1 |
| Writes return `confirmation_required`, sealed with HMAC-SHA256, and wait for a human | **Misdescribed** | Off by default (`SLOTLOCK_CONFIRM_WRITES=none`). On MCP 2026-07-28 the server asks for confirmation with a form and an HMAC-sealed state the client carries back; nothing waits on the server. `428 confirmation_required` is what other clients get. The state's nonce is not recorded (P1-11) |
| RLS from the app's authentication callback | **True** | Forced, fail-closed RLS on every tenant table; the tenant comes only from `authenticate` |
| Apache-2.0, no CLA, PostgreSQL 16–18, npm and Docker | **True** | DCO sign-off instead of a CLA |

### Suggested features and edge cases

| Item | Today | Verdict |
| --- | --- | --- |
| Atomic multi-resource booking | Possible only as several writes in one `withTenant` transaction in the library; REST and MCP write one resource per call | **Gap** (P1-2) |
| Linked alternative holds | None | **Gap** (P1-1) |
| Buffers per resource type | Trailing buffer only, set per write (agent events get none); no leading buffer, minimum notice, horizon or step | **Gap** (P1-4) |
| Hold-confirm expiry race | Safe: confirm locks the hold `FOR UPDATE` and checks expiry in the same transaction, so confirm and reap exclude each other. A confirm can lose just before expiry, never overlap | **Already handled**, one refinement (P0-2) |
| Time zone rule changes after booking | Instants plus zone names; series re-expanded on their daily roll; single events shift wall time silently | **Gap** (P1-7) |
| Feed outage for 48 hours | Coverage goes stale after 24 h (configurable); time becomes unproven | Behaviour is right; **health signals missing** (P1-8). The write-up's fix, "treat past patterns as soft holds", is rejected: it books into time Slotlock cannot prove free, which is the bug the product exists to prevent |
| "Distributed consensus for physical assets" positioning | — | Rejected as wording: Slotlock's claim is narrower and stronger, one database decides each write |

### Architecture claims, measured

**(a) "Exclusion constraints can't be distributed; global systems use Raft, Redlock or Spanner."
Mostly false.**

- Overlap only exists within one resource, so sharding by resource keeps every check on one shard
  with no cross-shard consensus.
- PostgreSQL 17 and 18 allow an exclusion constraint on a partitioned table when it compares every
  partition key column with `=`. Slotlock's constraint already has that shape for `resource_id`.
  PostgreSQL 16 needs it per leaf partition, which is just as correct.
- Citus accepts exclusion constraints that compare the distribution column with equality, so
  distributing by `resource_id` works.
- Aurora and Neon run real PostgreSQL with `btree_gist`. CockroachDB, YugabyteDB and Spanner have no
  range exclusion, so Slotlock does not target them.
- Multi-region writes for one resource still need one ordering point; Spanner also routes all writes
  through a leader region. The PostgreSQL equivalent is a home region per tenant.
- Redlock is not a substitute: Kleppmann shows a lock without storage-side fencing is unsafe, and
  Redis's own docs now say to implement fencing tokens. The constraint is that fence, applied
  atomically with the write.

**(b) "Discrete slot arrays with CAS are orders of magnitude faster." False as stated.**

`pgbench`, 8 clients, 8 s per run, 4 CPUs, PostgreSQL 16.15 at defaults; one booking per
transaction through a function that catches the conflict. "Slots" is one row per 15-minute slot with
a primary key, so a 1-hour booking writes 4 rows. Attempts per second:

| Workload | Durable commits | Range constraint | Slot rows | Slots ÷ range |
| --- | --- | --- | --- | --- |
| Non-overlapping, 1 resource | on | 6,694 | 9,718 | 1.45× |
| Non-overlapping, 1,000 resources | on | 7,310 | 8,584 | 1.17× |
| Saturated single resource (mostly refused) | on | 3,237 | 7,511 | 2.3× |
| Contended, 1,000 resources | on | 8,780 | 7,340 | 0.84× |
| Non-overlapping, 1 resource | off | 12,113 | 40,084 | 3.3× |

Single short runs; treat gaps under 15% as noise. Slot rows also fix the granularity (Slotlock's
millisecond buffers would round), grow with booking length, and took about 2.2× the storage. The
range constraint stays. P2-1 adds a benchmark harness to the repository so these numbers are
reproducible and tracked.

**(c) "Industrial scheduling uses DAG or constraint solvers a SQL constraint cannot replace." True,
but a false choice.** Timefold and OR-Tools CP-SAT optimise a snapshot of a whole planning problem;
neither arbitrates two simultaneous requests for one car. They compose: the solver proposes, Slotlock
commits, and an `overlap` means the plan is stale and is solved again (P2-6 documents the pattern).

## Where world class sits

What vendors treat as table stakes, from their current documentation:

- **Booking rules:** buffers before and after (Cronofy, Nylas 0–120 min, Cal.com, Microsoft Bookings,
  Skedda); minimum notice and a booking horizon (Cal.com, Microsoft, Exchange rooms 0–1,080 days);
  a slot step (Cronofy 5–60 min, Nylas `interval_minutes`).
- **Group availability:** everyone-free and round robin (Nylas `max-fairness`, `max-availability`);
  Cronofy's "any N of M" and sequenced bookings of up to five steps.
- **Capacity:** seats per slot (Cal.com, Microsoft). Rental sells by vehicle class, not plate.
- **Holds:** Cal.com reserves a slot for 5 minutes by default; nobody exposes an expiring hold to
  agents.
- **Changes:** reschedule and cancellation cutoffs; check-in and no-show release (Skedda, Robin).
- **Events out:** signed, retried webhooks (Nylas 3 attempts, Calendly 24 h then disabled, Graph 4 h
  and "dropped notifications can't be recovered").
- **Enterprise:** SOC 2 Type II and ISO 27001 (Cronofy, Nylas, Cal.com, Calendly), a GDPR DPA,
  data regions (Cronofy 6, Nylas US and EU), a 99.99% uptime commitment (Cronofy), SSO, SCIM and
  audit logs (Calendly).
- **Agent products:** Google's Calendar MCP (Developer Preview, warns about prompt injection), Cronofy's
  (no dynamic client registration), Nylas's (confirmation hash for email only, none for events),
  Calendly's (bookings capped at 10 a minute). **None makes check-then-book atomic, and none offers
  an expiring hold.** That is Slotlock's opening.

## P0: correctness and security fixes (0.3.x)

Each is T2 (idempotency, authorization or locking) and ships alone with a red-to-green test.

**P0-1. Idempotent recurring creates after UTC midnight.** A recurring event's command hash includes
the materialization window (`store.ts`, the event command hash), and the window is
`calendarEventRollingHorizon()`, which starts at the current UTC midnight. A retry with the same key
and arguments after midnight hashes differently and gets `idempotency_conflict` instead of the first
result. *Fix:* hash the request (event content, resource, recurrence), not the window derived from
the clock. *Test:* create a recurring event, move the clock past UTC midnight, retry: `replayed:
true`.

**P0-2. Hold expiry inside a caller's long transaction.** In savepoint mode `now()` is the caller's
transaction start, so a hold can be confirmed up to that transaction's age after it expired.
*Fix:* judge expiry with `statement_timestamp()` in confirm and reap, and document a
`transaction_timeout` for callers on PostgreSQL 17+. *Test:* open a transaction, wait past a hold's
expiry, confirm inside it: `hold_expired`.

**P0-3. The README's production checklist still describes erasure by hand.** Its *Erasure* item
tells integrators to delete Slotlock's tables in their own workflow and order, though `slotlock
tenant erase` (and the store's erase) removes everything in one transaction under an exclusive
tenant lock. *Fix:* point the item at the command and the store call; the docs tests pin it.

## P1: the booking model (0.4.0 and 0.5.0)

**P1-1. Agent holds and linked alternatives (T2).**
- Tools `slotlock_hold_slot`, `slotlock_confirm_hold`, `slotlock_release_hold`, with a TTL of 30 s
  to 15 min, scoped like events (an agent sees its own holds).
- `slotlock_hold_slots` takes up to five candidate slots and holds all that are free in one
  transaction, linked by a group id with one TTL; confirming one releases the rest in the same
  transaction.
- Confirmation (`SLOTLOCK_CONFIRM_WRITES`) applies to confirm, not to hold, because a hold expires
  on its own. Per-agent hold quotas bound how much time an agent can block.
- The MCP Apps picker (PR #78) gains a mode where the agent holds the candidates first, so the
  person picks from time that cannot be taken while they decide.
- *Test:* hold three, confirm the second, the other two are free; a hold past its TTL blocks
  nothing.

**P1-2. All-or-nothing across resources, and "any N of M" (T2).**
- `slotlock_book_together` writes one interval on up to 20 resources in one transaction, inserting
  in `(resource_id, starts_at)` order so two bundles cannot deadlock; any overlap refuses the whole
  bundle and names the resource and interval that refused it.
- `slotlock_find_available_slots` gains `require: "all" | { any: n }` for collective and
  any-N availability.
- *Test:* two concurrent bundles over the same resources in opposite order: one wins, one is
  refused, no deadlock error escapes.

**P1-3. Pools: book by class, not by unit (T2).**
- A pool is a named set of interchangeable resources (a vehicle class, a room type). Capacity is
  the number of members; seats are a pool of seat resources.
- Booking a pool tries members in a stable order inside one transaction and takes the first the
  constraint accepts, so the guarantee stays the exclusion constraint's. The booking records the
  member, and moving it to another member is a reschedule.
- Free/busy for a pool reports how many members are free per interval.
- *Test:* five vans, six concurrent bookings of the class for one hour: five succeed, one is refused.

**P1-4. Booking rules enforced on writes (T1).**
- Per resource (and defaulted per pool or tenant): leading and trailing buffers, minimum notice,
  maximum horizon, slot step and alignment, and enforcement of bookable hours and of coverage
  (`require_certain`).
- Search and writes share one rule evaluator, so a slot that search offers is a slot a write
  accepts, and a write outside the rules is refused with the rule it broke.
- Defaults keep today's behaviour; each rule is opt-in.
- *Test:* a resource with 15-minute buffers and 2-hour notice refuses a booking 1 hour out and one
  that abuts another booking.

**P1-5. Events out: a transactional outbox and webhooks (T2).**
- Every committed change appends to an outbox in the same transaction, so no change is lost or
  delivered without committing.
- Delivery follows Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`), with
  retries and backoff for 24 hours, then the endpoint is disabled and the tenant notified. The
  payload is a CloudEvents 1.0 envelope.
- A cursor API replays the feed, so a consumer that was down catches up without gaps. MCP resource
  subscriptions and A2A push read the same feed, replacing the 10-second poll.
- *Test:* kill delivery mid-batch, restart: every event arrives once per `webhook-id`, in order per
  resource.

**P1-6. History (T2).** An append-only change table: who (key id, agent subject), what (operation,
before and after), when, from where. Readable per resource and per event, retained per tenant
policy, erased with the tenant. *Test:* update then cancel an event, read its history: two entries
naming the key.

**P1-7. Time zone rule changes (T1).**
- Store each event's wall time and zone beside its instant (series already keep their rule).
- Record the tzdata version the server runs (`process.versions.tz`) and expose it in health.
- When it changes, maintenance re-resolves future single events written in local time and flags the
  ones whose instant moved. A moved event that now overlaps stays where it was and is reported:
  the constraint never lets two bookings overlap, so a human or agent decides.
- *Test:* run with a zone rule changed under the store (a fake tzdata), see the flagged event.
  Manitoba's change on 2026-10-31, announced a month earlier in tzdata 2026e, is the live example.

**P1-8. Feed health (T1).** Per-source coverage age, last success and last error in the API, the
dashboard and metrics, and a webhook when a required source goes stale. No fallback that treats
unread time as free.

**P1-9. Errors and headers (T1).** RFC 9457 problem details for every refusal, the conflict typed
with the resource and interval. `Idempotency-Key` accepted as a header per
draft-ietf-httpapi-idempotency-key-header-08 (400 when missing where required, 422 on reuse with a
different payload) with the expiry policy published.

**P1-10. Shared rate limits (T1).** Limits are per process today, so N instances allow N times the
rate. Move the counters to PostgreSQL (or a pluggable store), keeping the per-process limit as a
first line.

**P1-11. Single-use confirmation state (T2).** The sealed state is bound to the operation, the
principal and the exact arguments, and carries a nonce that is never recorded
(`src/agent-server.ts`, the confirmation gate). An accepted state can be sent again until it
expires. Today that is contained: a replayed create carries the same idempotency key and returns
the first result, and a replayed update or delete carries a revision that is already stale. Record
each accepted nonce until its expiry so the guarantee does not rest on those two properties.
*Test:* accept once, replay the state with a fresh idempotency key: refused.

## P2: scale, interop and enterprise (0.6.0 and the hosted service)

1. **Benchmarks in the repository:** the pgbench workloads above as a script, run on release, with
   results in the docs.
2. **Partitioning by resource** on PostgreSQL 17+, and a documented Citus layout distributed by
   `resource_id`. Read replicas for free/busy with a freshness bound.
3. **A home region per tenant** for multi-region hosting; no cross-region writes for one resource.
4. **Interop:** VAVAILABILITY (RFC 7953) import and export for bookable hours, JSCalendar (RFC 8984)
   export, and RFC 9557 zoned timestamps where an API takes local time. Provider sync (Google,
   Microsoft, CalDAV) stays out of core, as adapter packages over the coverage API.
5. **Operations:** OpenTelemetry traces and metrics, published SLOs, a status page, documented
   backups and point-in-time-recovery targets.
6. **A solver guide:** Timefold or OR-Tools proposes a plan, Slotlock commits it, `overlap` triggers
   a re-solve.
7. **Hosted service:** SOC 2 Type II and ISO 27001 path, a DPA, data regions, SSO and SCIM for the
   dashboard. These are company work, listed so the product does not block them.
8. **Waitlists and no-show release:** a waitlist per slot or pool, offered in order when a booking
   is cancelled; optional check-in that releases a booking left unclaimed.

## Non-goals

- Replacing the exclusion constraint with slot rows, a distributed lock or an external consensus
  service.
- CockroachDB, YugabyteDB or Spanner as stores: none has range exclusion.
- Treating unread time as free under any policy.
- Notifying people (email, SMS) or a human calendar app; integrators build those on the event feed.

## Delivery

Each line is one PR with its own red-to-green test. T2 PRs need an independent security review
before merge (GOVERNANCE.md).

| # | PR | Tier | Release |
| --- | --- | --- | --- |
| 1 | P0-1 idempotent recurring creates across midnight | T2 | 0.3.1 |
| 2 | P0-2 hold expiry by statement time | T2 | 0.3.1 |
| 3 | P0-3 erasure docs | T0 | 0.3.1 |
| 4 | P1-11 single-use confirmation state | T2 | 0.3.1 |
| 5 | P1-4 booking rules and one evaluator for search and writes | T1 | 0.4.0 |
| 6 | P1-1 agent holds and linked alternatives | T2 | 0.4.0 |
| 7 | P1-9 problem details and the Idempotency-Key header | T1 | 0.4.0 |
| 8 | P1-5 outbox, webhooks and the replay cursor | T2 | 0.4.0 |
| 9 | P1-2 bundles and any-N availability | T2 | 0.5.0 |
| 10 | P1-3 pools | T2 | 0.5.0 |
| 11 | P1-6 history | T2 | 0.5.0 |
| 12 | P1-7 time zone rule changes | T1 | 0.5.0 |
| 13 | P1-8 feed health, P1-10 shared limits | T1 | 0.5.0 |
| 14+ | P2, in the order listed | T1–T2 | 0.6.0 |

RFC 0001 (deploy to a VPS or Cloudflare) runs alongside; PR 8's outbox is designed to work through
Hyperdrive (transaction-scoped only).

## Open questions

1. Should `require_certain` default to on for agent writes in 0.5.0, a behaviour change for
   integrators who never record coverage?
2. Pool members in a stable order concentrate wear on the first members. Is round robin or
   least-used needed in the first version?
3. Does history store before and after values in full, or a diff, for events with large
   descriptions?

## Sources

All read 2026-10-27. The full notes with every quote are kept with the PR.

**Slotlock code** (at `e5e1d7e`): `src/ddl.ts` (constraint), `src/store.ts` (holds, the event
command hash, `calendarEventRollingHorizon`), `src/application-api.ts` (holds are not agent tools),
`src/mcp-modern.ts` (sealed confirmation state), `src/agent-server.ts` (tools), `src/rate-limit.ts`.

**Vendors:** Cronofy [availability](https://docs.cronofy.com/api-reference/availability-control/availability/),
[sequenced availability](https://docs.cronofy.com/api-reference/availability-control/sequenced-availability/),
[MCP server](https://docs.cronofy.com/developers/mcp-server/index.md),
[security](https://www.cronofy.com/security); Nylas
[availability](https://developer.nylas.com/docs/v3/calendar/calendar-availability/),
[Scheduler](https://developer.nylas.com/docs/v3/scheduler/),
[webhooks](https://developer.nylas.com/docs/v3/notifications/webhooks/),
[MCP](https://developer.nylas.com/docs/dev-guide/mcp/); Cal.com
[reserve a slot](https://cal.com/docs/api-reference/v2/slots/reserve-a-slot.md),
[event types](https://cal.com/docs/api-reference/v2/event-types/create-an-event-type.md),
[webhooks](https://cal.com/docs/developing/guides/automation/webhooks.md); Calendly
[agents](https://developer.calendly.com/schedule-events-with-ai-agents),
[rate limits](https://developer.calendly.com/api-docs/overview/rate-limits.md); Google
[push](https://developers.google.com/workspace/calendar/api/guides/push),
[sync](https://developers.google.com/workspace/calendar/api/guides/sync),
[events](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[Calendar MCP](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server);
Microsoft [findMeetingTimes](https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes),
[Bookings scheduling policy](https://learn.microsoft.com/en-us/graph/api/resources/bookingschedulingpolicy),
[Set-CalendarProcessing](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-calendarprocessing),
[webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks);
Skedda [buffers](https://support.skedda.com/en/articles/3653032-buffer-time) and
[check-in](https://support.skedda.com/en/articles/5242690-check-in).

**Standards:** [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.txt),
[RFC 7953](https://www.rfc-editor.org/rfc/rfc7953.txt) (VAVAILABILITY),
[RFC 6638](https://www.rfc-editor.org/rfc/rfc6638.txt), RFC 8984 (JSCalendar), RFC 9457, RFC 9557;
[Idempotency-Key draft 08](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.txt);
[Standard Webhooks](https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/main/spec/standard-webhooks.md);
[CloudEvents](https://raw.githubusercontent.com/cloudevents/spec/main/README.md);
[MCP tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools);
[A2A](https://a2a-protocol.org/latest/specification/).

**Time zones:** [tzdb NEWS](https://data.iana.org/time-zones/tzdb/NEWS) (2026e, Manitoba),
[PostgreSQL 18.6](https://www.postgresql.org/docs/release/18.6/),
[Node.js Intl](https://nodejs.org/api/intl.html),
[invalid date/time input](https://www.postgresql.org/docs/current/datetime-invalid-input.html),
[Temporal.ZonedDateTime](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/ZonedDateTime).

**Architecture:** PostgreSQL [partitioning 16](https://www.postgresql.org/docs/16/ddl-partitioning.html),
[17](https://www.postgresql.org/docs/17/ddl-partitioning.html) and
[18](https://www.postgresql.org/docs/18/ddl-partitioning.html),
[17 release notes](https://www.postgresql.org/docs/release/17.0/),
[18 release notes](https://www.postgresql.org/docs/release/18.0/),
[explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html),
[date/time functions](https://www.postgresql.org/docs/16/functions-datetime.html);
CockroachDB [PostgreSQL compatibility](https://www.cockroachlabs.com/docs/stable/postgresql-compatibility);
YugabyteDB [feature support](https://docs.yugabyte.com/stable/api/ysql/sql-feature-support);
Spanner [PostgreSQL types](https://cloud.google.com/spanner/docs/reference/postgresql/data-types) and
[instance configurations](https://cloud.google.com/spanner/docs/instance-configurations);
[Aurora extensions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html);
[Neon extensions](https://neon.com/docs/extensions/pg-extensions);
Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html);
Redis [distributed locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/);
[Timefold](https://docs.timefold.ai/timefold-solver/latest/introduction);
[OR-Tools CP-SAT](https://developers.google.com/optimization/cp/cp_solver).
