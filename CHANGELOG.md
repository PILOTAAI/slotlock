# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning.

## Unreleased

### Fixed

- A runtime dependency bump no longer breaks the release checks. The packed NOTICE is written at
  build time from `package.json` and `package-lock.json` (`scripts/notice.mjs`), naming the exact
  version of each dependency; the repository's NOTICE names each dependency and its licence, and a
  dependency under a licence the project has not reviewed stops the build.
- A release never moves npm's `latest` dist-tag, or the image's `latest` tag, backwards. Every stable
  release used to be staged as `latest`, so approving a patch to an older line (0.2.1 after 0.3.0)
  would have made it what npm installs by default. `scripts/dist-tag.sh` now chooses the tag from
  the registry's current `latest`: a later release takes `latest`, a release on an older line takes
  `latest-<major>.<minor>`, and a prerelease takes `next`.
- The server image and the MCP Registry entry are published only after the release's own suite has
  passed. `image.yml` used to start on the tag beside `release.yml`, so a tag whose tests failed
  still pushed an image and a registry entry. `release.yml` now calls it once its build job passes,
  and the image push and the registry entry each wait in an environment (`ghcr`, `mcp-registry`)
  that `scripts/configure-github.sh` sets up. The image's attestation is still signed by
  `image.yml`, so `gh attestation verify --signer-workflow .../image.yml` keeps working.
- The server image runs Node.js 24 LTS (24.22.1), the version the release suite runs on and a major
  CI tests. It shipped Node.js 26.11.1, which CI never ran and which is not yet an LTS release,
  while its header said 22.
- CI runs the database suites on PostgreSQL 17 and on the PostgreSQL 18 image the Compose
  quickstart pulls, as well as 16, and runs the quickstart itself end to end: `.env` from
  `.env.example` (`scripts/quickstart-env.sh`), `docker compose up --build`, the deployment smoke
  check, and a restart on the same volume (`scripts/compose-smoke.sh`). The docs now say PostgreSQL
  16 or newer, and that Compose ships 18; they said 16 while Compose ran 18.
- `.env.example` turns the REST API on, as `slotlock serve` and Compose already do by default.
- One aggregate check, "CI passed", gathers every CI job: the suites on each Node.js and
  PostgreSQL, the image, the five language clients and the Compose quickstart.
  `scripts/configure-github.sh` requires it and DCO's "Signed-off-by" on `main`; the client suites
  and the deployment smoke check did not gate merges before.
- `scripts/configure-github.sh` (the owner runs it) no longer lets the admin role bypass `main`'s
  pull request rule and required checks, makes the person who runs it the required reviewer of the
  npm, `ghcr` and `mcp-registry` environments, keeps GITHUB_TOKEN from opening or approving pull
  requests unless `--allow-actions-pull-requests` is given (the release app opens them), and splits
  the release-tag ruleset so the deploy-key bypass covers creating a `v*` tag only; only the admin
  role may move or delete one.
