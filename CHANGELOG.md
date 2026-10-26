# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning.

## Unreleased

0.3.0 fixes the double bookings 0.2.0 could accept around daylight-saving changes and makes
`slotlock serve` safe to share between tenants. Its themes: a recurrence engine that keeps every
occurrence's whole time across clock changes; per-tenant limits, suspension and erasure in the
store; request limits and fair shares of the server in `slotlock serve`; the application API's
reads, resource lifecycle and tenant calls; a release path that checks what it publishes and
publishes the five language clients; and fixes for the findings of a security audit. Read the
upgrade notes first.

### Upgrade notes

- Run `slotlock migrate` with 0.3.0 before serving it. The schema now records its version, and
  `slotlock serve` refuses a database an older release migrated (`schema_outdated`) or a newer one
  did (`schema_newer`). A migration refuses a schema a newer release migrated, and PostgreSQL older
  than 16. It also grants the serving role what this release needs: a role without that grant is
  refused `application_role_not_granted`, so a library user runs `grantApplicationRole` again.
  Each migration step waits at most a second for a lock and tries again, so serving queries queue
  behind it for at most that long, and an unchanged schema takes no table lock.
- Before upgrading, run `storedCalendarEventProblem(event)` over your stored events. A series an
  earlier release stored and this one refuses (a rule shape it no longer expands, `COUNT` with a
  yearly day some years lack, or an exception that names no occurrence) keeps its old coverage and
  is counted as refused at every roll.
- Breaking: `slotlock serve` defaults `SLOTLOCK_CONFIRM_WRITES` to `none`, so an authenticated
  write takes effect at once. Set `all`, or a list of write tools, to keep confirmation;
  `SLOTLOCK_CONFIRMATION_SECRET` is required only then.
- Breaking behind a proxy: `slotlock serve` now limits requests per client address, so set
  `SLOTLOCK_TRUSTED_PROXY_HEADER` (`CF-Connecting-IP` behind Cloudflare, also when kamal-proxy or
  another proxy sits between) before upgrading a server behind one. Without it every client counts
  as the proxy's one address and shares one `address` budget, 50 requests a second by default.
- `slotlock serve` applies new limits by default, each set with `SLOTLOCK_LIMITS`: per tenant,
  10,000 holds (`tenant_holds`) and 100,000 each of bookings, events and coverage rows
  (`tenant_reservations`, `tenant_events`, `tenant_coverage`); 256 live-update streams on the
  server (`subscriptions`), 16 a tenant (`tenant_subscriptions`) and 4 a key
  (`key_subscriptions`); 2 of the pool's 10 connections a tenant (`tenant_transactions`; a server
  with one tenant can set 10); one recurring write at a time per tenant and per server
  (`tenant_series_writes`, `series_writes`) and one application maintenance run
  (`maintenance_runs`); and request rates (Added). Check them against your largest tenant.
- Clients should handle the new answers: 429 `rate_limited` with `Retry-After`; 503
  `server_busy` (a full key-lookup or series-write queue, or a transaction that waited more than 5
  seconds for a lock) and 503 `request_aborted` (the request ended before its call did); 400
  `calendar_work_limit` from free/busy, next-available and busy reads; 409
  `hold_limit_reached`, `reservation_limit_reached`, `event_limit_reached`,
  `coverage_limit_reached` and `resource_limit_reached`; and 403 `tenant_suspended`.
- Writes 0.2.0 accepted that are now refused: a control character other than tab or line break in
  an event's title, description, location or participant names, or any in its UID
  (`invalid_event`); event times outside years 1 to 9999; rule shapes ical.js expands differently
  from RFC 5545 (`recurrenceRuleProblem(rule)` says why), and in a stored rule `COUNT=0`, an
  unknown or repeated part or a sub-daily frequency; DTEND with DURATION; an exception that names
  no occurrence; more than 8 RRULEs on a feed event; in the trusted importer, a DTEND the clocks
  skip, a DURATION in days or weeks outside UTC and an all-day series whose first midnight is
  skipped; and a booking, hold or event past the rolling horizon on a resource whose series goes on
  past it (`recurrence_not_materialized`).
