# Slotlock agent-calendar specification 1.0

This document defines the interoperable scheduling semantics of Slotlock 0.1. Implementations may use
different transports or persistence layers, but must preserve these rules when claiming compatibility.

## Resource model

A resource is the schedulable principal. It has a stable identifier, an IANA timezone, and optional
tenant and external references. Vehicles, rooms, machines, and people are all resources; no semantic
rule assumes a particular industry.

## Time and intervals

- Instants are exchanged as RFC 3339 timestamps and represented by valid JavaScript `Date` values.
- Availability rules use local wall time in the resource's IANA timezone.
- Every interval is half-open `[start, end)`. `end` must be strictly after `start`.
- Adjacent intervals do not conflict. Overlapping or touching availability windows may be merged.
- Daylight-saving gaps move a nonexistent wall time forward by the gap. Ambiguous fall-back wall
  times resolve to the first occurrence.

## Availability

Availability is the intersection of explicit bookable windows and the complement of busy intervals.
No rule means no availability. Unsupported or invalid rules contribute no availability. A next-slot
answer must fit wholly inside the resulting free set for the requested positive duration.

Slotlock 0.1 supports weekly RRULE cadence with explicit `BYDAY`, interval 1, optional absolute
`UNTIL`, a local start minute, and a positive duration. Rules requiring an authored recurrence anchor
such as `COUNT` or interval greater than 1 fail closed.

## Reservations and holds

- The persistence layer is the final conflict arbiter; an application pre-check is not authority.
- A live hold occupies the same range as a confirmed reservation until its database-clock expiry.
- Confirm and release operations are atomic and idempotent for their expected retry cases.
- A trailing buffer extends occupied time without changing the customer-visible end instant.
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
mandatory for recurring events, must not exceed 367 days, and may produce at most 2,000 occurrences
under one 4,000-step work budget. Opaque occurrences are reservations under the same PostgreSQL EXCLUDE
constraint as bookings and holds. Transparent occurrences remain queryable but occupy no resource.
An event update replaces its materialized set transactionally, so an overlap rolls the entire mutation
back and preserves the prior event.

Full event content is accepted only by the explicit trusted parser. The provider-normalization parser's
return type contains only identity, recurrence identity, interval, deletion, busy, and revision. A
caller must never route untrusted summaries, locations, descriptions, organizer, or attendee values
through that privacy-minimised boundary.

Provider coverage is explicit and revisioned per `(tenant, resource, source)`. Free/busy responses label
a requested window `complete` only when every caller-required source has a fresh coverage interval that
contains the entire window. Any missing, stale, or partial source is returned by name; absence is never
silently treated as free time.

An event has a finite, positive duration. A one-off event may last up to 3,660 days and its
occupation matches the event exactly; a recurring event's occurrences are materialized as above. An
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
The names of earlier builds, dotted (`calendar.<verb>`) and underscored (`calendar_<verb>`, the
names Pylota's Kairos endpoint advertised), resolve to the same operation on every entry point and
are never advertised. Any other name is unknown.

### Outcomes and errors

An operation outcome that an agent can act on (invalid arguments, a refusal, a conflict, a missing
event, an exhausted quota) is a result, not a protocol error:

- MCP returns a tool result with `isError: true` whose text content is `{"error":{"code":"…"}}` and
  which carries no `structuredContent`, because structured content must conform to the tool's
  output schema. A successful result carries the output as both `structuredContent` and JSON text.
- A2A returns the agent's reply message with one `application/json` data part holding the result or
  `{"error":{"code":"…"}}`.

Protocol errors stay in the protocol. MCP: an unknown tool is JSON-RPC `-32602`, a server fault
(including backend output that violates the declared schema) is `-32603` with HTTP 500, and a
missing or unsupported `MCP-Protocol-Version` header is HTTP 400. A 2026-07-28 request is checked in
that revision's order, each failure HTTP 400: a missing or malformed `_meta` field is `-32602`, an
`MCP-Protocol-Version`, `Mcp-Method` or (Base64-sentinel-decoded) `Mcp-Name` that disagrees with the
body is `-32020`, and an unimplemented revision is `-32022` naming the supported ones. An
unimplemented method is HTTP 404 `-32601`; a rate-limited request is HTTP 429 `-31029`, outside the
`-32020`..`-32099` range that revision reserves. A2A: every JSON-RPC error travels
in an HTTP 200 envelope with a `google.rpc.ErrorInfo` detail; an `A2A-Version` other than `1.0`,
including none (read as 0.3), is `VersionNotSupportedError` (`-32009`); push-notification methods are
`PushNotificationNotSupportedError` (`-32003`); streaming, task subscription and the extended card
are `UnsupportedOperationError` (`-32004`); a message that is not exactly one data part
`{"skill": "<id>", "arguments": {…}}` is `-32602`. The server replies with messages and keeps no
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
sanitized transport failures and leaves public TLS termination to the deployment.
