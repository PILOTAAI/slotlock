# Slotlock agent-calendar specification 1.0

This document defines the interoperable scheduling semantics of Slotlock 0.2 and later.
Implementations may use different transports or persistence layers, but must preserve these rules
when claiming compatibility. Which of them may change between releases is in VERSIONING.md.

## Resource model

A resource is the schedulable principal. It has a stable identifier, an IANA timezone, and optional
tenant and external references. Vehicles, rooms, machines, and people are all resources; no semantic
rule assumes a particular industry.

## Time and intervals

- Instants are exchanged as RFC 3339 timestamps and represented by valid JavaScript `Date` values.
- Availability rules use local wall time in the resource's IANA timezone.
- Every interval is half-open `[start, end)`. `end` must be strictly after `start`.
- Adjacent intervals do not conflict. Overlapping or touching availability windows may be merged.
- An event's time zone is an IANA name, kept in its canonical spelling (`europe/london` is stored
  as `Europe/London`). A UTC offset such as `+05:00` is not a zone, and an event in one is refused.
- An event time in an hour the clocks skip moves forward by the gap, and one in an hour they repeat
  is its first instant (RFC 5545 §3.3.5), except where "Daylight-saving time" below says otherwise.
- An availability window's edge in an hour the clocks skip stands where that hour ends, so a window
  holds only the wall times it names that exist: in New York on 2027-03-14, [02:30, 03:30) is
  03:00-03:30 EDT and [02:00, 02:30) is nothing. An edge in a repeated hour is its first instant.

## Daylight-saving time

An occurrence of a timed recurring event starts at its wall time read as above, and ends at the
later of two readings:

- its exact end: its start plus the series' exact length, DTEND − DTSTART as instants (RFC 5545
  §3.8.5.3), or its DURATION, whose days and weeks are calendar days and whose hours, minutes and
  seconds are exact (§3.3.6);
- its wall-clock end: DTEND's wall time as written, carried to the occurrence's date (one written
  in an hour the clocks skip is carried as written), the later instant where the clocks repeat
  that hour. A stored series keeps its first occurrence as instants, and reads this end from its
  end instant.

It occupies `[start, later end)`, so whichever way people read an occurrence that the clocks
change inside, none of the time they hold is offered as free. A stored series' first occurrence
starts at the instant stored, which may be the second pass of a repeated hour. One-off events,
overrides (moved occurrences) and PERIOD RDATEs occupy exactly the times they give. Display and
export keep each event as written. Feeds, the trusted importer and the store read events this way
in every zone, including zones whose rules changed in the past and zones a feed defines only by
its VTIMEZONE.

A series' occurrences never overlap each other. Where one ends after the next starts (24 exact
hours from midnight run to 01:00 the night the clocks go forward, or an occurrence is longer than
the series' period), it ends where the next starts, and the next ends at the later of the two ends.
Together they hold the same time, and the store, which keeps each occurrence as a reservation
under one EXCLUDE constraint, can hold them. Two that start at the same instant are left as they
are. An all-day series occupies whole local days, from one local midnight to the next (a midnight
the clocks skip moves forward).