- Dependabot watches the dashboard Worker's lockfile and the five language clients (Cargo, Go
  modules, Gradle, NuGet, pip) as well, and a test fails when a manifest is added without an entry.
  The site's and the dashboard Worker's Wrangler pinned undici 7.29.1 (GHSA-xjj6-f33q-929c, high,
  development tooling only) through miniflare, which Dependabot could not move; both lockfiles now
  override it to 7.30.1. The development lockfile moves body-parser (through the A2A SDK's express)
  from 2.3.0 to 2.4.0, past GHSA-27r3-jxmh-p828; a test keeps every lockfile out of the advisories
  Scorecard reported.
- `server.json` (the MCP Registry entry) no longer marks `SLOTLOCK_AUTH_TOKEN` and
  `SLOTLOCK_CONFIRMATION_SECRET` as required: `slotlock serve` runs with API keys alone, and without
  the secret when `SLOTLOCK_CONFIRM_WRITES` is `none`. Its Authorization header takes the token or an
  API key, `SLOTLOCK_TENANT` says API keys act in their own tenant, and the database is PostgreSQL 16
  or newer. `mcp-publisher validate` (v1.8.1) accepts it.
- CodeQL runs from `.github/workflows/codeql.yml` with the extended security suite, as GitHub's
  default setup did, and a configuration that drops `js/insufficient-password-hash` with its reason
  written beside it: API keys are 238 random bits, so their SHA-256 is the design (SECURITY.md),
  not a weak password hash. `scripts/configure-github.sh` turns default setup off, since GitHub runs
  one or the other.

### Added

- The npm package ships `openapi.json`, the REST API's OpenAPI 3.1 document, exported as
  `slotlock/openapi.json`.
- The capability manifest names the 0.2 surfaces: `rest-api`, `application-api`, `api-keys`,
  `dashboard` and `maintenance` (and its schema accepts them), and the package check asserts them.
- Release jobs for the five language clients: `slotlock` on PyPI and crates.io, `Slotlock.Client` on
  NuGet, `io.pylota:slotlock` on Maven Central and the Go module's `clients/go/v<version>` tag. Each
  runs only after the release suite has passed, in its own environment a maintainer approves; PyPI,
  crates.io and NuGet use trusted publishing, so no token is stored for them, and Maven Central gets
  a deployment a maintainer publishes in the Central Portal. The clients now carry the package's
  version (they said 0.1.0 beside a 0.2.0 server): `scripts/prepare-release.sh` moves them with each
  release and `scripts/check-release-tag.sh` refuses a release where one disagrees.
  `docs/release/clients.md` has each registry's one-time setup.

## 0.2.0 - 2026-10-23

### Added

- The application API: what an application does through the store, over REST from any language.
  Create resources and set their weekly hours; hold, confirm and release time; book, move and cancel
  reservations by reference and revision; record external calendar coverage; run maintenance. The
  routes sit under `/v1` beside the tools, in the same OpenAPI document, and need an API key with the
  new `admin` scope. They are never MCP tools or A2A skills. `createSlotlockStoreApplicationBackend`
  serves them from the store; `createSlotlockAgentServer` takes them as `application`.
- The `admin` API key scope: `slotlock key create <name> --scope read,write,admin`, or "Full" in the
  dashboard. New keys still default to read and write, and `SLOTLOCK_AUTH_TOKEN` is never admin: it
  is the token agents are given, and the application API asks no person before it writes.
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
- A `call` event for each MCP `tools/call` and A2A `SendMessage` that names an operation: its
  outcome, duration and W3C trace id. `rest` events carry the duration and trace id too, and
  `slotlock serve` logs both.
- Releases are opened and merged by a GitHub App once it is set up
  (`node scripts/create-release-app.mjs`), so its checks run without a maintainer approving them.
  Only the commit whose checks passed is merged.

### Changed

- `slotlock serve` serves REST by default; `SLOTLOCK_REST_API=off` turns it off.
- `expandRules` and `findNextAvailableFor` refuse a search window longer than 367 days with
  `invalid_window`, as free/busy already did, and skip a rule that lasts longer than a week, as the
  hours validator refuses one. Fifty daily rules over a century were two million windows of
  synchronous work.
- Upgrading rebuilds the unique index on booking references
  (`slotlock_reservations_booking_external_ref_key`) to leave calendar event rows out, and drops
  the one it replaces after the new one is built.
- A cursor 0.1 kept beside a stored series is not resumed if the series is zoned and ends (UNTIL):
  0.1 read its occurrences as UTC beside the UNTIL, so the cursor may have stopped one occurrence
  early (a booking could then take that time) or gone one past. The next roll searches such a series
  from its start, within the same budget, and keeps a new cursor.
- Upgrading widens the API key scope constraint in place, and replaces the reservations overlap
  constraint with one that counts every row's turnaround buffer (below). Expired holds in a buffer's
  way are removed; while a live hold or untenanted reservation is in one, migrate stops with their
  ids and changes nothing.

### Fixed

- A calendar event's occupation could be freed or moved through the reservation commands
  (`cancelExternalReservation`, `rescheduleExternalReservation`, and the application API's
  reservation routes) by naming the reference the store derives for it: the event stayed active but
  stopped occupying its time. Those commands now leave event rows out. An event freed this way
  before upgrading occupies its time again once it is written again.
- Maintenance replaced a series' stored window with the rolling horizon even when the stored window
  ended later, deleting the occurrences past it.
- Free/busy called a window complete when a series started inside it but was stored only from
  later: those occurrences were reported as free time.
- Upgrading as a non-superuser owner under forced row-level security failed with a raw error (or,
  for some repairs, skipped them): the upgrade's data steps saw no rows. The upgrade now lifts FORCE
  for those steps and records what it lifted, so an upgrade stopped part way is put right by the
  next one, and `slotlock serve` refuses to start while a tenant table is left without FORCE.
- `expandRules` without a time zone offered windows after the rule's UNTIL.
- A delayed copy of a create, after the reservation had moved on, answered `idempotency_conflict`
  instead of `stale_revision`.
- A time zone a calendar names without a VTIMEZONE was read as floating, and compared with UTC
  values as if it were UTC. East of UTC a series lost the occurrence its UNTIL names (in a stored
  series, a booking could then take that time); west of it, a series ran hours past its UNTIL; an
  EXDATE or a moved occurrence's RECURRENCE-ID written in UTC was not found. All-day series had the
  same fault with a UTC UNTIL.
- A feed with a PERIOD RDATE, or an event with no DTEND, was refused whole; a feed's event that
  ended before it started was refused with `invalid_external_interval` instead of
  `invalid_icalendar`; a document whose root is not a VCALENDAR read as an empty calendar.
- The 4,000 occurrences a series may pass from its start were shared by every series in a feed, so
  three daily series begun in 2023 refused it for good.
- An EXDATE left its occurrence in when EXDATEs before it named no occurrence (ical.js passes them
  one per occurrence), or when an RRULE and an RDATE both named it; such an instant was also
  reported twice. A series of RDATEs with no RRULE left out its DTSTART, its first occurrence.
- An occurrence starting in an hour the clocks skip ended as it started and was left out; it now
  lasts its series' exact length, from its DTEND or its DURATION. Others still end on the wall clock.
- ical.js matched exceptions and compared UNTIL and EXDATE values with a feed's own VTIMEZONE for an
  IANA name, while Slotlock read the same times through Intl: under a stale definition, a moved
  occurrence was found in the feed and lost from the series stored from it. Such a name is read
  through Intl throughout.
- A series with two RRULEs lost occurrences once either rule ended: ical.js dropped the rule after
  an ended first one, or the one before any other.
- A DATE EXDATE of a timed series excluded every occurrence that day from a feed and none from the
  series stored from it; both now exclude the occurrence at the series' start time that day.
- A floating UNTIL was read as UTC beside a zoned DTSTART. A RECURRENCE-ID written in another zone
  than its series' DTSTART did not find its occurrence, and a `RANGE=THISANDFUTURE` one written in
  UTC moved later occurrences by the wrong amount.
- `parseTrustedICalendarEvents` did not read times as `parseICalendarChanges` does: a stored
  all-day series kept an occurrence the feed's UTC EXDATE excludes. An event it cannot hold (no
  length, say) is now `invalid_icalendar`, not `invalid_external_interval`.
