---
title: MCP and A2A server
seoTitle: 'MCP and A2A server reference | Slotlock'
description: Serve the Slotlock tools from your own application, behind your authentication, and what the server does on the wire.
sidebar:
  label: MCP and A2A server
---

`createSlotlockAgentServer` serves the {{toolCount}} tools over MCP ({{mcpModern}}, {{mcpLegacy}},
{{mcpOlder}}) and A2A {{a2a}} from one HTTP handler. `slotlock serve` is this server configured from
environment variables; embed it when your application owns authentication and tenancy.

## Expose Slotlock to agents

One HTTP handler serves the tools over MCP and A2A. The tenant comes from your `authenticate`, never
from a tool argument.

<!-- code examples/agent-server.ts#server -->

- `authorize` runs on every call with the current tool name, even when a client used an old alias.
  Prefer an allow-list, so a tool added in a later release stays off until you allow it.
- `availabilityRules` returns the default bookable hours, for resources without their own. No
  rules means never bookable.
- `confirmation` makes the listed writes wait for a person ([Confirm before writing](/docs/security/#confirmation-before-writes)).
- `publicBaseUrl` must be HTTPS (`allowInsecureLocalhost` permits `http://localhost` for
  development). Run the Node listener behind a TLS proxy, or mount `server.fetch` in any Fetch
  runtime.
- The server sends no CORS headers: call it from your backend, not a web page.

## Endpoints

| Method and path | What |
| --- | --- |
| `POST {base}/mcp` | MCP over Streamable HTTP, stateless |
| `POST {base}/a2a` | A2A 1.0 JSON-RPC |
| `GET {base}/.well-known/agent-card.json` | A2A agent card, also at the origin root |
| `GET {base}/manifest.json` | Protocol versions, endpoints and every tool's JSON Schemas |
| `GET {base}/healthz` | Readiness from your `health` callback |
| `GET /.well-known/oauth-protected-resource{/path}` | OAuth metadata, when `oauth` is set |
| `{base}/v1/…`, `GET {base}/openapi.json` | [REST API](/docs/reference/#rest-and-openapi) and its OpenAPI 3.1 document, when `rest` is on |

## Errors

Tools return [error codes](/docs/tools/#error-codes) the agent acts on. These are the other two
kinds.

### Errors from your own backend

Throw `new SlotlockAgentOperationError('snake_case_code', status)` and the agent receives the code.
Any other exception is a server fault, and its message never leaves the server: the agent gets
`internal_error`, and `onError(error, { operation })` gets the error, as it does a result outside
the operation's output schema, so you can log it. `slotlock serve` logs it as an `agent_error` line
on stderr.

### Protocol errors

| Where | Error |
| --- | --- |
| HTTP | `401` with `WWW-Authenticate`, `403` disallowed origin, `413`/`415` bad body, `429` rate limit (MCP, REST) |
| MCP | `-32602` unknown tool, `arguments` that are not an object, or altered confirmation; `-32603` server fault; `-32601` unknown method |
| MCP 2026-07-28 | `-32020` header disagrees with body, `-32021` form elicitation not declared, `-32022` unsupported revision, `-31029` rate limit |
| A2A | `-32602` malformed message or parameters, `-32029` rate limit (`RATE_LIMITED`, in the 200 envelope like every A2A error), `-32009` unsupported `A2A-Version`, `-32003` push notifications, `-32004` task subscription or extended card, `-32001` task not found (the server keeps no tasks) |

## Authentication and OAuth discovery

`authenticate` checks whatever bearer token you issue. To let OAuth-capable MCP hosts find your
authorization server, publish RFC 9728 metadata:

<!-- code examples/oauth.ts#oauth -->

A `401` from `/mcp` then points clients at the metadata and asks for `requiredScopes`. Slotlock only
publishes it: `authenticate` must still validate each token, including its audience.

## Confirmation before writes

`confirmation` makes the listed writes wait for a person; see the
[security model](/docs/security/#confirmation-before-writes).

## Calendar resources and live updates

On MCP 2026-07-28 each resource is also an MCP resource, `slotlock://resources/{id}`, whose read
returns busy time and coverage for the next `resourceWindowDays` (30). `subscriptions/listen` streams
`notifications/resources/updated` when a resource's free/busy changes.

- With `subscriptions.changes` (`createSlotlockStoreChangeSource(store, sql)`; `slotlock serve`
  sets it), changes come from the tenant's change feed: one reader per tenant per process, shared by
  all its subscriptions, polls the feed by cursor, one indexed query per read, under the tenant's
  row-level security. It reads again 250 ms after a read that found changes
  (`SLOTLOCK_FEED_BUSY_MS`, also the least gap between two reads) and backs off to once a second
  when quiet (`SLOTLOCK_FEED_IDLE_MS`), so a booking is announced within about a second. A change
  re-reads the subscriptions watching its resource, at most once a second each however many
  changes arrive, and each announces only what actually changed in its window. A cursor the feed
  has pruned past announces every watched resource once, then follows from now.
- Each subscription is also re-read every `pollIntervalMs` (15 s with a feed, 10 s without one,
  which is then the only way changes are found), re-checking the caller each time, so a revoked key
  or what the feed does not carry (bookable hours) is caught.
- A subscription ends after `maxDurationMs` (15 minutes), on `shutdown()`, or when access is lost.
- At most 4 open per caller and 256 per server (`maxPerPrincipal`, `maxTotal`). `maxPerTenant`
  caps one tenant's across all its callers (default `maxTotal`; `slotlock serve` sets 16), so a
  tenant with many keys cannot hold every slot. When the server is full, a tenant holding fewer
  than the tenant holding most, less one, ends that tenant's oldest stream instead of being
  refused, so many tenants cannot hold every slot either. `slotlock serve` sets `maxTotal` to
  `subscriptions` (256) and lets one key hold `key_subscriptions` (4), and always fewer than its
  tenant may unless that is one, so one key cannot lock its tenant's other keys out.
  `subscriptions: false` turns them off.

## Caching and tracing

2026-07-28 results carry cache hints: discovery and tool lists are public for an hour, free/busy is
never cached. W3C `traceparent`, `tracestate` and `baggage` reach your backend as `context.trace`.

`onEvent` hears about every call that names an operation, so you can count, time and correlate them:

- `{ type: 'call', protocol, operation, outcome, durationMs, traceId? }` for an MCP `tools/call` or
  A2A `SendMessage`; `outcome` is `ok`, the refusal's code (`overlap`, `rate_limited`, …), or why
  it was refused before it ran: `invalid_arguments`, `missing_capability` (a guarded write from a
  client that cannot confirm), `invalid_message` or `invalid_message_parameters` (A2A).
- `{ type: 'rest', operation, status, durationMs, traceId? }` for a REST call, or one refused before
  it ran: a body that is not JSON (415, 400), too large (413) or not an object (400).
- `{ type: 'confirmation', operation, outcome }` for each confirmation, before the call it decides.
- A request refused before its operation is read is not reported: a missing credential, the rate
  limit, an `A2A-Version` other than 1.0, a JSON-RPC envelope that does not parse, a path no route
  has.
- `traceId` is the trace id of a valid `traceparent` from `_meta` or the header. Arguments, callers,
  the parent span, `tracestate` and `baggage` are never reported, and an `onEvent` or `onError` that
  throws, or returns a promise that rejects, changes nothing a client sees. Resource reads and
  subscription polls are not reported.

`slotlock serve` writes each as a JSON line (`"event":"call"`, `duration_ms`, `trace_id`).

## REST and OpenAPI

`rest: true` also serves each tool as plain HTTP, described by an OpenAPI 3.1 document at
`/openapi.json`. `slotlock serve` has it on; `SLOTLOCK_REST_API=off` turns it off.

| Request | Tool |
| --- | --- |
| `GET /v1/resources` | `slotlock_list_resources` |
| `GET /v1/free-busy` | `slotlock_get_free_busy` |
| `GET /v1/next-available` | `slotlock_find_next_available` |
| `GET /v1/available-slots` | `slotlock_find_available_slots` |
| `POST /v1/slot-holds` | `slotlock_hold_slots` |
| `DELETE /v1/slot-holds/{hold_id}` | `slotlock_release_slots` |
| `POST /v1/slot-holds/{hold_id}/confirm` | `slotlock_confirm_slot` |
| `POST /v1/bundles` | `slotlock_book_together` |
| `POST /v1/pool-bookings` | `slotlock_book_pool` |
| `GET /v1/pool-availability` | `slotlock_get_pool_availability` |
| `GET /v1/events` | `slotlock_list_events` |
| `POST /v1/events` | `slotlock_create_event` |
| `GET /v1/events/{event_id}` | `slotlock_get_event` |
| `PATCH /v1/events/{event_id}` | `slotlock_update_event` |
| `POST /v1/events/{event_id}/reschedule` | `slotlock_reschedule` |
| `POST /v1/events/{event_id}/cancel` | `slotlock_cancel` |
| `DELETE /v1/events/{event_id}` | `slotlock_delete_event` |

```sh
curl "http://localhost:8080/v1/resources" -H "Authorization: Bearer $SLOTLOCK_API_KEY"
```

- `GET` and `DELETE` take the tool's arguments as query parameters (a list repeats:
  `resource_ids=a&resource_ids=b`); `POST`, `PUT` and `PATCH` take a JSON body. Ids are in the path;
  percent-encode one that holds `/`.
- Keys, scopes, `authorize` and the rate limit apply as over MCP. The body is the tool's output, or
  an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with
  the matching HTTP status: `type` (a tag URI, one per code), `title`, `status`, `code`, and
  `error.code` as well, the body earlier clients read. An `overlap` names the `resource_id`, `start`
  and `end` it refused. A `Link: <…>; rel="describedby"` header points at these docs.
- A write's `idempotency_key` may come as the `Idempotency-Key` header instead
  ([draft 08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)): a
  quoted Structured Field String (`Idempotency-Key: "booking-BK-42"`) or the bare key, equal to the
  argument when both are sent. A write that needs one and gets neither answers
  `400 idempotency_key_required`; the same key with another request, `422 idempotency_conflict`.
  An event write's key is kept 30 days (or `SLOTLOCK_RETENTION_DAYS`), then removed by maintenance,
  after which the key is new; a
  hold's until the hold would have expired, is released or is confirmed.
- REST cannot ask a person, so a write listed in `confirmation` answers `428 confirmation_required`.
- Free/busy and the next-available search read each resource they name once, however often it is
  named, and 10,000 busy intervals in all; the next-available search also expands 100,000 bookable
  windows from its resources' hours in all. Past either they answer `400 calendar_work_limit`: ask
  for fewer resources or a shorter window.
- There are no CORS headers: call it from a server, not a browser.
- From Python, Go, Rust, Java or .NET, use the [clients](/docs/clients/): one method per
  operation, the application API included, each tested against the server in CI. For another
  language, generate one from [`openapi.json`](/openapi.json) (or a server's `/openapi.json`, or
  `slotlock/openapi.json` in the npm package) with any OpenAPI 3.1 generator.

## Application API

What the application around the agents does, from any language: the store's resource, hours, hold,
reservation, coverage and maintenance calls, as REST beside the tools. It needs a key with the
`admin` scope ("Full" in the dashboard); the server's own `SLOTLOCK_AUTH_TOKEN`, the token agents
are given, reads and writes but is never admin. It is never an MCP tool or an A2A skill, and never
waits for a confirmation.

| Request | Does |
| --- | --- |
| `POST /v1/resources` | Create the resource with this `external_ref`, or update its `timezone` and the profile fields given; `visibility: "private"` hides it from agents |
| `PATCH /v1/resources/{resource_id}` | Change its profile: `name`, `description`, `kind`, `capacity`, `labels`, `attributes`, and its `location`, the fields given (`null` clears) |
| `GET /v1/locations` | The tenant's locations, depth first, with how many resources are at each; `POST` creates or updates one (`ref`, `name`, `parent_ref`, `timezone`) |
| `PATCH /v1/locations/{location_ref}` | Change its name, parent or time zone; `DELETE` removes it (`409 location_in_use` while anything is at or in it) |
| `GET /v1/groups` | The tenant's groups, with how many resources are in each; `POST` creates or updates one (`ref`, `name`, `description`); `DELETE /v1/groups/{group_ref}` removes it |
| `PUT /v1/groups/{group_ref}/members/{resource_id}` | Put a resource in a group; `DELETE` takes it out |
| `GET /v1/resources/{resource_id}` | One resource, with its own weekly hours, visibility, `archived_at` and profile |
| `POST /v1/resources/{resource_id}/archive` | Take it out of use; `…/restore` puts it back |
| `DELETE /v1/resources/{resource_id}` | Delete it with its history (`409 resource_in_use` while anything on it is live) |
| `GET /v1/resources/{resource_id}/busy?start=…&end=…` | Its occupied time, private resources included |
| `PUT /v1/resources/{resource_id}/availability` | `{"rules":[…]}`: its own weekly hours; `"rules":[]` never bookable, `"rules":null` the server's |
| `PUT /v1/availability` | `{"rules":[…], "override_resources"?}`: the tenant's weekly hours, which resources without their own inherit; `override_resources` `none` (default), `matching` or `all` says which resources' own hours are cleared; `GET` reads them and each location's |
| `PUT /v1/locations/{location}/availability` | `{"rules":[…]}`: a location's weekly hours, inherited by resources at it or inside it |
| `GET /v1/availability/exceptions` | Closures and special days: `?resource_id=` those that apply to it, `?location=` one location's own |
| `POST /v1/availability/exceptions` | `{"starts_on","ends_on"?,"outcome":"closed"\|"open","hours"?,"label","location"?,"resource_id"?}`; `DELETE …/{exception_id}` removes one |
| `POST /v1/availability/holidays` | `{"icalendar"}` or `{"url"}`, `name`?, `subscribe`?: each all-day event of a holiday calendar closes its days; importing the calendar again (by name) removes the holidays it dropped, and `subscribe` imports a URL again every 30 days |
| `GET /v1/availability/holiday-calendars` | The calendars imported, with their closures, and for a subscription its next import and last error; `DELETE …/{calendar_id}` deletes one with its closures |
| `POST /v1/holds` | Hold a window for `ttl_seconds` (up to 7 days) |
| `GET /v1/holds/{hold_id}` | One live hold; `GET /v1/resources/{resource_id}/holds` lists them |
| `POST /v1/holds/{hold_id}/confirm` | Turn the hold into a reservation (`409 payment_required` while a hold made with `payment_required` is unpaid) |
| `POST /v1/holds/{hold_id}/paid` | `{"payment_ref","received"?}`: record a hold's payment, verified at your processor; `received` (`amount_minor`, `currency`) is checked against the hold's `payment` |
| `DELETE /v1/holds/{hold_id}` | Release the hold |
| `GET /v1/reservations/{reservation_ref}` | The booking at its current revision |
| `GET /v1/resources/{resource_id}/reservations?start=…&end=…` | Its bookings in a window |
| `PUT /v1/reservations/{reservation_ref}` | Book (`revision: 1`) or move (the current revision plus 1); `contact_ref` and `notify` say whom to tell, `reminder_minutes` (up to five) when to remind them |
| `PUT /v1/contacts/{contact_ref}` | Keep a person a booking may name: email, phone, WhatsApp, locale and consent per channel; `GET` reads one, `DELETE` forgets them and their reference on every booking |
| `GET /v1/contacts?limit=…&cursor=…` | The tenant's contacts a page at a time, each with `consent_at` |
| `DELETE /v1/reservations/{reservation_ref}?revision=…` | Cancel, at the current revision plus 1 |
| `PUT /v1/resources/{resource_id}/coverage/{source}` | Record that `source`'s events are complete for a window |
| `PUT /v1/resources/{resource_id}/coverage/{source}/busy` | Record a window's coverage and the busy time in it, for a calendar that gives no events |
| `POST /v1/resources/{resource_id}/coverage/{source}/conflicts` | `{"reservation_ref"\|"event_id","reason","calendar_start"?,"calendar_end"?}`: a booking the source's calendar moved or removed, put on the feed as `coverage.conflict` |
| `GET /v1/tenant/events?resource_id=…&start=…&end=…` | Every key's events on a resource, with the `id` the next two take |
| `GET /v1/tenant/events/{event_id}` | One of them |
| `DELETE /v1/tenant/events/{event_id}?expected_revision=…` | Cancel it, whichever key wrote it |
| `GET /v1/tenant` | The key's tenant, and whether it is suspended |
| `POST /v1/tenant/erase` | Erase the tenant, when the server allows it |
| `POST /v1/tenant/exports` | Ask for a copy of everything the tenant keeps, read at one moment; `GET /v1/tenant/exports/{export_id}` says when it is ready |
| `GET /v1/tenant/exports/{export_id}/parts/{part}` | One part of a ready export: one table's rows, as kept; `DELETE /v1/tenant/exports/{export_id}` deletes it |
| `POST /v1/subjects/export` | `{"email"\|"holder"\|"contact"\|"reference"}`: what the tenant keeps about one person, by table |
| `POST /v1/subjects/erase` | The same: take that person out; bookings stay as time taken |
| `GET /v1/audit?limit=…&cursor=…&action=…` | The workspace audit log, newest first, with each event's place in its hash chain (Team plan where plans apply) |
| `GET /v1/audit/verify` | Check that chain: how many events held, and the first that does not |
| `POST /v1/maintenance` | Run [maintenance](/docs/operations/) for the key's tenant |

```sh
curl -X PUT "http://localhost:8080/v1/reservations/BK-42" \
  -H "Authorization: Bearer $SLOTLOCK_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"resource_id":"<id>","start":"2027-03-29T09:00:00Z","end":"2027-03-31T09:00:00Z",
       "buffer_after_minutes":60,"revision":1}'
```

- A taken window answers `409 overlap`. `buffer_after_minutes` keeps the time after a reservation
  busy for holds and other reservations alike.
- Every write is safe to retry: the same reservation at its current revision answers
  `replayed: true`, a confirmed hold confirms again, and a cancelled reference stays cancelled (a
  late booking for it answers `409`). A late copy of a booking or a move that has since been
  superseded answers `409 stale_revision`.
- A confirmed hold is the booking whose reference is the hold's id, at revision 1: cancel it with
  `DELETE /v1/reservations/{hold_id}?revision=2`.
- `POST /v1/holds` and `DELETE /v1/tenant/events/…` take a retry identity as the `Idempotency-Key`
  header or as `idempotency_key`. A retried hold answers the hold the first request made; the same
  key with another request is `422 idempotency_conflict`. Other routes are safe to retry as they
  are, and refuse the header (`400 idempotency_key_not_supported`).
- Lists page by `limit` (up to 100) and `cursor`, the `next_cursor` of the page before, and read a
  window of at most 367 days.
- The time a calendar event occupies is the event's: reservation calls never find, move or cancel
  it, whatever reference they name. Change the event instead, or cancel it as the tenant with
  `DELETE /v1/tenant/events/{event_id}`, which needs its revision and an idempotency key, and
  takes `expected_resource_id` to fence it to the resource you read it on.
- Erasing a tenant over the API is off unless the backend is created with `tenantErasure: true`
  (`slotlock serve` leaves it off: its operator runs `slotlock tenant erase`). It needs
  `confirm_tenant_ref` to be the tenant's reference (`GET /v1/tenant`), deletes every key the tenant
  has, the caller's included, and is refused while the tenant is suspended. Suspending a tenant is
  never an API call: only the schema owner may, and a tenant could not lift its own.
- A tenant export (RFC 0004 D3) is every table's rows as kept, read through one cursor, so all at
  one moment, without the tenant and without secrets (webhooks' signing secrets, the assistant's
  provider key, API keys' digests). Tables derived from others, internal records and each member's
  own conversations with the assistant are left out (`SLOTLOCK_TENANT_EXPORT_LEFT_OUT` says why).
  `POST /v1/tenant/exports` answers `pending` and the server builds it after answering; maintenance
  builds one a stopped server left pending. Read `parts` parts, each one table's rows (up to 5,000,
  about a megabyte), and write each part's rows as lines of its table's NDJSON file. One is built at
  a time (`409 export_in_progress`) and five are kept (`409 export_limit_reached`); each is deleted
  24 hours after it is ready. One past 512 MB fails (`error: export_too_large`): the operator runs
  `slotlock tenant export --out <dir>`, which reads the same snapshot straight to one file a table
  and stores nothing.
- An access or erasure request about one person (RFC 0004 D3) names them by exactly one of
  `email` (contacts, event attendees and organizers, ignoring case), `holder` (holds, bookings and
  waitlist entries), `contact` (a contact's reference) or `reference` (a booking's or an event's).
  The export lists the rows that name them, as kept, up to 1,000 a table (`truncated: true` past
  that); an event shows its time and title and an approval its decision, never the other people they
  name. The erasure deletes their contacts, attendee entries and waitlist entries, takes their email
  out of events' attendee and organizer lists and approvals' requests, and replaces their holder and
  booking references with one `erased-<32 hex>` name everywhere (holds, bookings, cancelled
  bookings, events, the change history, approvals). Bookings stay as time taken; the event keeps its
  revision and no change goes on the feed. It takes `dry_run`, and is recorded in the audit log as
  `subject.erased` without the person. `slotlock subject export` and `slotlock subject erase` do the
  same from the command line.
- The tenant is the key's. Another tenant's resource or hold is `404`, whatever the database role.
- With the library, pass `application` beside `rest: true`:
  `{ backend: createSlotlockStoreApplicationBackend(store, { maxTenantResources }), authorize }`.
  A principal with `scopes` needs `admin`; then `authorize` decides.

## Changes and webhooks

Every committed change to a tenant's holds, bookings, calendar events and configuration is recorded
in the same transaction (by a database trigger, so no write path skips it), and nothing is recorded
that did not commit. A change carries ids, times and states, never titles, descriptions, attendees,
webhook URLs or secrets.

- The types: `hold.created`, `.updated`, `.confirmed`, `.released`, `.expired`;
  `reservation.created`, `.updated`, `.rescheduled` (a move, besides `.updated`), `.cancelled`,
  `.checked_in`, `.no_show`, `.completed` (maintenance, once a booking's end has passed); `event.created`,
  `.updated`, `.cancelled`, `.timezone_shifted`, `.timezone_conflict`; `reservation.timezone_shifted`,
  `.timezone_conflict`; `waitlist.offered`,
  `.expired`, `.joined`, `.accepted`, `.declined`, `.lapsed`, `.left`; `hold.paid`; `reminder.due`;
  `coverage.stale`, `.conflict`; and configuration: `resource.created`, `resource.updated` (booking
  and check-in rules, pool, location, groups, bookable hours, time zone or reference, with `before`
  and `after` of only the fields that changed, and the profile fields' names in `profile_changed`), `resource.archived`, `.restored`, `.deleted`; `coverage.recorded`
  (a source's first read; reading it again is not a change) and `coverage.deleted`. A `coverage.*`
  change names its source by `source_id` (also its `subject`), never the source itself, which can
  be an iCalendar URL with a token or an address: `src_` and 32 random hex digits, made when the
  source is first recorded for the resource and kept until it is deleted, so it cannot be worked
  out from the source. `slotlock_get_coverage` (`listCoverage`) gives it beside the source, to
  match a change to its source. A change about a source deleted before 0.6 named it is
  `src_redacted`;
  `webhook.created`, `.enabled`, `.disabled`, `.deleted` (the id and `event_types`, never the URL);
  `key.created`, `.rotated`, `.revoked` (the id, scopes and expiry, never the key, its digest,
  prefix or name). `SLOTLOCK_CHANGE_TYPES` lists them.
- Each change records who made it (`actor`: the API key or agent), the API key's id (`key_id`) when
  a key made it, and where it came from (`origin`): `mcp`, `a2a`, `rest` (the REST agent routes),
  `application` (the application API), `dashboard`, `dashboard-assistant`, `maintenance`, or
  `library`: code calling the store itself, inside `withTenant` with no `origin` or outside it, and
  any write that names none. Never an address or anything else about a person. A change an earlier
  release recorded has neither (`null`).
- `key_id` is pseudonymous: the key's id, never the key or its name. It stays on the changes the key
  made after the key is revoked or deleted, for as long as the feed keeps them (the retention below,
  and longer while an enabled webhook has still to receive them); erasing the tenant removes them.

- `GET /v1/changes?cursor=…` lists them oldest first as [CloudEvents 1.0](https://cloudevents.io)
  (`io.pylota.slotlock.hold.created`, `.reservation.cancelled`, `.event.updated`, …), with the
  extension attributes `slotlockorigin` and `slotlockkeyid` when the change records them. Follow
  `next_cursor`, which comes back even when nothing is new: it never skips a change, even one whose
  transaction commits after a later one's. Changes are kept 30 days (`SLOTLOCK_RETENTION_DAYS`,
  `retentionDays` in `createSlotlockStore`, 1-3,650, for `serve` and `maintain` alike), or the
  tenant's hosted plan's days if longer (Free 30, Developer 90, Team 400). The serving role may
  only add changes and read them: they leave through `slotlock.prune_changes` alone, and the one
  edit is taking a person out of them (`POST /v1/subjects/erase`); a cursor
  that a pruned change came after, whichever server pruned it, answers `410 cursor_expired`. A change keeps who made
  it (`actor`) and a booking's or waitlist entry's reference: keep references opaque, not emails,
  when the feed is kept long. A shorter retention never shortens how long a retried write is
  answered as the first was: that stays at least 30 days.
- `POST /v1/webhooks` with an https `url` (and `event_types`, optionally) sends each change from
  then on as a [Standard Webhooks](https://www.standardwebhooks.com) request: `webhook-id` (the
  change's id, the same on every retry), `webhook-timestamp` and `webhook-signature`, keyed by the
  `whsec_` secret the call returns once. `event_types` takes any of the types above. Verify it with any Standard Webhooks library, and use
  `webhook-id` to drop a repeat: delivery is at least once.
- A webhook can also take only the changes about some resources: `resource_ids` (up to 100),
  `pools`, `locations` (each with every location in it) or `groups` (up to 20 of each), matched
  against the resource as it is when the change is delivered, or as the change says it was: a
  resource's deletion (`resource.deleted` names its pool, location and groups) and its move out of
  them (`resource.updated`'s `before`) still reach it. With any of them, a change about no resource
  (a key, a webhook, a usage notice) is not sent to it.
- Changes go to each webhook in order, one at a time, until one fails; that one is retried after
  5 seconds, 5 minutes, 30 minutes, 2, 5, then every 10 hours. After a day of failures, or a `410`,
  the webhook is disabled and the feed records `webhook.disabled`; `POST /v1/webhooks/{id}/enable`
  resumes it where it stopped, or answers `409 changes_pruned` when what it missed is older than the
  feed keeps (add it again and read what it missed from `/v1/changes`). The feed keeps every change
  an enabled webhook has still to receive, however old. At most 10 webhooks per tenant.
- Each request has 15 seconds in all, and a tenant's pass 30 seconds; tenants are delivered 8 at
  a time, so a slow endpoint holds up only its own tenant.
- History reads the same record backwards, with who made each change (`actor`, `key_id`), where
  from (`origin`) and, for a change of an existing booking, event or resource, what it was before:
  `GET /v1/resources/{id}/history` (its bookings, events and its own configuration),
  `GET /v1/reservations/{reference}/history`, `GET /v1/tenant/events/{id}/history`, newest first,
  paged by `before`. In the library, pass `actor`, `origin` and `keyId` to `withTenant` (`origin`
  defaults to the enclosing call's, else `library`; `createSlotlockApiKeyAuthenticator` gives the
  principal its `keyId`), and `actor` and `origin` to the API key store's `create`, `rotate` and
  `revoke`; read `listHistory`. It is kept as long as the feed and erased with
  the tenant.
- When time zone rules change (a new tzdata), a booking's instant and the wall time it was made for
  part: Winnipeg's 09:00 is no longer the instant stored. Slotlock keeps both, and maintenance finds
  future one-off events whose wall time moved: it reports each once (`event.timezone_shifted`, with
  the instant it has and the one its wall time now means). The library's `followZoneRules` option
  to `maintainSlotlockTenant` moves them instead, as a new revision, unless that overlaps another
  booking (`event.timezone_conflict`; it stays, for a person or an agent to decide). It also
  re-checks a recurring series' occurrences to come, reporting each once (`event.timezone_shifted`
  with its `recurrence_id`) or, with `followZoneRules`, moving the whole series at its next
  revision: every shifted occurrence and the booking that holds it, each keeping its
  `recurrence_id`, in one transaction. It moves only where this server's zone rules put each wall
  time where the database's do; otherwise each is reported with `reason: "rules_disagree"`, since
  a server with older rules would compute the old times again. Something in the way keeps the
  series' times and is said once (`event.timezone_conflict`). Reservations written with a
  `local_start` (`localStart`) are re-checked too, which
  it reports (`reservation.timezone_shifted`) or moves (`reservation.timezone_conflict` when it
  cannot). `/healthz` reports the `tzdata` the server runs.
- Feed health: `GET /v1/resources/{id}/coverage` shows each source (and its `source_id`, as the feed
  names it), its window, when it was last read,
  its last error (`POST /v1/resources/{id}/coverage/{source}/failure` records one) and whether it is
  stale (not read for a day, so the time it covers is unproven, never free). A source that goes stale
  is put on the feed once, as `coverage.stale`, until it is read again. Retire a sync you have
  disconnected or replaced with `DELETE /v1/resources/{id}/coverage/{source}` (`deleteCoverage`):
  nothing waits on it after that, `requireCertain` included.
- `slotlock serve` delivers (`SLOTLOCK_WEBHOOKS`): never to an address on a private network, which
  it checks when it connects, and following no redirect. `private` allows those, for testing.
- In the library: `listChanges`, `createWebhookEndpoint` and the rest are store methods, and
  `startSlotlockWebhookDelivery` with `deliverSlotlockWebhooks` runs delivery in your own process.

<!-- include README.md#supported-versions -->