| Case | Example | Occupies |
| --- | --- | --- |
| The clocks go forward inside an occurrence | London, daily 00:00-06:00, 2027-03-28 | six exact hours, 00:00Z-06:00Z |
| The clocks go back inside an occurrence | London, daily 00:00-06:00, 2026-10-25 | seven wall-clock hours, 2026-10-24 23:00Z-06:00Z |
| The clocks go back, southern hemisphere | Santiago, daily 22:00-04:00, night of 2027-04-03 | seven hours, 2027-04-04 01:00Z-08:00Z |
| The clocks go forward, southern hemisphere | Auckland, daily 00:00-06:00, 2027-09-26 | six hours, 2027-09-25 12:00Z-18:00Z |
| A day long, the clocks go forward | London, daily 00:00-00:00 from 2027-03-26 | on 2027-03-28, 00:00Z-23:00Z, where the next day starts |
| A week long, the clocks go forward | New York, weekly 00:00 for 168 hours from 2027-03-07 | the second week 2027-03-14 05:00Z to 03-21 04:00Z |
| An all-day series | Santiago, daily from 2027-09-03 | on 2027-09-05, 04:00Z (01:00, midnight being skipped) to 09-06 03:00Z |
| An occurrence starts in the skipped hour | Berlin, daily 02:30 for 75 minutes, 2027-03-28 | 75 exact minutes from 01:30Z (03:30 CEST) |
| A half-hour change | Lord Howe, daily 02:00-02:45, 2027-10-03 | 45 minutes from 2027-10-02 15:30Z |
| DTEND falls in the repeated hour | New York, daily 23:00-01:30 from 2026-10-31 | 2026-11-01 03:00Z to the later 01:30, 06:30Z |
| DTEND falls in the skipped hour | New York, daily 01:00-02:30 from 2027-03-14 | the first 06:00Z-07:30Z, as written; later days 90 minutes, to the written 02:30 |
| The first instance spans the change | Berlin, weekly 01:00-04:00 from 2027-03-28 | as written, 00:00Z-02:00Z; later weeks three hours |
| An occurrence starts in the repeated hour | London, daily 01:15-01:45 from 2026-10-20 | on 2026-10-25, its first 01:15 (00:15Z) to the later 01:45 (01:45Z) |
| A stored first occurrence in the repeated hour | London, stored from 2026-10-25 01:15Z | the second 01:15, as stored |
| A length the clocks reduce to nothing | DTSTART and DTEND both in one skipped hour, the end at its close | refused |

A series whose DTSTART the clocks skip is read from a feed (from the offset before the gap) but is
not stored: no instant reads back as its wall time. The same holds for an all-day series whose
first day's midnight the clocks skip (Santiago and Havana go forward at midnight). The trusted
importer stores an all-day series as a timed one from local midnight to local midnight, which the
union rule holds to its exact length too: where the clocks go forward on one of its days, or at the
midnight its first occurrence ends, it may also hold the hour after a midnight that the feed's days
do not, never less. The trusted importer does not store a timed series whose DTEND the clocks skip, or
whose DURATION counts days or weeks outside UTC: kept as its first occurrence's instants, the first
would hold an hour the feed does not on every later day, and the second on each day it spans that
the clocks go forward.

## Availability

Availability is the intersection of explicit bookable windows and the complement of busy intervals.
No rule means no availability. Unsupported or invalid rules contribute no availability. A next-slot
answer must fit wholly inside the resulting free set for the requested positive duration.

Weekly availability supports RRULE cadence with explicit `BYDAY`, interval 1, optional absolute
`UNTIL`, a local start minute, and a positive duration. Rules requiring an authored recurrence anchor
such as `COUNT` or interval greater than 1 fail closed.

## Reservations and holds

- The persistence layer is the final conflict arbiter; an application pre-check is not authority.
- A live hold occupies the same range as a confirmed reservation until its database-clock expiry.
- Confirm and release operations are atomic and idempotent for their expected retry cases.
- A hold lasts at most 7 days from its creation.
- A trailing buffer extends occupied time without changing the customer-visible end instant. It is
  at most 30 days, and holds and reservations alike respect it.
- External commands use `(tenantRef, externalRef)` as stable identity and a strictly increasing
  positive revision. A replay with the same revision and payload is idempotent; drift is rejected.
- Cancellation leaves a revisioned tombstone so delayed delivery cannot resurrect the identity.

## Tenant isolation

Tenant-owned resources require a tenant reference and stable external reference. Forced PostgreSQL
row-level-security policies compare that reference with a transaction-local, namespaced setting and
fail closed when it is absent or empty. Policy application and rebinding are serialized in one
transaction. Store operations use a scoped callback that establishes and restores the context on
the same transaction; a standalone pooled `set_config` call is not sufficient. Applications must
use a non-superuser, non-`BYPASSRLS` role that owns no Slotlock table, holding only schema usage and
DML on the tenant tables.

The same forced, fail-closed policy and live policy fingerprint contract applies to trusted events,
occurrences, event tombstones, event command idempotency rows, and provider coverage rows.

## External calendars

External events are untrusted busy-time inputs, not scheduling authority. An adapter must authenticate
the provider, map a connection to one resource, normalize status/transparency/revision, maintain a
durable cursor and coverage window, and reconcile deletions. iCalendar parsing must remain bounded by
input size, components, exceptions, occurrences, work, and expansion horizon.

