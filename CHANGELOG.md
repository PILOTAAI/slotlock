# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning.

## Unreleased

### Added

- The application API: what an application does through the store, over REST from any language.
  Create resources and set their weekly hours; hold, confirm and release time; book, move and cancel
  reservations by reference and revision; record external calendar coverage; run maintenance. The
  routes sit under `/v1` beside the tools, in the same OpenAPI document, and need an API key with the
  new `admin` scope. They are never MCP tools or A2A skills. `createSlotlockStoreApplicationBackend`
  serves them from the store; `createSlotlockAgentServer` takes them as `application`.
- The `admin` API key scope: `slotlock key create <name> --scope read,write,admin`, or "Full" in the
  dashboard. New keys still default to read and write.
- Built-in maintenance. `slotlock serve` maintains every tenant it serves, hourly, one at a time,
  under a per-tenant advisory lock, and logs the counts; `slotlock maintain` runs it once.
  `maintainSlotlockTenant`, `startSlotlockMaintenance` and `withSlotlockMaintenanceLock` do the
  same in a process of your own.
- `confirmHold` and `releaseHold` take `{ tenantRef }`, so another tenant's hold is not found
  whatever the connection's row-level security.
- Clients for Python, Go, Rust, Java and .NET (`clients/`): one method per REST operation, the
  application API included, generated from `openapi.json` with hand-written transports. Each runs
  the same scenario against the server image in CI. They are not on their package registries yet.
- `openapi.json`, the REST API's OpenAPI 3.1 document, in the repository and at
  https://slotlock.pylota.io/openapi.json; `slotlockOpenApi()` builds it.
- Property-based tests (fast-check) of the engine, time zones, iCalendar parsing and API keys.
- Releases are opened and merged by a GitHub App once it is set up
  (`node scripts/create-release-app.mjs`), so its checks run without a maintainer approving them.

### Changed

- `slotlock serve` serves REST by default; `SLOTLOCK_REST_API=off` turns it off.
- Upgrading widens the API key scope constraint in place, and replaces the reservations overlap
  constraint with one that counts every row's turnaround buffer (below). Expired holds in a buffer's
  way are removed; while a live hold or untenanted reservation is in one, migrate stops with their
  ids and changes nothing.

### Fixed

- A hold could take the time a reservation's `bufferAfterMs` keeps busy, and a buffered reservation
  could be booked over a hold: the buffer bound only tenant-owned reservations to each other.
- `confirmHold` with the id of a reservation that has an external reference answered as if it had
  confirmed a hold, describing it without its reference, revision or buffer. It is now
  `hold_not_found`.

## 0.1.1 - 2026-10-22

### Changed

- The README and the site install Slotlock from npm (`npm install slotlock`), now that 0.1.0 is
  published there, instead of building it from a clone.

### Added

- Releases are cut from GitHub Actions: "Release a version" prepares the version on a branch, merges
  it once CI passes, and tags it; the tag stages the package on npm for a maintainer's approval and
  publishes the image and the MCP Registry entry.

## 0.1.0 - 2026-10-22

First public release. Nothing was published before it; the entries below describe the release as
shipped, including changes made during pre-release hardening. Slotlock was developed inside Pylota's
private monorepo and imported into this repository from PILOTAAI/pylota@4808094c8; the release pull
request replaces "Unreleased" with the release date.

### Added for the standalone release

- The package is published as `slotlock`, requires Node.js 22.12 or newer, and is tested on
  Node.js 22 and 24.
- Developer Certificate of Origin sign-off, a licence commitment in GOVERNANCE.md, and a trade mark
  policy in TRADEMARKS.md.
- API keys: `slotlock key create|list|rotate|revoke` and `createSlotlockApiKeyStore`. A key is
  `slk_` plus 46 base62 characters with a checksum, is shown once and stored only as its SHA-256,
  belongs to one tenant, and carries the `read` and/or `write` scope. Keys can expire, rotate in
  place (keeping their id and the events they booked), are revoked at once, record their last use
  to the minute, and are capped at 100 active and 1,000 kept per tenant. A revoked, rotated-out or
  erased key is never accepted again. The serving role reaches keys only through SECURITY DEFINER
  functions and holds no right on their tables. Key lookups are bounded so made-up keys cannot take
  the database pool. `SLOTLOCK_AUTH_TOKEN` is now optional for `serve`.