- Breaking for library callers: `findNextAvailableFor` requires `tenantRef` (`null` for a resource
  with no tenant). `withTenant` opens its own transactions READ COMMITTED, and inside a caller's
  REPEATABLE READ or SERIALIZABLE transaction refuses writes with `invalid_transaction_isolation`.
  `createSlotlockApiKeyAuthenticator` throws `SlotlockAgentOperationError` `server_busy` (503) when
  its lookup queue is full, instead of answering anonymous; `createSlotlockAgentServer` answers it
  503 with `Retry-After` on REST, MCP and A2A. During maintenance a series whose roll fails is
  reported in `refusedEventIds` and put back for an hour instead of failing the pass.
- Clients and OpenAPI: new optional arguments come after the old ones in every client, but a Rust
  input struct written out field by field needs `..Default::default()` for the fields it gained
  (`CreateResourceInput`, `AcquireHoldInput`, `UpdateEventInput`). Event participant addresses in
  responses are no longer `format: email` in openapi.json; they follow the store's own grammar (one
  `@`, no spaces), so a client that checked them as email addresses should stop.
- The dashboard Worker takes a new binding, `SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT`, for every
  client together. Until it is bound, `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts every client together,
  as before, and the Worker logs a warning: add the ceiling before lowering that binding's limit
  to one client's.
- The server image runs Node.js 24 LTS (24.22.1). 0.2.0's image ran Node.js 26.11.1.

### Security

- zod moves from 4.6.5 to 4.6.7 (#59), past GHSA-mrhx-c7xc-m3w5 (high): when validating an
  oversized array, zod 4.6.5 collects an issue for every failing element with no cap, so one
  authenticated tool or REST call could hold far more memory than its body. 0.1.0, 0.1.1 and 0.2.0
  pin zod 4.6.5 exactly; their users can add `"overrides": {"zod": "4.6.7"}` to their own
  `package.json` (README, Known issues in 0.2.0).
- `slotlock serve` had no request limits. It now limits requests per client address, key, tenant
  and server (Added), and caps the work one tenant can start, store or hold open (Upgrade notes).
- A flood of made-up API keys no longer makes real keys answer 401 as if revoked. A full lookup
  queue answers 503 `server_busy`, and keys that authenticated in the last 15 minutes wait in a
  queue of their own, served first.
- The store's next-available search took no tenant and read no coverage: it offered slots on
  another tenant's resource, on unknown ids and in a series' unstored time. It now answers
  `resource_not_found` for those and offers a slot only where free/busy proves the time complete.
  `acquireHold`, `createReservation` and `listBusy` take `tenantRef` and enforce it whatever the
  connection's row-level security. An id the store never issues answers not found, not a raw error.
- One tenant can no longer hold every database connection of `slotlock serve`. 12 one-off creates
  waiting on their tenant's lock held the shared pool of 10, and another tenant waited about a
  second. A tenant's transactions now run at most 2 at once (`tenant_transactions`), and one that
  waits more than 5 seconds for a lock answers 503 `server_busy`. `createSlotlockStore` takes
  `maxTenantTransactions` and `tenantLockTimeoutMs` to do the same.
- `slotlock serve` bounds what one tenant may store. It gave its store no tenant limits, so an admin
  key could add holds, bookings and coverage rows (and an agent events) without end. Every surface
  now shares the store's tenant limits (Upgrade notes); a write past one answers 409 with its
  `*_limit_reached` code.
- Expired holds now count against the hold limit until deleted, and keyed holds until they would
  have expired, so one-millisecond holds cannot store rows without end between maintenance passes.
- Many tenants can no longer hold every live-update stream between them: 16 tenants within their
  share could take all 256. When the server is full, a tenant holding fewer than the tenant holding
  most, less one, ends that tenant's oldest stream gracefully (reported as `preempted`).
- One API key can no longer hold every live-update stream of its tenant: a key's cap
  (`key_subscriptions`) is kept below its tenant's unless the tenant may hold only one.
- A key without the admin scope no longer spends its tenant's application API budget. Its refused
  calls to application routes took tokens from `app_read` and `app_write`, so a read-only key could
  keep the tenant's admin application answered 429.
- A burst of one tenant's recurring writes no longer holds the server from other tenants: such
  writes wait for slots shared between tenants (Added). In the audit's test another tenant's
  worst read went from 12.4 s to about 0.3 s.
- `slotlock_get_free_busy` and `slotlock_find_next_available` read a resource named more than once
  once, and read 10,000 busy intervals in all across a request, answering `400
  calendar_work_limit` past that. A request naming 100 resources, or one resource 100 times, did
  100 times the work of one.
- `slotlock_find_next_available` expands 100,000 bookable windows in all, answering `400
  calendar_work_limit` past that, and walks a resource's busy time once rather than once per
  window. 100 resources with 50 daily rules each, searched over a year, held the process for about
  seven seconds.
- `slotlock_list_events` reads a resource named more than once once. One id named 100 times read
  its events 100 times and returned the first event 100 times.
- The application API's busy read (`GET /v1/resources/{id}/busy`) stops at the first interval past
  the 10,000 it may return, instead of reading the whole window first. `store.listBusy` takes a
  `limit`.
- The recurrence budget counts work, not time, and now charges what each step costs, time zone
  reads included. Fifty writes of `FREQ=DAILY;INTERVAL=9999;BYMONTH=2;BYMONTHDAY=29` held the
  server for 23 seconds, and forty daily London series held a feed for 35 seconds; a refused write
  now ends within about a tenth of a second, and a feed within about half a second.
- A feed event may list 8 RRULEs, and each one past the first costs a step at every occurrence it
  passes. One event with 110,000 RRULEs (2 MB) held `parseICalendarFeed` for about 9 seconds.
- One recurring series can no longer stop its tenant's maintenance. A rule naming two wall times in
  a spring-forward gap (`FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30` in New York) gave one instant twice,
  its roll failed every pass, and no other series of the tenant extended or had its expired holds
  purged. An instant is now one occurrence wherever the rule names it again, and a series whose
  roll fails for any other reason is refused and put back (Upgrade notes).
- An event's title, description, location and participant names may hold a tab or a line break,
  and no other control character; its UID none. ical.js left a bare CR in what `emitICalendar` and
  `emitITipCalendar` wrote, so a reader that ends lines at one read the rest as properties of its
  own (`METHOD:CANCEL`). A CRLF line break is kept as LF.
- The Node listener refuses a request target with a dot segment between backslashes
  (`/v1/resources\..\availability`), as it refuses one between slashes: URL parsing reads a
  backslash as a slash. An encoded backslash (`%5C`) is still an ordinary character.
- A write confirmation no longer states a series' dates in UTC when it could not read the event (a
  write-only key, a refused or slow read) and the update names no time zone. The store books the
  series in the event's own zone, so the dates approved could differ from those booked. The
  question now shows the rule and says its dates follow the event's existing zone.
- An event whose organizer or attendee address the store keeps but `z.email()` refuses, such as
  `ops@localhost` from an imported feed, no longer makes every listing of its window answer 500 and
  stop paginating (Upgrade notes).
- Dashboard sign-ins are counted per client network, in the Worker and in `slotlock serve`: an
  IPv4 address, or an IPv6 client's /48, so a site rotating through its addresses cannot use up the
  ceiling every other client shares. Every other request counts an IPv6 client as its /64. The
  dashboard runs at most two sign-ins from one client at once.
- The example dashboard Worker configuration removes query strings, which hold OAuth codes, from
  the URLs Workers Logs keep.
- SECURITY.md and the README say write confirmation is attested by the client: it keeps an agent
  from writing unasked and is not an authorization boundary. SECURITY.md also says how hosted
  Slotlock may be tested: your own account only, no other account's data, no load or denial of
  service, reports through private vulnerability reporting.
- Development lockfiles only (nothing reaches the package or the image): the site's and the
  dashboard Worker's Wrangler move undici from 7.29.1 to 7.30.1 (GHSA-xjj6-f33q-929c, high), and
  the development lockfile moves body-parser from 2.3.0 to 2.4.0 (GHSA-27r3-jxmh-p828).

### Added

- The application API serves the store calls it lacked, each in `openapi.json` and the five
  clients: a resource's `visibility` (`private` ones are never shown to agents) and `archived_at`;
  `POST /v1/resources/{id}/archive` and `…/restore`, and `DELETE /v1/resources/{id}` (`409
  resource_in_use` while anything on it is live); `GET /v1/holds/{id}`,
  `GET /v1/resources/{id}/holds`, `GET /v1/reservations/{ref}`,
  `GET /v1/resources/{id}/reservations` and `GET /v1/resources/{id}/busy`, paged and bounded to
  367 days; `GET /v1/tenant/events` and `GET`/`DELETE /v1/tenant/events/{id}`, which reach and
  cancel any key's event, a revoked one's included; and `GET /v1/tenant`, the key's tenant and
  whether it is suspended.
- `POST /v1/tenant/erase` erases the key's tenant, with its reference as `confirm_tenant_ref`. It is
  off unless the application backend is created with `tenantErasure: true` (`slotlock serve` leaves
  it off) and refused while the tenant is suspended.
- `POST /v1/holds` and `DELETE /v1/tenant/events/{id}` take a retry identity as the
  `Idempotency-Key` header as well as `idempotency_key`; a hold retried with it answers the first
  hold, and the key reused with another request is `409 idempotency_conflict`. Another application
  route refuses the header (`400 idempotency_key_not_supported`) rather than ignore it.
- In the store: private resources, which agents neither list, describe nor book; `archiveResource`,
  `restoreResource` and `deleteResource`; holds with a turnaround buffer the booking keeps and a
  retry identity; `getHold`, `listHolds`, `getReservation` and `listReservations`; and reading,
  listing and cancelling any key's event as the tenant.
- Tenant limits in the store (`tenantLimits`: resources, holds, reservations, events, coverage),
  refused with `*_limit_reached`. They count what is live or still to come plus what the tenant
  added in the last 30 days, so ended history leaves them. Maintenance now deletes expired holds.
- Tenant suspension and erasure: the deployment role may `suspendTenant` (with a reason) and
  `unsuspendTenant`; a suspended tenant may read, its writes are refused `tenant_suspended`, and it
  gets no new API key. `eraseTenant` deletes every row a tenant owns in one call and says how many
  from each table. No serving role may suspend.
- `slotlock resource archive|restore|delete <ref>` and `slotlock tenant status|suspend|unsuspend|erase`.
  `suspend` and `unsuspend` connect as `SLOTLOCK_MIGRATE_DATABASE_URL`'s role, the only one that
  may; `erase` needs `--confirm` repeating `SLOTLOCK_TENANT`.
- `slotlock_update_event` takes `expected_resource_id`: an event since moved to another resource is
  not found, checked under the event's lock.
- `slotlock serve` limits requests: per client address before any key is looked up, then per API
  key, per tenant and for the whole server, with reads and writes counted apart (by default 20
  reads and 5 writes a second per key and per tenant). The application API counts in its tenant's
  own budget (`app_read`, `app_write`). A refusal answers 429 `rate_limited` with `Retry-After` and
  the `RateLimit` and `RateLimit-Policy` fields. `SLOTLOCK_LIMITS` changes the limits. Behind a
  proxy without `SLOTLOCK_TRUSTED_PROXY_HEADER`, the first request carrying a client-address field
  logs a `client_address_field_ignored` warning. The health check is not counted, and reuses one
  database check a second.
- `slotlock serve` runs a recurring create and every event update one at a time per tenant and per
  server (`tenant_series_writes`, `series_writes`), taking the write's token before it waits; each
  server process counts its own slots. A freed slot rests for as long as the server was busy while
  the write before held it, up to a second, so writes that each hold it under a second keep the
  server busy at most about half the time. It then goes to the waiting tenant with the fewest
  writes in flight and, among those, the one whose writes have kept the server busy least lately.
  Tenants with more writes waiting never go ahead of one sending a write at a time, but many
  tenants with one write each and less use, new ones included, can each go ahead of it once. Four
  more of a tenant's writes may wait and the rest get 429. When the server's 64 places are taken,
  a write from a tenant with fewer writes in flight than the one with the most takes the place of
  that tenant's last write, which gets 503 `server_busy`. One that has waited two seconds gets 429
  while its tenant's own write is still running, otherwise 503 `server_busy`. An application API
  maintenance run waits the same way for slots of its own: one per tenant, `maintenance_runs` (1)
  per server.
- `createSlotlockAgentServer` takes `subscriptions.maxPerTenant`, which `slotlock serve` sets from
  `tenant_subscriptions`.
- `slotlock serve` logs a `refusals` line each minute there are any, and at shutdown: auth
  refusals, rate limits, lookup overflows, busy series writes, busy maintenance runs and bodies too
  large, with clients named only by per-process pseudonyms.
- `createSlotlockNodeServer` hands the fetch target the connection's remote address as a second
  argument.
- `parseICalendarFeed` reads a feed series by series and names the series it refuses, with why,
  instead of refusing the whole calendar; the worker pool offers it too.
  `recurrenceRuleProblem(rule)` says why a rule shape is refused, and
  `storedCalendarEventProblem(event)` why a stored event would be.
- An exported calendar carries a VTIMEZONE for each IANA zone it names, so a reader that does not
  know the name reads the times as Slotlock does.
- The npm package ships `openapi.json`, the REST API's OpenAPI 3.1 document, exported as
  `slotlock/openapi.json`. The capability manifest names the 0.2 surfaces: `rest-api`,
  `application-api`, `api-keys`, `dashboard` and `maintenance`.
- The five language clients are published with each release: `slotlock` on PyPI and crates.io,
  `Slotlock.Client` on NuGet, `io.pylota:slotlock` on Maven Central and the Go module's
  `clients/go/v<version>` tag, each after the release suite passes and a maintainer approves. They
  now carry the package's version (they said 0.1.0 beside a 0.2.0 server).
  `docs/release/clients.md` has each registry's one-time setup.
- `scripts/check-stage.sh <stage-id>`, which a maintainer runs before `npm stage approve`. It
  refuses a stage whose tarball is not the one the release tested, whose dist-tag would move
  `latest` backwards, or whose runtime dependencies, installed as a consumer would that day, have a
  high or critical advisory. 0.2.0 went public with zod 4.6.5 after `main` had moved past it.
- A known-issues notice for 0.2.0: in the README, on the site (`/docs/known-issues/`) and as text
  for the v0.2.0 release notes, a pinned issue and two security advisories
  (`docs/release/0.2.0-known-issues.md`). It names the six ways 0.2.0 can accept a double booking
  around daylight-saving changes and series ends, and the zod pin with its workaround.
  `docs/release/deprecations.md` gives the `npm deprecate` and `mcp-publisher status` commands for
  0.0.0-stage, 0.1.0, 0.1.1 and 0.2.0.
- For hosted Slotlock: drafts of a privacy notice (`PRIVACY.md`), Terms of Service (`TERMS.md`,
  with data processing terms) and an Acceptable Use Policy (`ACCEPTABLE-USE.md`), each marked for
  owner and legal review; a service page (`docs/hosted/README.md`) with addresses, price, limits
  and contacts; `VERSIONING.md`, what `/v1`, the tools and the version numbers promise; a public
  status from an off-server probe (`docs/hosted/status.md`, off until the owner sets
  `SLOTLOCK_STATUS_PROBE`); and `.github/SUPPORT.md`, the route for each kind of request.

### Changed

- A recurring event occupies both readings of each occurrence across a clock change: RFC 5545's
  exact duration from its start, and its written end on the wall clock. A start in a skipped hour
  moves forward by the gap, and one in a repeated hour takes the first instant. One-off events,
  overrides and PERIOD RDATEs keep their exact times. Feeds, the trusted importer and the store all
  read events this way.
- A stored series is expanded from the instants it holds, and its exceptions name occurrences by
  UTC instant (exported as UTC `RECURRENCE-ID`s).
- A series' occurrences never overlap each other: one that reaches past the next one's start ends
  there, and the next ends at the later of the two ends.
- Recurring series are stored for up to 369 days (`SLOTLOCK_MATERIALIZATION_WINDOW_DAYS`), so a
  full 367-day search can be complete; search, free/busy and coverage windows keep their 367-day
  cap.
- A booking, hold or event first extends each series on its resource that is not stored as far as
  it reaches, so it meets their occurrences. A write past the rolling horizon on a resource whose
  series goes on past it is refused with `recurrence_not_materialized`; a series known to have
  ended does not count.
- A confirmed hold becomes a booking of its tenant whose reference is the hold's id, at revision 1,
  so it can be read, moved and cancelled like any booking (`slotlock_confirm_hold` says so).
  `createReservation` on a tenant's resource does the same. The migration, and maintenance for
  rows a 0.2 server writes during a rolling deploy, give older such bookings their tenant.
- `server.json` (the MCP Registry entry) no longer marks `SLOTLOCK_AUTH_TOKEN` and
  `SLOTLOCK_CONFIRMATION_SECRET` as required, and its Authorization header takes the token or an
  API key.
- `slotlock --help` describes the server token as read and write, never admin.
- Releases: npm's `latest` dist-tag, and the image's `latest` tag, never move backwards. A release
  on an older line takes `latest-<major>.<minor>` and a prerelease `next`, and a release stops when
  the registry cannot say which version is `latest`. The image and the MCP Registry entry are
  published only after the release's own suite passes, each behind an approval; the image's
  attestation is still signed by `image.yml`. The packed NOTICE is written at build time from the
  lockfile, so a dependency bump no longer breaks the release checks. **Release a version** takes
  `dry_run`.
- Repository: CI runs the database suites on PostgreSQL 16, 17 and 18 and the Compose quickstart
  end to end, and one check, "CI passed", gathers every job, the language clients included.
  `scripts/configure-github.sh` requires it and DCO's "Signed-off-by" on `main` with no admin
  bypass, puts the person who runs it as reviewer on the publishing environments, and sets up
  CodeQL and Dependabot for every manifest.

### Fixed

- 0.2.0's six double-booking cases (Known issues in the README): a first occurrence spanning a
  clock change, the repeated hour of an autumn change in stored series, exceptions in a skipped
  hour, occurrences starting in a skipped hour, a timed series with a date-only `UNTIL` (now its
  whole day on the series' clock), and an iCalendar `DURATION` counting hours across a spring
  change.
- A weekly-hours window whose edge falls in a skipped hour stands where the gap ends, so it holds
  only the wall times it names that exist. It used to move, or give nothing.
- A yearly rule on a day some years lack (29 February) occurs in the years that have it instead of
  being refused.
- A feed's daily or weekly series from years ago is searched from near the window, so a daily
  standup since 2014 no longer refuses its feed. A CalDAV server's expanded series whose first
  instance has no `RECURRENCE-ID` keeps its later instances busy.
- A series whose DTEND falls in a skipped hour no longer holds an extra hour every later day.
- Series the roll cannot extend (in conflict or over the budget) no longer keep a healthy series
  from rolling, however many there are. The roll puts each behind for an hour and takes those it
  has never put back first; its cursor carries that place (`rollRetryAt`), and a pass says when it
  stopped before them (`rollPending`), so `slotlock serve` and `slotlock maintain` go round again
  at once. The roll names the series it could not extend because of a collision
  (`conflictEventIds`).
- A refused update of a recurring event names the booking in its way, not its own first
  occurrence.
- The quickstart: `.env.example` turns the REST API on, as `slotlock serve` and Compose do, and
  the docs say PostgreSQL 16 or newer (Compose ships 18).
- Documentation: SPEC.md and the README describe 0.2 and later, and SPEC.md gains a daylight-saving
  section; the README says which spelling of an availability rule each surface takes
  (`startMinutes` for `slotlock hours set` and `SLOTLOCK_AVAILABILITY`, `start_minutes` over
  REST); the site names the version to install and has pages for the clients, operations and the
  hosted service.

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