A feed's overrides occupy what the provider shows: one without DTEND or DURATION lasts its series'
length, and one whose RECURRENCE-ID names no occurrence, or whose occurrence the series also
EXDATEs, occupies its own time. The instances of a CalDAV-expanded series are each read, the first
with or without a RECURRENCE-ID. An event with both DTEND and DURATION is refused (RFC 5545
§3.6.1). A reader that can name refused series refuses one series at a time and reads the rest of
the feed; one that cannot refuses the feed, so a refused series is never read as free time.

Content not required for conflict decisions should be discarded before reaching an agent. Outbound
iCalendar updates retain stable UID and monotonic sequence; cancellation is explicit.

## Trusted events and occurrences

Trusted event authoring is a separate boundary from provider busy ingestion. An active event belongs
to one tenant-owned resource and has a stable `(tenantRef, externalRef)` identity. Creation uses an
expected revision of zero; every update requires the exact current positive revision. A successful
write binds its tenant-scoped idempotency key to the canonical payload and small result digest. Reusing
the key with drift fails. Cancellation atomically removes derived occupation and leaves a revisioned
tombstone; delayed create delivery cannot resurrect the UID.

Events may carry organizer, attendees, roles, participation status, RSVP requests, display/email
relative reminders, one RFC 5545 RRULE, and bounded recurrence exceptions. A materialization window is
mandatory for recurring events, must not exceed 367 days, and may produce at most 2,000 occurrences.
Expansion is bounded by a count of work, never a clock, so an input is accepted or refused the same
way however loaded the machine: each series may pass 4,000 occurrences from its start, and an
expansion may take 50,000 steps for an event as it is written and 500,000 for a feed or a stored
series as maintenance rolls it. A step of ical.js's search costs three, a weekday it compares one,
a day it walks an eighth, a year it scans three and an eighth for each day that scan lists, and a
weekday of a year it lists half. Each occurrence passed costs one, each conversion of a time in an
IANA zone half (one and a half in a zone only a feed defines), and each instant Intl is asked for
to read a zone's offsets two and a half, charged the first time the expansion reads that day of
the zone whatever was read before it. A zone written the way Outlook writes them, from 1601, costs
about 6,000.

A stored rule is daily or less frequent, follows RFC 5545 §3.3.10's grammar (every part known and
given once, `COUNT` at least 1, never `COUNT` with `UNTIL`), and is of a shape the expander reads
as RFC 5545 does: `BYWEEKNO`, a two-digit `BYDAY` ordinal, `BYSETPOS` other than with
`FREQ=MONTHLY` and `BYDAY` alone, `BYMONTH` with `FREQ=MONTHLY`, a negative `BYMONTHDAY` other
than with `FREQ=MONTHLY` and no `BYDAY`, `FREQ=YEARLY` with `BYMONTHDAY` but no `BYMONTH` or with a
day none of its months has, with `COUNT` or `BYDAY` and a day one of its months can lack, with
`BYYEARDAY` and `BYMONTH` or `BYMONTHDAY`, or with a numbered `BYDAY` and `BYMONTHDAY`, and time
parts with `FREQ=MONTHLY` or `YEARLY` are refused, with a reason. A yearly day some years lack (29
February, or a 31st with April) occurs only in the years that have it (RFC 5545 §3.3.10), so its
rule must be its series' only source of occurrences, with no RDATE or second RRULE. A DATE `UNTIL`
on a timed series includes its whole day on the series' clock.

A recurrence exception names the occurrence it changes by that occurrence's instant, exported as a
UTC `RECURRENCE-ID`; one that names no occurrence is refused. Opaque occurrences are reservations
under the same PostgreSQL EXCLUDE constraint as bookings and holds. Transparent occurrences remain
queryable but occupy no resource. An event update replaces its materialized set transactionally,
so an overlap rolls the entire mutation back and preserves the prior event. An exported calendar
holds a VTIMEZONE (RFC 5545 §3.6.5) for the zone its times name, written from the IANA rules.