- A principal may carry `scopes`; the agent server then refuses, before `authorize`, every
  operation whose scope (`slotlockAgentOperationScope`: `read` or `write`) it lacks.
- `createICalendarWorkerPool`: `parseICalendarChanges` and `parseTrustedICalendarEvents` on worker
  threads, for feeds someone else controls. The calling thread never runs ical.js on the feed; a
  worker past its deadline (3 s by default) or heap (128 MB) is stopped and the feed refused as
  `CalendarExpansionLimitError`; a full queue answers `ICalendarWorkerBusyError`. Results and errors
  are the parsers' own. `CalendarExpansionLimitError` is now exported.
- A REST API (`rest: true`, or `SLOTLOCK_REST_API=on` for `serve`): one route per tool under `/v1`,
  described by an OpenAPI 3.1 document at `/openapi.json` built from the tools' own schemas, behind
  the same authentication, scopes, `authorize` and rate limit. A write that waits for a person
  answers 428 `confirmation_required`. `onEvent` reports each call's operation and status.
- The dashboard as a Cloudflare Worker (`workers/dashboard`): the same pages at an origin of their
  own, over Hyperdrive with caching off, one database client per request, and two required rate
  limiting bindings that bound sign-ins across every isolate. The Dashboard workflow only bundles
  it; deployments use their own configuration and token. `createSlotlockDashboard` takes
  `serviceUrl`, the server whose MCP and A2A URLs it shows when it is served from elsewhere.
- The image carries the label `service="slotlock"`, which Kamal requires of an image it pulls rather
  than builds, so a release image can be deployed with Kamal as the service `slotlock`.
- A dashboard at `<SLOTLOCK_PUBLIC_URL>/dashboard` (`createSlotlockDashboard`), served by `serve`
  when `SLOTLOCK_GITHUB_CLIENT_ID` is set: GitHub sign-in (OAuth with state and PKCE, no scope), a
  personal tenant per GitHub user, and pages to create, rotate and revoke API keys (each shown
  once), add resources and copy the MCP and A2A URLs. Sessions are signed HttpOnly cookies checked
  against `SLOTLOCK_DASHBOARD_USERS` on every request; forms carry CSRF tokens and must come from
  the server's origin; no inline script runs. Finished sign-ins, sent forms and signed-out sessions
  are recorded in Postgres (`createSlotlockDashboardState`; digests only, until the cookie or form
  expires by the database's clock), so they hold across servers whatever their clocks, and the
  100-resource cap is held in the database. Forms carry a single-use value bound to the session,
  and one person may have 1,000 recorded at once (429 past that). `serve` refuses to start the
  dashboard until `migrate` has granted its functions.
- `createResource` takes `maxTenantResources`, a per-tenant cap enforced under a database lock, and
  `withTenant` takes `{ isolation: 'read committed' }`.
- Bookable hours per resource: `setResourceAvailability` and `setTenantAvailability` store a
  resource's own weekly rules (`null` uses the default, `[]` closes), and the agent backend uses
  them before `availabilityRules`. Set them on the dashboard's hours page (a week of windows, for
  one resource or all) or with `slotlock hours show|set|clear`. `SLOTLOCK_AVAILABILITY` is now
  the default for resources without hours of their own.
- `projectSlotlockCalendarEvent`: a stored event in the shape the event tools return, for an
  application that writes events through the store and shows them to agents beside the tools'
  own results.

### Fixed for the standalone release

- The Compose quickstart did not start: with Postgres 18, the database container exited on a new,
  empty volume, because the 18 image refuses a mount at `/var/lib/postgresql/data`. The volume is
  now mounted at `/var/lib/postgresql`, and the 18 image keeps its data in `18/docker` under it.
- A write's confirmation question could show a different time, resource or number of bookings from
  the ones the write makes. It now:
  - names the resource by its own reference and shows times in the resource's zone (through the
    new optional backend method `describeResource`, which the store backend has), and names an
    event by its current time; in any other zone each time carries its own UTC offset;
  - puts the agent's own text, and an event's stored title, after every fact, with anything that
    reads as a double quote (curly, full-width, primes) turned into a single one;
  - describes a repeating booking from the store's own expansion: how many times it books, the
    first and the last, every moved occurrence, and what the rule says past the window the store
    keeps booked (a moved or padded rule could book dates the question never named); a change to a
    series says it covers every repeat;
  - shows seconds when a time has them, and bounds each part, so no change is cut off the end;
  - reads only what the caller's scopes and `authorize` allow, and gives up on lookups after 2
    seconds, so a slow backend delays the question but cannot withhold it.
