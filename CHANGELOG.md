# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning.

## 0.1.0 - Unreleased

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

### Fixed for the standalone release

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
- Every dashboard form but sign-out must carry its single-use value. A form sent without the value
  skipped the resend check and the per-person form limit.

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