Full event content is accepted only by the explicit trusted parser. The provider-normalization parser's
return type contains only identity, recurrence identity, interval, deletion, busy, and revision. A
caller must never route untrusted summaries, locations, descriptions, organizer, or attendee values
through that privacy-minimised boundary.

Provider coverage is explicit and revisioned per `(tenant, resource, source)`. Free/busy responses label
a requested window `complete` only when every caller-required source has a fresh coverage interval that
contains the entire window. Any missing, stale, or partial source is returned by name; absence is never
silently treated as free time.

An event has a finite, positive duration. A one-off event may last up to 3,660 days and its
occupation matches the event exactly; a recurring event's occurrences are materialized as above,
each occupying what "Daylight-saving time" says. An
all-day (`VALUE=DATE`) iCalendar event covers whole local days of the calendar's timezone, from local
midnight to local midnight, taken from the caller's calendar timezone, else the feed's
`X-WR-TIMEZONE`; with neither the input is refused, never read in the server's zone. An all-day
series keeps its day boundaries, and a DATE `UNTIL` becomes that day's local midnight.

RFC 5545 output includes recurrence and exception components. iTIP methods `PUBLISH`, `REQUEST`, `REPLY`,
and `CANCEL` are explicit; a request requires an organizer and attendee, and a reply requires one
attendee. The installed standards library parses every payload before it leaves the package.

## Agent contract

The exported agent server projects one strict operation registry over MCP (revisions 2026-07-28,
2025-11-25 and 2025-06-18, Streamable HTTP, stateless) and synchronous A2A 1.0 JSON-RPC. It separates
deterministic resource/free-busy/search reads from revisioned event writes. Every request is
authenticated to an opaque principal and tenant before tool discovery or dispatch, then authorized
per operation. Protocol input cannot select the tenant. Inputs, outputs, request size, pagination,
recurrence, attendees, reminders, and exposed errors are bounded. Writes require idempotency keys and
updates/deletes require the exact current revision. An LLM never holds a database lock or decides
whether overlapping writes are safe.

### Operation names

Operations are named `slotlock_<verb>` using only `[a-z_]`, which every tool-calling API accepts
(Claude requires `^[a-zA-Z0-9_-]{1,128}$`; OpenAI function names allow the same characters up to 64).
The names of earlier builds, dotted (`calendar.<verb>`) and underscored (`calendar_<verb>`),
resolve to the same operation on every entry point and are never advertised. Any other name is
unknown.

### Outcomes and errors

An operation outcome that an agent can act on (invalid arguments, a refusal, a conflict, a missing
event, an exhausted quota) is a result, not a protocol error:

- MCP returns a tool result with `isError: true` whose text content is `{"error":{"code":"…"}}` and
  which carries no `structuredContent`, because structured content must conform to the tool's
  output schema. A successful result carries the output as both `structuredContent` and JSON text.
- A2A returns the agent's reply message with one `application/json` data part holding the result or
  `{"error":{"code":"…"}}`.

A body must be `application/json`, compared without regard to case (RFC 9110 §8.3.1), or the request
is HTTP 415; one longer than the server's limit is HTTP 413, refused as soon as it passes the limit,
whether or not it declares a `Content-Length`.