- Agents may only send recurrence rules RFC 5545 allows (known parts, each once, with valid values,
  and none it forbids for the frequency) that repeat daily or less often and can occur. ical.js read
  `COUNT=0` as no end, `COUNT=3X` as 3 and a repeated `FREQ` as the last one, and searched forever
  for a daily rule that cannot occur (`BYMONTH=2;BYMONTHDAY=30`), holding the whole process.
- A rate limit is charged before a write's confirmation is asked for, not only when it runs.
- The sealed confirmation state compares its MAC as text: three other spellings of the same MAC
  (the last base64url character's two spare bits) were accepted.
- `slotlock_list_resources` with a `cursor` that is not a resource id answers the `invalid_cursor`
  tool error (HTTP 400) instead of an internal error (HTTP 500, JSON-RPC -32603).
- The legacy-schema upgrade test creates `btree_gist` itself, so the database suites pass on a fresh
  PostgreSQL 16 database rather than only on one that already had the extension installed.
- Availability rules are held to the subset SPEC.md describes: `FREQ=WEEKLY`, `BYDAY`, `INTERVAL=1`
  and a UTC `UNTIL`. Anything else, such as `BYHOUR`, a `DTSTART`, `BYDAY` twice or an ordinal
  weekday, is refused by the store, the CLI and `SLOTLOCK_AVAILABILITY`, and `expandRules` reads it
  as no hours. Before, rrule honoured some of these: a `DTSTART` zone moved Monday's hours to
  Sunday, and `BYHOUR`/`BYMINUTE`/`BYSECOND` took most of a second per rule to check.
- An availability rule whose `UNTIL` is not a real date, such as `UNTIL=20270231T000000Z`
  (31 February), is refused. Before, rrule read it with `Date.UTC`, which carries the overflow
  into the next unit, so the rule stayed bookable until 3 March, after the date it was written to
  end.
- The dashboard's GitHub requests ask for redirects to be returned rather than refused outright
  (`redirect: 'manual'`, still refused as not `ok`). Cloudflare Workers reject `redirect: 'error'`
  with a TypeError, so no one could sign in to a dashboard running there.
- Every dashboard form but sign-out must carry its single-use value. A form sent without the value
  skipped the resend check and the per-person form limit.
- A feed's series no longer take each other's exceptions. ical.js relates every VEVENT with a
  RECURRENCE-ID in a calendar to every series, whatever its UID, by local time, so one series'
  cancelled or moved 09:00 cancelled or moved every other series' 09:00 that day, and
  `parseICalendarChanges` reported that time as free.
- Converting a wall-clock time builds one Intl formatter per zone rather than one per conversion. A
  feed of 20,000 dates now reads in about 0.3 seconds instead of 0.95 of its one-second limit, and a
  stored daily series' window in about 50 milliseconds instead of 160.
- A recurrence rule that never occurs, such as `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` or
  `FREQ=DAILY;INTERVAL=7;BYDAY=TU` from a Monday, no longer freezes the process. Before, ical.js
  2.2.1 searched for its next occurrence without limit, whether the rule came from a feed
  (`parseICalendarChanges`), a write (`putCalendarEvent`), a library call
  (`expandCalendarEventOccurrences`) or a stored series being rolled. The same held for a feed's own
  time zone: ical.js expands a VTIMEZONE's rule to read a time in a zone Intl does not know, so one
  such rule froze `parseICalendarChanges` or `parseTrustedICalendarEvents` on the first event,
  repeating or not. A huge `DURATION` did the same with no rule at all, since ical.js adds a span to
  a time a month at a time. Reading or expanding a calendar now has these limits, and one that
  needs more is refused as `invalid_icalendar` (`invalid_event` on a write):
  - a feed, and a stored series as maintenance rolls it: 50,000 search steps (its time zones
    included) and one second for the whole read, from the text on;
  - one event as it is written or asked about (`putCalendarEvent`,
    `expandCalendarEventOccurrences`): half of that, so a daily or rarer series written today keeps
    rolling for decades as its search grows;
  - a SECONDLY to WEEKLY step, a `DURATION`, a DTEND after its DTSTART, or an occurrence moved by an
    exception: about a century at most (36,600 days);
  - 1,000 RDATE and EXDATE values per event;
  - per feed: 100 VTIMEZONEs (counted in the text before ical.js parses it, and again after),
    1,000 observances and 2,000 RDATE values in them, and 20,000 RDATE and EXDATE values in its
    events. Before, a zone of 40,000 RDATE values (expanded again for each later year read) ran a
    feed out of memory, an exception for every later occurrence (`RANGE=THISANDFUTURE`) read a slow
    zone for minutes outside the search limit, and a TZID none of 20,000 zones defined held a read
    for 31 seconds;
  - per property: 8 KB of name and parameters, and 100 parameters, before its value. ical.js reads
    each parameter by searching to the end of the line, and 490,000 of them on one line held a read
    for 7.9 seconds before any other limit applied.

  ical.js also expands a feed's own zone again, from its start, each time it reads a later year,
  appending every change to those it had. A zone at those limits, read for 1,000 later years inside
  one call, took up to 35 seconds and 650 MB. Each expansion now keeps one copy, and the time limit
  is checked before each.

  `rollCalendarEventHorizon` skips a stored series that goes past these limits, which includes a
  daily series about 11 years after its start (4,000 occurrences). It counts the series in the new
  `refused` field and lists it in `refusedEventIds`, keeps its old coverage, and still rolls the
  series after it. Before, such a series made every roll for its tenant throw. A series Slotlock
  cannot read at all still fails the roll. The maintenance example sums `refused`.
- A resource id the store never issues, such as an external reference (`vehicle-42`), the nil UUID
  or a version 7 UUID, made free/busy, next-available, list-events, create and update answer a
  server error: HTTP 500 and JSON-RPC `-32603` over MCP (so an SDK client threw), 500
  `internal_error` over REST, `-32603` over A2A, and 500 from `resources/read`. The store backend
  now answers `resource_not_found` for it, as for any id that names no resource of the caller's.
  Nothing new is accepted: the store still refuses such ids.
- A failure an agent sees only as `internal_error` was logged nowhere. The agent server and
  `invokeSlotlockAgentOperation` take `onError(error, { operation })`, called with an exception that
  is not a `SlotlockAgentOperationError` and for a result outside the operation's output schema,
  never with the arguments or the request; `serve` logs it as `agent_error`, with its message and
  code and every configured secret redacted.
- The server reported version 1.0.0 (`SLOTLOCK_AGENT_SERVER_VERSION`, `/healthz`, MCP `serverInfo`,
  the agent card, the manifest and the OpenAPI document) while the package was 0.1.0. It now reads
  the version from package.json, as `slotlock --version` does, so there is one place to change it.
  `SLOTLOCK_AGENT_SERVER_VERSION` is typed `string`.
- `serve` connected as whatever role `DATABASE_URL` named, so a superuser or `BYPASSRLS` role
  served every tenant with row-level security skipped, silently. It now refuses to start as one
  (`unsafe_serving_role`) and says how to set up a serving role; `grantApplicationRole` already
  refused one.
- `slotlock --help` did not list `SLOTLOCK_REST_API`. A test now checks that it lists every
  variable the commands read.
- The Compose stack passed none of the dashboard's settings to the server, so the dashboard could
  not be turned on. `docker-compose.yml` passes `SLOTLOCK_GITHUB_CLIENT_ID`,
  `SLOTLOCK_GITHUB_CLIENT_SECRET`, `SLOTLOCK_SESSION_SECRET` and `SLOTLOCK_DASHBOARD_USERS`, empty
  (dashboard off) unless `.env` sets them, and `.env.example` documents them.
- The README's way to run without Docker (`slotlock migrate`, then `slotlock serve`) did not work
  from a clone, where `slotlock` is not on the `PATH`; it now gives the `node dist/cli.js` commands
  with a serving role and the owner's URL for `migrate`. The quickstart states that the confirmation
  in step 6 needs an MCP client on protocol 2026-07-28, and the README no longer mentions a hosted
  Slotlock.

### Added

- Deterministic interval merge, subtraction, and next-available search.
- Timezone-aware weekly availability expansion with explicit fail-closed rule support.
- PostgreSQL resources, reservations, atomic holds, conflict arbitration, and idempotent external
  reservation commands.
- Configurable forced row-level-security DDL with a consumer-neutral tenant context.
- Transaction-scoped tenant store callbacks and exact installed-policy drift fingerprints.
- Bounded iCalendar parsing, normalization, recurrence expansion, and deterministic export.
- Tenant-scoped event CRUD with optimistic revisions, command idempotency, cancellation tombstones,
  transparent events, and conflict-safe occurrence materialization through the reservation arbiter.
- Bounded recurrence exceptions, organizer/attendee RSVP state, relative reminders, trusted full-event
  parsing, RFC 5545/iTIP serialization, and coverage-aware free/busy certainty.
- Compiled ESM and declaration output, a clean npm artifact contract, and provenance-ready release
  automation.
- A normative agent-calendar specification and schema-validated machine-readable capability
  manifest.
- A consumer-neutral authenticated MCP 2025-11-25 and A2A 1.0 HTTP server projected from one strict
  operation registry, plus a tenant-bound adapter for the PostgreSQL event and free/busy store.
- A bounded Node.js HTTP listener adapter with canonical request origins, disconnect propagation,
  execution deadlines, sanitized failures, and graceful shutdown that force-closes after its deadline.
- Intrinsic local-recurrence coverage certainty and a 367-day protocol read/search window bound.
- A stable MCP Apps calendar resource for read-only tool results, with a self-contained network-dark
  interface and unchanged text/structured results for non-App MCP clients.
- `store.pruneCalendarEventRetention` and `SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS`: bounded deletion of
  idempotency commands past the replay window and of command-free agent tombstones, which returns
  per-principal quota. `internal` tombstones are never pruned.
- `store.grantApplicationRole`, `createSlotlockApplicationRoleGrantsDdl` and `SLOTLOCK_TENANT_TABLES`:
  least-privilege grants for the application role. The grant refuses, with the `reasons` it found,
  a role that could get around forced RLS or the exclusion arbiter, held itself, through a role it
  belongs to or through `PUBLIC`: superuser, `BYPASSRLS`, `REPLICATION`, `CREATEROLE`, the server
  file and program roles, ownership of the database, anything in it or `btree_gist`, `CREATE` on the
  database or any schema, `TRUNCATE`, `REFERENCES` or `TRIGGER` on a Slotlock table (or by default on
  new ones), or a right on a server setting.
- MCP `ping`, negotiation of MCP 2025-06-18 alongside 2025-11-25
  (`SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS`), and optional RFC 9728 protected-resource metadata with
  a `resource_metadata` challenge on the MCP `401` (`oauth` option).
- `resolveSlotlockAgentOperation`, `slotlockMcpToolResult`, `SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES`,
  `SlotlockSql` and `SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE` exports.
- Typechecked, executed examples quoted verbatim by the README.
- MCP 2026-07-28, stateless, beside 2025-11-25 and 2025-06-18: `server/discover`; every request's
  `_meta` envelope and its mirrored `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers are
  validated in the specification's order (`-32602`, `-32020`, `-32022`); results carry `resultType`
  and the server's identity; an unknown method is HTTP 404 `-32601` and a rate limit HTTP 429
  `SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE` (`-31029`). `initialize` still selects a 2025 revision
  (`SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION`). Tested with the official TypeScript SDK 2.1.0 and 1.30.1.
- Human confirmation before writes (`confirmation`): on 2026-07-28 a listed write answers
  `input_required` with a form elicitation describing the change and runs only on a retry carrying
  the person's acceptance and a `requestState` HMAC-sealed to the caller, the tool, the exact
  arguments and an expiry; a client without form elicitation gets `-32021`, and where no
  confirmation round exists (2025 revisions, A2A) the write fails with `confirmation_required`.
- Calendar resources on 2026-07-28 (`slotlock://resources/{resource_id}`,
  `SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE`, `slotlockCalendarResourceUri`, `resourceWindowDays`):
  `resources/list`, `resources/templates/list` and `resources/read` (free/busy and coverage).