- A feed naming thousands of time zones it does not define (50,000 spellings of one zone took
  seconds) is refused past 100, as one defining more than 100 is; a feed listing too many EXDATE
  values is refused before they are read, not after.
- A request body sent without `Content-Length` (chunked) was read whole before the size limit
  applied, so any key holder could make the server hold gigabytes. It is refused as soon as it
  passes `maxRequestBytes`. The Node adapter no longer aborts a request whose body the server stops
  reading; it discards the rest once it has answered.
- `close()` while the Node adapter was still starting left `listen()` pending forever.
- On the Workers dashboard, `/dashboard/sign-in/` and `/dashboard/callback/` (with a trailing slash)
  were outside the global sign-in rate limit.
- The confirmation question for a create did not say that a transparent booking leaves the time
  free, or name the other fields it sets.
- `arguments` that were not an object (a string, an array) ran the operation with none; they are
  now `-32602` on MCP and an invalid message on A2A. Left out or null is still none.
- A rate-limited A2A request was answered with an MCP error over HTTP 429; it is now A2A's 200
  envelope with a `RATE_LIMITED` ErrorInfo. `Content-Type` is matched without regard to case.
- Calls refused before they ran (a client that cannot confirm, a malformed A2A message, a REST body
  that is not JSON, too large or not an object) were not reported to `onEvent`. On MCP 2026-07-28
  a confirmation was reported after the call it decided; it now comes first, as elsewhere.
- An async `onEvent`, `onError` or maintenance `onPass` that rejected was an unhandled rejection,
  which ends a Node process by default; an `onPass` that threw made a pass that ran count as failed.
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