Protocol errors stay in the protocol. MCP: an unknown tool, or `arguments` that are not an object
(left out or null is none), is JSON-RPC `-32602`, a server fault
(including backend output that violates the declared schema) is `-32603` with HTTP 500, and a
missing or unsupported `MCP-Protocol-Version` header is HTTP 400. A 2026-07-28 request is checked in
that revision's order, each failure HTTP 400: a missing or malformed `_meta` field is `-32602`, an
`MCP-Protocol-Version`, `Mcp-Method` or (Base64-sentinel-decoded) `Mcp-Name` that disagrees with the
body is `-32020`, and an unimplemented revision is `-32022` naming the supported ones. An
unimplemented method is HTTP 404 `-32601`; a rate-limited request is HTTP 429 `-31029`, outside the
`-32020`..`-32099` range that revision reserves. A2A: every JSON-RPC error travels in an HTTP 200
envelope (a body over the size limit is HTTP 413); A2A's own errors, below, carry a
`google.rpc.ErrorInfo` detail and JSON-RPC's (`-32700`, `-32600`, `-32601`, `-32603`) none. An
`A2A-Version` other than `1.0`, including none (read as 0.3), is `VersionNotSupportedError`
(`-32009`); push-notification methods are
`PushNotificationNotSupportedError` (`-32003`); streaming, task subscription and the extended card
are `UnsupportedOperationError` (`-32004`); a message that is not exactly one data part
`{"skill": "<id>", "arguments": {…}}` (`arguments` left out or null is none; any other value that is
not an object is not arguments) is `-32602`, as is a `configuration` or `metadata` that is set but
is not an object; a rate-limited request is `-32029` with the reason `RATE_LIMITED` and a null id,
answered before its body is read. The server replies with messages and keeps no
tasks, so the core task operations answer as for an unknown task: `GetTask` and `CancelTask` are
`TaskNotFoundError` (`-32001`), `ListTasks` returns an empty page (`pageSize` 1-100, default 50).
Their params are checked first, as `SendMessage`'s are: a field the method does not define, a
`tenant` other than the caller's, a value of the wrong type (a `status` outside `TaskState`, say), a
`statusTimestampAfter` that is not an existing instant in RFC 3339 UTC (`2027-02-30T09:00:00Z` is
not) or a `pageToken` the server never issued (it issues none) is `-32602`. A field without
presence in a2a.proto at its proto3 default (`tenant`, `contextId` or `pageToken` `""`, `status`
`TASK_STATE_UNSPECIFIED`) is read as unset, as proto3 JSON allows an emitter to send it.

### MCP eras

`initialize` selects the 2025 lifecycle and answers the client's own 2025 revision, else 2025-11-25.
Any other request whose `_meta` or `MCP-Protocol-Version` names something other than a 2025 revision
is a 2026-07-28 request: it carries the protocol version, client capabilities and optional client
identity in `_meta`, mirrors them in headers, and needs no prior handshake or session. Results carry
`resultType` and the server's identity; discovery, list and read results carry cache hints (tool,
template and discovery lists `public` for an hour, a tenant's resource list `private` for a minute,
free/busy `private` with `ttlMs` 0). W3C trace context from `_meta`, or else the HTTP headers, is
validated and handed to the backend unchanged.

### Human confirmation

An embedder may require a person's confirmation for any of the three writes. On 2026-07-28, after
authentication, argument validation and authorization pass, the first call answers
`input_required` with one form elicitation (a required boolean) describing the change in words
derived only from the validated arguments, and a `requestState` sealed with HMAC-SHA256 over the
operation, a keyed tag of the principal, a digest of the canonical arguments, an expiry and a nonce.
The write runs only on a retry whose state verifies under a configured key, names the same
operation, principal and arguments, has not expired, and whose response is an explicit `accept` with
the box ticked. A decline or cancel is a result (`confirmation_declined`, `confirmation_cancelled`);
an expired state asks again; any other state or response is `-32602`. A client that did not declare
form elicitation receives `-32021`. Where the protocol cannot carry the question (the 2025 revisions
and A2A) a guarded write fails with `confirmation_required` and never runs.

### Resources and live updates

On 2026-07-28 each resource the principal may list is an MCP resource `slotlock://resources/{id}`,
where the id is percent-encoded as RFC 6570 simple expansion does and only that canonical spelling is
accepted. Reading it returns the resource's busy intervals and coverage over a window of a configured
length (1-367 days) from the start of the current minute. A resource the principal may not read and
one that does not exist both answer `-32602` "Resource not found".

`subscriptions/listen` honors only resource subscriptions, and only for resources the principal may
read when it opens. The response is an SSE stream whose first message acknowledges the honored
subset. The server re-reads the honored resources over one fixed span, from the start of the minute
it opened to the resource window's length plus the subscription's maximum duration after it, which
contains every window a read can return while the subscription is open; the span must fit 367 days.
Each re-read authenticates the original credentials again (the same principal must result) and is
authorized, and the server sends one `notifications/resources/updated` per resource whose content in
that span changed, so the passage of time alone announces nothing. It ends a
subscription gracefully, with the listen request's result, at its maximum duration, on shutdown, or
when a re-read is refused as unauthenticated, unauthorized or not found; it closes the stream without
a result after three consecutive failed re-reads or when the reader leaves more than 256 events
unread. Open subscriptions, counted from the moment they start opening, are capped per principal and
per server. A subscription that honors nothing ends right after its acknowledgment.