- Live calendar updates through `subscriptions/listen` (`subscriptions` options): an SSE stream
  that acknowledges the resources this caller may read, then sends `notifications/resources/updated`
  on every change, found by re-reading with fresh authentication and authorization; keep-alives,
  per-principal and server-wide caps, a maximum duration, graceful closure, and `shutdown()`.
- Cache hints (`ttlMs`, `cacheScope`) on 2026-07-28 discovery, lists and reads, and validated W3C
  trace context (`traceparent`, `tracestate`, `baggage`) handed to the backend as `context.trace`.
- `onEvent`: confirmation outcomes and subscription opens and closes, without arguments or
  identities.
- All-day (`VALUE=DATE`) iCalendar events, series included, imported as whole local days of the
  calendar's timezone (the `calendarTimezone` argument, else `X-WR-TIMEZONE`).
- One-off events of up to 3,660 days (`SLOTLOCK_MAX_EVENT_DURATION_DAYS`), so a lease or a long
  rental is one event; `slotlock_find_next_available` can look for a slot as long as its 367-day
  window.

### Changed during pre-release

- Operations are named `slotlock_<verb>`: portable across Claude, OpenAI and MCP hosts, and
  namespaced by service so an agent that sees tools from many servers can tell which calendar it is
  calling. The names of earlier builds, the dotted `calendar.<verb>` and the underscored
  `calendar_<verb>`, still resolve on every entry point and are never advertised, so agents written
  against either keep working.
  `authorize`, `consumeRateLimit` and the backend always receive the current name, and
  `isSlotlockAgentOperation` accepts current names only (`resolveSlotlockAgentOperation` maps any).
- The bundled MCP App reads a refused call's error code from its text content, since failures no
  longer carry `structuredContent`.
- OAuth issuer identifiers are published exactly as configured (RFC 8414 compares them as strings)
  and must be canonical URLs without credentials, query or fragment: `https`, or loopback `http` in
  `allowInsecureLocalhost` mode.
- MCP tool failures are `isError` results with `{"error":{"code"}}` text and no `structuredContent`,
  which MCP SDKs validate against the tool's output schema; server faults are JSON-RPC `-32603`.
- The A2A agent card follows a2a.proto (`securityRequirements` schemes, skill invocation examples,
  no skill `metadata`) and is also served at the origin root; A2A JSON-RPC errors use an HTTP 200
  envelope with `google.rpc.ErrorInfo` details, `VersionNotSupportedError`,
  `PushNotificationNotSupportedError` and `UnsupportedOperationError`; `GetTask` and `CancelTask`
  answer `TaskNotFoundError` and `ListTasks` an empty page, after refusing unknown fields, another
  tenant, mistyped values, a timestamp that names no instant and unissued page tokens
  (`SLOTLOCK_A2A_TASK_PAGE_SIZE`, `SLOTLOCK_A2A_TASK_STATES`, `parseSlotlockA2ATimestamp`); a field
  without presence at its proto3 default is unset; skill failures are the reply's data part.