### Discovery and authorization

The A2A agent card is served under the public base path and at the origin root
(`/.well-known/agent-card.json`); each skill carries a JSON invocation example. `manifest.json`
publishes every operation's input and output JSON Schema. When configured with OAuth issuers, the
server publishes RFC 9728 protected-resource metadata for its MCP endpoint (path-aware and root
locations) and names it in the `resource_metadata` parameter of the MCP `401` challenge. Issuer
identifiers are published exactly as configured, since clients compare them as strings (RFC 8414),
so each must be a canonical URL without credentials, query or fragment: `https`, or loopback `http`
when `allowInsecureLocalhost` is set. Publishing metadata grants nothing: the embedder's
`authenticate` verifies every token, including its audience.

### Scopes, API keys and the application API

Every authenticated principal carries a tenant and scopes from `read`, `write` and `admin`. A read
operation needs `read`; an event write needs `write`. The application API (resources, weekly hours,
holds, reservations, coverage and maintenance, as REST under `/v1` beside the tools) needs `admin`.
It is never an MCP tool or an A2A skill and never waits for a confirmation.

An API key is a random secret, stored only as its SHA-256 digest and reached only through
`SECURITY DEFINER` functions. It acts in the tenant it was created in, with the scopes it was given
(`read` and `write` by default), until it expires (at most 3,650 days) or is revoked. A tenant holds
at most 100 active keys and 1,000 in all. The digest of a rotated or erased key is kept, so that key
is never valid again. A server's own bearer token is never `admin`.

A dashboard signs a person in with GitHub, asking for no scope, to the tenant `github:<user id>`,
and manages that tenant's keys, resources (at most 100) and weekly hours.

### Maintenance

Recurring events are materialized up to the rolling horizon. Maintenance extends each series to it
and deletes commands and tombstones past the retention window, in bounded batches; a run that
reaches its batch limit says so, and the next run continues. `slotlock serve` maintains each tenant
it serves every hour; `slotlock maintain` and the application API run it on demand.

### Principal-scoped events, quotas and retention

`createSlotlockStoreAgentBackend` is the canonical binding to the PostgreSQL kernel. It derives an
owner from the authenticated tenant and subject and tenant-private event identities from the
caller's idempotency key. Event reads, updates and deletes reach only the calling owner's events;
busy time, free/busy and slot search cover every event on the resource. The backend scopes every
store callback to the authenticated tenant and never calls an interval free unless every required
provider source and every opaque recurrence horizon proves coverage.

Each non-`internal` owner may retain a bounded number of event identities (active plus tombstoned)
and idempotency commands, with one cancellation reserved per identity so an owner can always
release time. Commands are exact-replay evidence for at least the published replay window (30 days
by default). After it, retention may delete commands of every owner, then agent-owned tombstones
with no remaining command; `internal` tombstones remain authoritative until tenant erasure. A
command evaluated after its evidence is gone is decided afresh by the expected-revision guard.

The protocol backend remains injectable so a deployment owns credential verification, policy, rate
limits, and networking. The A2A binding is intentionally synchronous and advertises neither
streaming nor push notifications; an embedder must not claim task lifecycle support unless it
persists that lifecycle itself.

The optional Node HTTP adapter preserves the Fetch boundary rather than defining another protocol
implementation. It constructs callback-visible request URLs from an explicit canonical origin,
rejects absolute-form request targets, applies finite header/body/handler and connection limits,
propagates disconnects through `AbortSignal`, and force-closes only after a bounded graceful-shutdown
window. When it closes it first asks the target to end long-lived responses (the agent server's
`shutdown()`), and closes keep-alive connections whose response finished during shutdown. It exposes
sanitized transport failures and leaves public TLS termination to the deployment. A body the target
stops reading (one past its size limit) does not abort the request: once the response is written,
the rest is discarded as it arrives, within `requestTimeout`. Closing the adapter while it is still
starting rejects the pending `listen()` with `listen_aborted`.