- Requests outside the public base path are not served; loopback IPv6 is accepted in
  `allowInsecureLocalhost` mode.
- Deployment SQL resolves names only in `pg_catalog`: `applySchema`, `applyTenantRls` and
  `grantApplicationRole` pin `search_path` for their transaction and restore it; `SLOTLOCK_CORE_DDL`
  and `createSlotlockTenantRlsDdl()` pin it while they run and restore the caller's at their end
  (apply each in one transaction); Slotlock's functions pin their own. Policy fingerprints use core
  `sha256` (the same values as pgcrypto's `digest` in a UTF-8 database), a missing `btree_gist` is
  created in schema `slotlock`, and `pgcrypto` is no longer required.
- `applySchema`, `applyTenantRls` and the exported DDL refuse (`unsafe_slotlock_schema`; SQLSTATE
  `42501` from the DDL) a `slotlock` schema that another role owns or can create objects in, that
  holds an object another role owns (an extension included), or whose tables another role may add
  triggers to or have a trigger running a function another role owns, superusers aside.
- `postgres` is a peer dependency (`^3.4.5`) so an application's own client type-checks against the
  store; the declarations keep their `@types/node` reference for `"types": []` consumers.
- License and notices name TREFT LTD as copyright holder and list every runtime dependency.
- `SLOTLOCK_MCP_PROTOCOL_VERSION` is `2026-07-28`; `initialize` answers the client's own 2025 revision,
  else 2025-11-25.
- `applySchema` replaces the event materialization-window check with
  `slotlock_calendar_events_materialization_window_bounded` (added `NOT VALID`, so existing rows are
  not rescanned), which lets a one-off event's window match the event however long it is.
- `createSlotlockNodeServer` calls its target's `shutdown()` when closing and closes keep-alive
  connections whose response finished during shutdown, so open streams drain within the grace
  period.
