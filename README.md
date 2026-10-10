# Slotlock

Slotlock is a calendar for AI agents. It schedules vehicles, rooms, machines, people, or any other
reservable resource, answers "when is this free?" from deterministic availability rules, and lets
PostgreSQL, not an application pre-check, reject double bookings under concurrency. Agents reach it
over MCP or A2A, or you call it as a TypeScript library.

> **Status: pre-release.** 0.1.0 is not on npm yet. Until the first release is tagged, build it
> from this repository: `npm ci && npm run build` at the root, then `npm install <path-to>/dist` in
> your project.

## Why it is built for agents

- Resources, not users, own calendars. Tenancy comes only from the authenticated caller.
- Every interval is half-open `[start, end)`, so adjacent bookings never collide.
- A PostgreSQL exclusion constraint arbitrates overlapping writes; conflicts come back as data.
- Writes are idempotent (per-tenant idempotency keys) and guarded by expected revisions.
- Free/busy says whether it is *certain*: missing provider syncs or an unmaterialized recurrence
  make time unproven rather than free.
- Tool names, schemas and errors are portable across Claude, OpenAI and every MCP host.
- Recurrence, exceptions, organizers, attendees/RSVP and reminders are bounded; iCalendar input is
  size-limited and content-minimised before an agent sees it.

## Install

```sh
npm install slotlock postgres
```

- **Node.js** 22.12 or newer. CI runs the suite on Node.js 22 and 24.
- **PostgreSQL** 16, with the `btree_gist` extension (`applySchema` creates it in schema `slotlock`
  when it is missing).
- **postgres** (Postgres.js) `^3.4.5` is a peer dependency: Slotlock uses the client you create, so
  your application and Slotlock share one version and one set of types.
- **TypeScript**: declarations are included and reference `@types/node` (install it as a dev
  dependency). They compile under `strict`, `exactOptionalPropertyTypes` and `"types": []`, the
  TypeScript 6 default; the release check compiles a consumer with TypeScript 5.7, and the
  declarations were also checked with 5.9, 6.0 and 7.0.

## Self-host with Docker

From a clone of this repository, with Docker and Compose v2:

```sh
cp .env.example .env
# Fill in the four empty secrets in .env, each with: openssl rand -hex 32
docker compose up --build --detach
```

This runs PostgreSQL 16 and the Slotlock server, published on `127.0.0.1` only:

| URL | What |
| --- | --- |
| `http://localhost:8080/mcp` | MCP, with `Authorization: Bearer <SLOTLOCK_AUTH_TOKEN>` |
| `http://localhost:8080/a2a` | A2A 1.0 JSON-RPC, same token; card at `/.well-known/agent-card.json` |
| `http://localhost:8080/healthz` | Readiness, including the database |

Agents book resources that exist, so add them first:

```sh
docker compose exec slotlock slotlock resource add vehicle-42 --timezone Europe/London
docker compose exec slotlock slotlock resource list
```

- A one-off `migrate` service applies the schema as the database owner and grants `slotlock_app`,
  the role the server connects as. That role owns nothing and cannot bypass row-level security,
  and the server never sees the owner's password. Its container is read-only and unprivileged.
- The server refuses a weak `SLOTLOCK_AUTH_TOKEN` or `SLOTLOCK_CONFIRMATION_SECRET` (under 32
  characters, or repetitive), needs the confirmation secret while writes wait for a person, and
  never logs either. The token reads and writes in one tenant (`SLOTLOCK_TENANT`). Compose asks
  for it so the quickstart works at once; outside Compose it is optional, and
  [API keys](#api-keys) work with or without it.
- Writes wait for a person by default (`SLOTLOCK_CONFIRM_WRITES=all`, see
  [Confirm before writing](#confirm-before-writing)). `SLOTLOCK_AVAILABILITY` sets the bookable
  hours `slotlock_find_next_available` searches; without it, no slot is ever offered.
- To serve beyond this machine, put a TLS reverse proxy in front and set `SLOTLOCK_PUBLIC_URL` to
  its `https://` URL.

Without Docker, the package's `slotlock` command does the same: `slotlock migrate`, then
`slotlock serve`. Configuration comes only from environment variables; `slotlock --help` lists them.

### API keys

Give each agent or integration its own key instead of sharing the server token:

```sh
docker compose exec slotlock slotlock key create "Booking agent"
docker compose exec slotlock slotlock key create "Availability bot" --scope read --expires-in-days 90
docker compose exec slotlock slotlock key list
docker compose exec slotlock slotlock key rotate <id>
docker compose exec slotlock slotlock key revoke <id>
```

- `key create` prints the key once: `slk_` and 46 letters and digits, sent as
  `Authorization: Bearer slk_…`. Slotlock stores only its SHA-256, so a lost key cannot be shown
  again; rotate it.
- A key acts in the tenant it was created for (`SLOTLOCK_TENANT` when you ran `key create`), not
  the server's, so one server can serve several tenants, each through its own keys.
- `read` covers the five tools that only look; `write` covers `slotlock_create_event`,
  `slotlock_update_event` and `slotlock_delete_event`. The default is both. A key without the scope
  gets `forbidden`, and writes still wait for a person while `SLOTLOCK_CONFIRM_WRITES` guards them.
  `tools/list` shows every tool to every client.
- Events belong to the key that booked them. `key rotate` gives a key a new secret and keeps its
  id, scopes, expiry and events, so rotate a key that leaked or is due. `key revoke` retires the
  key: its events stay on the calendar, but no other key can update or cancel them over MCP or A2A.
- A revoked, expired or rotated-out key stops working on its next request, including a live-update
  subscription at its next poll, and is never accepted again. `key list` shows each key's prefix,
  scopes, expiry and last use (to the minute), never the key.
- A tenant may hold 100 active keys and 1,000 in all, revoked and expired ones included.
- The last six characters are a checksum, so a secret scanner can tell a real key from a
  look-alike offline: SHA-256 of the 40 characters after `slk_`, first 32 bits, as 6 base62 digits
  (`0-9A-Za-z`).
- The server role reaches keys only through SECURITY DEFINER functions in the `slotlock` schema. It
  can create, list, rotate, revoke and erase a tenant's keys and check a presented one; it cannot
  read a stored digest or bring back a revoked, rotated-out or erased key. It names the tenant of
  each call, as it does for every query, so its `DATABASE_URL` opens every tenant: guard it like a
  key to all of them.
- Anyone can make a well-formed key, so key lookups use at most two database connections at a time
  with up to 256 waiting, and a request past that is refused as unauthenticated: a flood of made-up
  keys cannot take the connections authenticated requests use. Rate-limit a public server in front
  of Slotlock as well.

## Connect an MCP client

Any MCP client that speaks Streamable HTTP connects to `http://localhost:8080/mcp` with the token
from `.env`.

**Claude Code** (local scope by default, kept in `~/.claude.json` rather than the project):

```sh
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer $SLOTLOCK_AUTH_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project; the token comes from your
environment):

```json
{
  "mcpServers": {
    "slotlock": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer ${env:SLOTLOCK_AUTH_TOKEN}" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`; VS Code asks for the token once and stores it securely):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "slotlock-token",
      "description": "Slotlock bearer token",
      "password": true
    }
  ],
  "servers": {
    "slotlock": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer ${input:slotlock-token}" }
    }
  }
}
```

With the default `SLOTLOCK_CONFIRM_WRITES=all`, a write runs only after the person accepts
Slotlock's confirmation, which needs a client that speaks MCP 2026-07-28 with form elicitation.
Other clients can read calendars, and their writes come back as `confirmation_required`. Set
`SLOTLOCK_CONFIRM_WRITES=none`, or list only the writes that need a person, to let agents book on
their own.

## Quick start: the next free slot

No database needed for the availability maths:

<!-- example: examples/availability.ts#next-slot -->
```ts
import { expandRules, findNextAvailable } from 'slotlock';

const searchWindow = {
  start: new Date('2026-09-14T00:00:00Z'),
  end: new Date('2026-09-21T00:00:00Z'),
};

// Weekdays 09:00-17:00, evaluated in the resource's own timezone (DST included).
const windows = expandRules(
  [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 8 * 60 }],
  searchWindow,
  'Europe/London',
);

export const slot = findNextAvailable({
  windows,
  busy: [{ start: new Date('2026-09-14T09:00:00Z'), end: new Date('2026-09-14T10:00:00Z') }],
  durationMs: 2 * 60 * 60 * 1000,
});
// slot = { start: 2026-09-14T10:00:00Z, end: 2026-09-14T12:00:00Z }: Monday 08:00-09:00 UTC
// (09:00 London) is too short before the busy hour.
```

`expandRules` supports the deterministic weekly subset its types describe (`WeeklyAvailabilityRule`).
A rule it cannot evaluate contributes no availability; it never manufactures a slot.

## Set up PostgreSQL

Slotlock uses two database roles:

| Role | Owns | Used for |
| --- | --- | --- |
| Deployment role | the `slotlock` schema and tables | `applySchema`, `applyTenantRls`, `grantApplicationRole`, once per release |
| Application role | nothing (`NOSUPERUSER NOBYPASSRLS`) | all traffic; forced row-level security confines it to one tenant at a time |

Create the application role once (`CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER
NOBYPASSRLS;`), then deploy as the owner:

<!-- example: examples/deploy.ts#deploy -->
```ts
import { createSlotlockStore } from 'slotlock';
import postgres from 'postgres';

export async function deploySlotlock(deployUrl: string, applicationRole: string): Promise<void> {
  const sql = postgres(deployUrl, { max: 1, onnotice: () => {} });
  try {
    const store = createSlotlockStore(sql);
    await store.applySchema(); // idempotent; serialized across instances
    await store.applyTenantRls(); // forced row-level security on every Slotlock table
    await store.grantApplicationRole(applicationRole); // schema usage + DML, nothing else
  } finally {
    await sql.end();
  }
}
```

`grantApplicationRole` grants `USAGE` on the schema and `SELECT, INSERT, UPDATE, DELETE` on the
twelve tables in `SLOTLOCK_TENANT_TABLES`, nothing else. It first refuses (`unsafe_application_role`,
whose `reasons` say what it found) a role that could get around forced RLS or the exclusion
arbiter, itself, through a role it belongs to (a member can `SET ROLE` to it or use its privileges)
or through `PUBLIC`: superuser, `BYPASSRLS`, `REPLICATION` or `CREATEROLE`; `pg_read_server_files`,
`pg_write_server_files` or `pg_execute_server_program`; ownership of the database, of anything in
it (its temporary objects and its own default privileges aside), or of `btree_gist`; `CREATE` on the
database or on any schema; `TRUNCATE`, `REFERENCES` or
`TRIGGER` on a Slotlock table, or by default on new ones; a right on a server setting. In short, the
application role owns nothing and can create nothing. The list is not exhaustive
([SECURITY.md](./SECURITY.md) names what it does not read). Run it after every `applySchema`: a
release may add a table, and the check only sees what exists when it runs. To manage grants
yourself, `createSlotlockApplicationRoleGrantsDdl(role)` returns the same statements, without the
check.

The deployment functions resolve names only in `pg_catalog` for their transaction and restore your
`search_path` afterwards: the deployment role owns every table, so a function it found through a
schema another role can write would run with that ownership. For the same reason `applySchema` and
`applyTenantRls` refuse (`unsafe_slotlock_schema`, whose `reasons` say what they found) a `slotlock`
schema that another role owns or can create objects in, that holds an object another role owns (an
extension included), or whose tables another role may add triggers to or have a trigger running a
function another role owns (superusers aside): let `applySchema` create the schema, or create it as
the deployment role. A schema owned by a group role you belong to counts as another role's: deploy
as that role (`SET ROLE`). `SLOTLOCK_CORE_DDL` and
`createSlotlockTenantRlsDdl()` pin `search_path` and refuse the same way (SQLSTATE `42501`), and
restore your `search_path` at their end; apply each in one transaction (`psql --single-transaction`),
since under autocommit the pin ends with the statement that sets it.

The tenant context is the transaction-local setting `slotlock.tenant_ref`. An application that already
has one (say `app.tenant_id`) creates its stores with `{ tenantContextSetting: 'app.tenant_id' }` and
calls `applyTenantRls()`. Once bound, changing the setting fails with `tenant_context_conflict`; a
deliberate migration calls `applyTenantRls({ allowRebind: true })` with a store for the new setting.

## Book and read as the application

<!-- example: examples/store.ts#connect -->
```ts
import { type SlotlockStore, createSlotlockStore } from 'slotlock';
import postgres from 'postgres';

export function openSlotlock(applicationUrl: string) {
  const sql = postgres(applicationUrl, { max: 10 });
  return { sql, store: createSlotlockStore(sql) };
}
```

<!-- example: examples/store.ts#book -->
```ts
export async function bookHandover(store: SlotlockStore, tenantRef: string) {
  // withTenant pins one connection and sets the tenant for everything inside the callback. Under
  // forced RLS, a call made outside it sees no rows at all.
  return store.withTenant(tenantRef, async (tenant) => {
    const vehicle = await tenant.createResource({
      tenantRef,
      externalRef: 'vehicle-42',
      timezone: 'Europe/London',
    });
    const handover = await tenant.putCalendarEvent({
      tenantRef,
      externalRef: 'handover-BK-42',
      idempotencyKey: 'booking-BK-42-create',
      expectedRevision: 0, // 0 creates; later writes pass the revision they last read
      resourceId: vehicle.id,
      start: new Date('2027-03-29T09:00:00Z'),
      end: new Date('2027-03-29T10:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Vehicle handover',
      organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
      attendees: [{ email: 'renter@example.com', participationStatus: 'needs_action', rsvp: true }],
      reminders: [{ action: 'display', minutesBeforeStart: 30 }],
    });
    if (!handover.ok) throw new Error(`handover not booked: ${handover.code}`);

    const freeBusy = await tenant.getFreeBusy({
      tenantRef,
      resourceId: vehicle.id,
      window: { start: new Date('2027-03-29T00:00:00Z'), end: new Date('2027-03-30T00:00:00Z') },
    });
    // freeBusy.busy is [09:00, 10:00); freeBusy.coverage.state is 'complete'.
    return { vehicle, handover, freeBusy };
  });
}
```

`withTenant` validates the tenant, sets the context transaction-locally on the one connection every
callback call uses, supports nested savepoints, and restores the previous context. Do not issue a
standalone `set_config(..., true)` through a pool: its transaction ends before the next call.

Writing rules:

- Create with `expectedRevision: 0`; update with the revision you last read and a new idempotency
  key. Replaying the same command and key returns the original result (`idempotent: true`); reusing
  a key with a different payload returns `idempotency_conflict`.
- A conflicting opaque occurrence returns `{ ok: false, code: 'overlap' }`. Transparent events
  never block.
- Cancelling leaves a tombstone, so a delayed create cannot resurrect the event; use a new external
  reference for a genuinely new event.
- `listCalendarEvents` and `listResources` return at most 1,000 rows and page with keyset cursors.

### Recurring events

<!-- example: examples/store.ts#recurring -->
```ts
export async function scheduleWeeklyInspection(
  store: SlotlockStore,
  tenantRef: string,
  resourceId: string,
) {
  return store.withTenant(tenantRef, (tenant) =>
    tenant.putCalendarEvent({
      tenantRef,
      externalRef: 'inspection-vehicle-42',
      idempotencyKey: 'inspection-vehicle-42-create',
      expectedRevision: 0,
      resourceId,
      start: new Date('2027-03-30T07:00:00Z'),
      end: new Date('2027-03-30T08:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Weekly inspection',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=8' },
      // Occurrences are materialized into this window; the horizon worker rolls it forward.
      materializationWindow: {
        start: new Date('2027-03-30T00:00:00Z'),
        end: new Date('2027-05-30T00:00:00Z'),
      },
    }),
  );
}
```

Occurrences are materialized into a bounded window (at most 367 days, 2,000 occurrences). Opaque
recurring events add the intrinsic coverage source `SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE`, so a
free/busy query past a recurrence's materialized horizon reports incomplete coverage until the
maintenance job below rolls it forward.

### External calendars

Provider adapters (Google, Microsoft, CalDAV, marketplaces) stay in your application; Slotlock gives
them provider-neutral boundaries:

- `normalizeExternalCalendarChange` for webhook/API changes, `parseICalendarChanges` for bounded
  RFC 5545 ingestion, `emitICalendar` for deterministic publish/cancel payloads.
- `parseTrustedICalendarEvents` keeps full event content only for authenticated callers;
  `emitITipCalendar` serializes `PUBLISH`, `REQUEST`, `REPLY` and `CANCEL`.
- All-day (`VALUE=DATE`) events, series included, become whole local days in the calendar's timezone:
  the `calendarTimezone` argument, else the feed's `X-WR-TIMEZONE`. A feed with neither is refused
  rather than guessed.
- After a cursor has completely represented a window, call `recordCalendarCoverage`. Pass the
  sources a resource depends on as `requiredSources` to `getFreeBusy`; any `coverage.state` other
  than `complete` means the time is not proven free.

OAuth with providers, webhook verification, cursor storage, leases and retries belong to the
adapter, which keeps credentials and tenant policy out of the core.

## Expose Slotlock to agents

One operation registry is served over MCP and A2A by the same HTTP handler. The store backend binds
tenancy to the authenticated principal and never calls time free while coverage is incomplete.

<!-- example: examples/agent-server.ts#server -->
```ts
import {
  type SlotlockAgentOperation,
  type SlotlockAgentPrincipal,
  type SlotlockStore,
  createSlotlockAgentServer,
  createSlotlockStoreAgentBackend,
} from 'slotlock';
import { createSlotlockNodeServer } from 'slotlock/node-server';

// An allow-list, so an operation added in a later release stays refused until you add it. This one
// permits everything except deleting events; a real policy also looks at the principal and input.
const ALLOWED_OPERATIONS: ReadonlySet<SlotlockAgentOperation> = new Set([
  'slotlock_list_resources',
  'slotlock_get_free_busy',
  'slotlock_find_next_available',
  'slotlock_create_event',
  'slotlock_get_event',
  'slotlock_list_events',
  'slotlock_update_event',
]);

export interface CalendarServerConfig {
  store: SlotlockStore;
  /** The fixed public URL, e.g. https://calendar.example.com/slotlock. Never read from a request. */
  publicBaseUrl: string;
  port: number;
  /** Your token check: the principal (subject + tenant) for a valid token, else null (401). */
  verifyToken(token: string): Promise<SlotlockAgentPrincipal | null>;
  /** Development only: serve http://localhost instead of requiring HTTPS. */
  allowInsecureLocalhost?: boolean;
  /** A random secret of 32+ bytes; set it to have a person confirm every booking an agent makes. */
  confirmationSecret?: string;
}

export async function startCalendarServer(config: CalendarServerConfig) {
  const server = createSlotlockAgentServer({
    publicBaseUrl: config.publicBaseUrl,
    allowInsecureLocalhost: config.allowInsecureLocalhost === true,
    // MCP 2026-07-28 clients that can show a form are asked "Book … ?" before the write runs;
    // clients that cannot ask anyone (2025 revisions, A2A) have those writes refused, not trusted.
    ...(config.confirmationSecret
      ? {
          confirmation: {
            operations: ['slotlock_create_event', 'slotlock_update_event'] as const,
            secrets: [config.confirmationSecret],
          },
        }
      : {}),
    // Rentals are booked months ahead: calendar resources (and live updates) look 90 days ahead,
    // and a subscribed agent hears of a change within about five seconds.
    resourceWindowDays: 90,
    subscriptions: { pollIntervalMs: 5_000 },
    backend: createSlotlockStoreAgentBackend(config.store, {
      // Bookable hours per resource. No rules means never bookable, not open all week.
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 480 },
      ],
    }),
    authenticate: async (request) => {
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return token ? config.verifyToken(token) : null;
    },
    // Runs after argument validation on every call, with the current operation name even when the
    // client used a legacy dotted alias.
    authorize: async ({ operation }) => ALLOWED_OPERATIONS.has(operation),
    health: async () => ({ ready: true, checks: ['database'] }),
  });

  const listener = createSlotlockNodeServer(server, {
    requestOrigin: new URL(config.publicBaseUrl).origin,
  });
  await listener.listen({ host: '127.0.0.1', port: config.port });
  // listener.close() ends open subscriptions gracefully, then drains in-flight requests.
  return listener;
}
```

- `authenticate` resolves the caller from trusted credentials only. Tenant, role and approvals never
  come from tool arguments; a request naming another tenant is rejected.
- `authorize` runs after argument validation on every call; `consumeRateLimit` (optional) runs once
  per HTTP request (`operation: 'protocol'`) and once per operation. Both, and the backend's
  `context.operation`, always receive the current name (`slotlock_delete_event`), also when the
  client used a dotted alias, so key policy on current names and prefer an allow-list.
- `publicBaseUrl` must be HTTPS. `allowInsecureLocalhost: true` permits `http://localhost`,
  `127.0.0.1` and `[::1]` for development. Mount `server.fetch(request)` in any Fetch-compatible
  runtime instead of the Node listener if you prefer.
- Browsers: requests carrying an `Origin` header must match `allowedOrigins` (default: the origin
  of `publicBaseUrl`). The server sends no CORS headers, so a web page on another origin cannot call
  it directly; call it from your backend.
- The server answers only below the path of `publicBaseUrl` (plus the origin-root agent card and
  OAuth metadata), so a proxy in front of it must forward that path unchanged, not strip it.
- The Node listener is plain HTTP: bind it privately behind a TLS proxy. `requestOrigin` is fixed
  configuration, never taken from `Host` or forwarding headers. It bounds header receipt (10 s),
  body and handler time (30 s), keep-alive (5 s) and requests per socket (100); a disconnect,
  timeout or shutdown aborts the backend's `Request.signal`.

### Endpoints

| Method and path | What |
| --- | --- |
| `POST {base}/mcp` | MCP (Streamable HTTP, stateless: JSON responses, an SSE stream only for `subscriptions/listen`; `GET`/`DELETE` answer 405) |
| `POST {base}/a2a` | A2A 1.0 JSON-RPC, synchronous `SendMessage` |
| `GET {base}/.well-known/agent-card.json` | A2A agent card, also served at the origin root |
| `GET {base}/manifest.json` | Protocol versions, endpoints and every tool's input/output JSON Schema |
| `GET {base}/healthz` | Readiness from your `health` callback |
| `GET /.well-known/oauth-protected-resource{/path}` | OAuth protected-resource metadata, when `oauth` is set |

### Tools

| Tool | Does | Hints |
| --- | --- | --- |
| `slotlock_list_resources` | Resources visible to the tenant | read-only |
| `slotlock_get_free_busy` | Busy intervals plus coverage certainty | read-only |
| `slotlock_find_next_available` | Earliest *certain* slot across resources | read-only |
| `slotlock_list_events` | Events the caller created in a window | read-only |
| `slotlock_get_event` | One event the caller created | read-only |
| `slotlock_create_event` | Create an event of up to 3,660 days (idempotent) | write |
| `slotlock_update_event` | Patch at an expected revision | write |
| `slotlock_delete_event` | Tombstone at an expected revision | write, destructive |

A query window (free/busy, slot search, event lists) is at most 367 days, and a slot search can look
for a slot that long; an event itself may last up to 3,660 days, so a lease or a year-long rental is
one event. The input and output JSON Schemas are in `tools/list` and in `manifest.json`. Earlier builds used dotted names (`calendar.list_resources`), which some tool-calling
APIs reject; those names still work on every entry point but are no longer advertised.
`resolveSlotlockAgentOperation` maps either spelling to the current name; `isSlotlockAgentOperation`
accepts current names only.

Events are scoped to the principal that created them: `slotlock_get_event`, `slotlock_list_events`,
`slotlock_update_event` and `slotlock_delete_event` see only the caller's own events. Everything
else on a resource, including events your application wrote through the store, still counts as busy
time in free/busy and slot search.

### Errors

A refused or failed operation is data the model can act on, not a protocol failure:

- **MCP**: a result with `isError: true` and text `{"error":{"code":"…"}}`, without
  `structuredContent` (MCP clients validate structured content against the tool's output schema).
- **A2A**: the reply message's data part is `{"error":{"code":"…"}}`.

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | Input failed the tool's schema, or a window is inverted or longer than 367 days |
| `forbidden` | `authorize` refused the call |
| `rate_limited` | `consumeRateLimit` refused the call |
| `not_found`, `resource_not_found`, `event_not_found` | Not visible to this principal |
| `overlap` | The time is taken by an opaque event or reservation |
| `revision_conflict`, `idempotency_conflict`, `event_cancelled` | Re-read, then retry with the current revision or a new key |
| `owner_event_quota_exceeded`, `owner_command_quota_exceeded` | Per-principal quota reached (see Operations) |
| `confirmation_required` | The write needs a person's confirmation, which this client cannot collect (2025 MCP, A2A) |
| `confirmation_declined`, `confirmation_cancelled` | The person said no, or dismissed the question |
| `invalid_cursor`, `invalid_event`, `invalid_window`, … | A bounded input the store rejected |
| `request_aborted`, `store_inconsistent` | Transient; retry |

A backend of your own reports a failure the agent should see by throwing
`new SlotlockAgentOperationError(code, status)` with a `snake_case` code (anything else becomes
`operation_failed`): the agent receives `code` as above, whatever the status, since MCP counts a
failed downstream call as a tool execution error. Two codes are reserved for server faults:
`internal_error` and `invalid_backend_result` never reach the agent, whichever throws them. Any
other exception, and output that fails the tool's schema, is a server fault whose message never
leaves the server.

Protocol failures use the transport's own errors: `401` with `WWW-Authenticate`, `403` for a
disallowed origin, `413`/`415` for body problems, `429` for the protocol-level limit. MCP answers an
unknown tool with JSON-RPC `-32602` and a server fault with `-32603`. On 2026-07-28 it also answers,
with HTTP 400, `-32020` when a header disagrees with the body, `-32021` when a guarded write needs a
client capability that was not declared (form elicitation), `-32022` for a revision it does not
implement (with the ones it does), and `-32602` for a confirmation state that was altered or issued
for another caller, tool or arguments (an expired one is simply asked again); an unknown method is
HTTP 404 `-32601`, and a rate limit is HTTP 429 `-31029` (the
revision reserves `-32020` to `-32099`; 2025 clients keep `-32029`). A2A keeps every JSON-RPC error
in an HTTP 200 envelope with a `google.rpc.ErrorInfo` detail: `-32009` for an unsupported
`A2A-Version`, `-32003` for push-notification methods, `-32004` for streaming, task subscription and
the extended card, `-32602` for a message that is not one data part. Every reply is a message, so the
server keeps no tasks: `GetTask` and `CancelTask` answer `-32001` (task not found) and `ListTasks` an
empty page, once their params pass the same checks as `SendMessage`'s (known fields, the caller's own
`tenant`, proto types, and no `pageToken`, since none is issued).

### Authentication and OAuth discovery

`authenticate` verifies whatever bearer token you issue. To let OAuth-capable MCP hosts find your
authorization server, add RFC 9728 protected-resource metadata:

<!-- example: examples/oauth.ts#oauth -->
```ts
import type { SlotlockAgentServerOAuthOptions } from 'slotlock';

export const oauth: SlotlockAgentServerOAuthOptions = {
  // Issuers whose access tokens your `authenticate` accepts (it must also check their audience),
  // written exactly as each server's metadata `issuer`: clients compare them as strings.
  authorizationServers: ['https://auth.example.com'],
  scopesSupported: ['calendar:read', 'calendar:write'],
  // Named in the 401 challenge so a client requests them up front.
  requiredScopes: ['calendar:read'],
};
```

A `401` from `/mcp` then carries `WWW-Authenticate: Bearer realm="slotlock",
resource_metadata="…/.well-known/oauth-protected-resource/slotlock/mcp", scope="calendar:read"`.
Slotlock only publishes the metadata; `authenticate` must still validate each token, including that
its audience is your `/mcp` URL.

### Confirm before writing

`confirmation` (see the server example) makes the listed writes wait for a person. On MCP
2026-07-28 the first `tools/call` answers `input_required` with a one-checkbox form whose message
says exactly what will change, for example `Book "Vehicle handover" on resource vehicle-42:
2027-03-29 10:00–11:00 (Europe/London).`; the client shows it and repeats the call with the answer,
and only an explicit acceptance runs the write. The pending confirmation travels as a
`requestState` sealed with your `secrets` (HMAC-SHA256) to the caller, the tool, the exact arguments
and an expiry (`ttlSeconds`, default 600), so it cannot approve another booking, caller or change.
Authorization and argument validation run first: nobody is asked to approve a call that could not
run.

- A 2026-07-28 client that did not declare form elicitation gets `-32021`. The 2025 revisions and
  A2A cannot carry the question, so a listed write fails there with `confirmation_required`.
- `secrets` holds 1 to 8 keys of at least 32 bytes. The first signs and all verify, so rotate by
  listing the new key first and dropping the old one after `ttlSeconds`.
- `onEvent` receives `{ type: 'confirmation', operation, outcome }` (`requested`, `accepted`,
  `declined`, `cancelled`, `expired`, `refused`, `unavailable`) for audit; never arguments or
  identities.

### Calendar resources and live updates

On MCP 2026-07-28 each resource the caller can see is also an MCP resource,
`slotlock://resources/{resource_id}` (`slotlockCalendarResourceUri(id)` builds it). `resources/read`
returns its busy intervals and coverage for the next `resourceWindowDays` days (default 30, at most
367). `subscriptions/listen` answers with an SSE stream: an acknowledgment naming the resources it
will watch (those this caller may read), then `notifications/resources/updated` whenever one's
free/busy changes, whoever changed it.

- Slotlock finds changes by re-reading each open subscription's resources through your backend every
  `subscriptions.pollIntervalMs` (default 10 s). Each re-read authenticates the listen request's
  credentials again and is authorized, so an expired token, a withdrawn permission or a deleted
  resource ends the stream. Re-reads skip `consumeRateLimit`.
- A read's window rolls forward with the clock, so a subscription watches one fixed span that holds
  every window a read can return while it is open: from when it opened to `resourceWindowDays` plus
  `maxDurationMs` ahead. A booking that enters the rolling end is announced; the clock alone never
  is. That span must fit the 367-day horizon, which the server checks when it is built.
- A subscription ends gracefully, with the listen request's result (so the client knows not to
  reconnect), after `maxDurationMs` (default 15 minutes), on `shutdown()` or when access is lost. It
  ends without a result after three failed re-reads in a row or when the client stops reading the
  stream.
- Open subscriptions are capped per principal (`maxPerPrincipal`, default 4) and per server
  (`maxTotal`, default 256); over a cap, `subscriptions/listen` answers HTTP 429. `subscriptions:
  false` turns live updates off and stops discovery advertising them.
- `createSlotlockNodeServer`'s `close()` calls the server's `shutdown()` first, so open streams end
  gracefully instead of being cut at the grace period. Elsewhere, call `server.shutdown()` before
  you stop serving.

### Caching and tracing

2026-07-28 results carry cache hints: discovery, the tool list, the resource template and the
calendar view are `public` for an hour; a tenant's resource list is `private` for a minute;
free/busy is `private` and stale at once (`ttlMs: 0`). W3C `traceparent`, `tracestate` and `baggage`,
from the request's `_meta` or else its HTTP headers, are validated and handed to your backend as
`context.trace` on MCP (both eras) and A2A, so its spans can join the agent's trace.

## Connect an agent

### MCP (any client)

<!-- example: examples/mcp-client.ts#mcp -->
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function findSlotOverMcp(mcpUrl: string, token: string, resourceId: string) {
  const client = new Client({ name: 'fleet-assistant', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'slotlock_find_next_available',
      arguments: {
        resource_ids: [resourceId],
        start: '2027-03-29T00:00:00Z',
        end: '2027-04-05T00:00:00Z',
        duration_minutes: 120,
      },
    });
    // A refusal or conflict is a result the model reads ({"error":{"code":…}}), not an exception.
    if (result.isError) {
      const [text] = result.content as Array<{ type: 'text'; text: string }>;
      return { error: JSON.parse(text?.text ?? '{}').error as { code: string } };
    }
    return { slot: result.structuredContent };
  } finally {
    await client.close();
  }
}
```

Slotlock speaks MCP 2026-07-28 to clients that send its per-request `_meta` (they find it with
`server/discover`, as the TypeScript SDK v2 does in `auto` mode), and negotiates 2025-11-25 or
2025-06-18 through `initialize` with everyone else, including the SDK 1.x client above; there it
also answers `ping`. It keeps no sessions and answers every `POST` with JSON, except
`subscriptions/listen`, whose answer is an SSE stream.

### MCP 2026-07-28: confirmation and live updates

With the official TypeScript SDK v2 (`npm install @modelcontextprotocol/client`), a client shows
Slotlock's confirmation to the person and hears about calendar changes:

<!-- example: examples/mcp-live.ts#live -->
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { slotlockCalendarResourceUri } from 'slotlock';

export interface LiveCalendarOptions {
  mcpUrl: string;
  token: string;
  resourceId: string;
  /** Show Slotlock's sentence ("Book … on resource …: 2027-03-29 10:00–12:00 (Europe/London).") */
  confirm(message: string): Promise<boolean>;
  /** The resource's free/busy changed; call read() for the new one. */
  onChange(uri: string): void;
}

export async function openLiveCalendar(options: LiveCalendarOptions) {
  const client = new Client(
    { name: 'fleet-assistant', version: '1.0.0' },
    // 'auto' asks server/discover first and speaks 2026-07-28 when the server does.
    { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
  );
  // Slotlock asks before a guarded write; the SDK calls this, then repeats the call with the answer.
  client.setRequestHandler('elicitation/create', async (request) =>
    (await options.confirm(request.params.message))
      ? { action: 'accept' as const, content: { confirm: true } }
      : { action: 'decline' as const },
  );
  client.setNotificationHandler('notifications/resources/updated', (notification) =>
    options.onChange(notification.params.uri),
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    }),
  );

  const uri = slotlockCalendarResourceUri(options.resourceId);
  // The acknowledgment lists what the server agreed to watch: nothing when this token cannot read it.
  const subscription = await client.listen({ resourceSubscriptions: [uri] });
  return {
    watching: subscription.honoredFilter.resourceSubscriptions ?? [],
    book: (booking: Record<string, unknown>) =>
      client.callTool({
        name: 'slotlock_create_event',
        arguments: { resource_id: options.resourceId, ...booking },
      }),
    read: async () => {
      const [content] = (await client.readResource({ uri })).contents;
      return content && 'text' in content ? JSON.parse(content.text) : null;
    },
    close: async () => {
      await subscription.close();
      await client.close();
    },
  };
}
```

`openLiveCalendar` works against the server example started with a `confirmationSecret`.

**Claude Code** (a static bearer token; keep it out of a committed project-scope `.mcp.json`):

```sh
claude mcp add --transport http slotlock https://calendar.example.com/slotlock/mcp \
  --header "Authorization: Bearer $SLOTLOCK_TOKEN"
```

**Claude API** (MCP connector, beta header `anthropic-beta: mcp-client-2025-11-20`). The server
must be reachable from the internet over HTTPS; Anthropic's servers make the MCP calls:

```json
{
  "model": "<model id>",
  "max_tokens": 1024,
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://calendar.example.com/slotlock/mcp",
      "name": "slotlock",
      "authorization_token": "<token your authenticate accepts>"
    }
  ],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "slotlock" }],
  "messages": [{ "role": "user", "content": "When is vehicle 42 free for two hours next week?" }]
}
```

### A2A 1.0

<!-- example: examples/a2a-client.ts#a2a -->
```ts
import { SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';

export async function listResourcesOverA2a(baseUrl: string, token: string) {
  // Fetches .well-known/agent-card.json relative to baseUrl (Slotlock answers it under its base path
  // and at the origin root), then calls the card's JSON-RPC interface.
  const client = await new ClientFactory().createFromUrl(baseUrl);
  const reply = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        // One application/json data part: the skill id and its arguments (see the agent card).
        parts: [
          {
            data: { skill: 'slotlock_list_resources', arguments: { limit: 10 } },
            mediaType: 'application/json',
          },
        ],
      },
    }),
    { serviceParameters: { Authorization: `Bearer ${token}` } },
  );
  // The reply's single data part is the skill result, or {"error":{"code":…}} when refused.
  const part = 'parts' in reply ? reply.parts[0] : undefined;
  return part?.content?.$case === 'data' ? part.content.value : undefined;
}
```

Invoke a skill with a `SendMessage` whose message has exactly one `application/json` data part,
`{"skill": "<id>", "arguments": {…}}`. Each skill in the agent card carries an invocation example;
the argument and result JSON Schemas are in `manifest.json`. Send `A2A-Version: 1.0` (a missing
header means 0.3, which Slotlock does not implement). The binding is synchronous: no streaming, push
notifications or tasks.

### MCP Apps

Slotlock implements the MCP Apps extension `io.modelcontextprotocol/ui` (2026-01-26). Read-only tools
link to `ui://slotlock/calendar` through `_meta.ui.resourceUri`; a compatible host renders that
self-contained `text/html;profile=mcp-app` view in its sandbox. The view loads no external scripts,
fonts or images, makes no network requests (its CSP declares no domains) and inserts event text
with `textContent`. It never authorizes or performs writes. Other clients ignore `_meta.ui`.

## Operations

<!-- example: examples/maintenance.ts#maintenance -->
```ts
import { type SlotlockStore, calendarEventRollingHorizon } from 'slotlock';

const MAX_BATCHES = 10;

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  // 1. Keep recurring events materialized across the rolling 367-day horizon. Beyond it, free/busy
  //    reports the time as unproven rather than free.
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let horizonCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const roll = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window }),
    );
    extended += roll.extended;
    conflicts += roll.conflicts; // a colliding occurrence keeps its previous horizon
    if (!roll.hasMore) {
      horizonCapped = false;
      break;
    }
  }

  // 2. Release agent quota: idempotency commands and agent tombstones past the 30-day replay window.
  let pruned = 0;
  let retentionCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const prune = await store.withTenant(tenantRef, (tenant) =>
      tenant.pruneCalendarEventRetention({ tenantRef }),
    );
    pruned += prune.commandsDeleted + prune.tombstonesDeleted;
    if (!prune.hasMore) {
      retentionCapped = false;
      break;
    }
  }
  // A capped run finishes on the next one; alert if it stays capped.
  return { extended, conflicts, pruned, capped: horizonCapped || retentionCapped };
}
```

- **Run maintenance at least daily for every tenant.** Forced RLS hides other tenants from the
  application role, so iterate your own tenant list.
- **Quotas.** Each agent principal may retain 1,000 event identities (active plus cancelled) and
  10,000 idempotency commands, of which 9,000 can be creates or updates, so a cancel always has
  room. Adjust with `agentOwnerEventQuota` and `agentOwnerCommandQuota` on `createSlotlockStore`.
  `pruneCalendarEventRetention` is what returns quota.
- **Retention.** Commands are exact-replay evidence for the replay window, by default
  `SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS` (30) days: pruning deletes older commands for every owner,
  then agent-owned tombstones older than the window with no command left. `internal` tombstones
  (provider and sync authority) are kept until you erase the tenant. After the window a retried
  command is evaluated afresh under its expected revision, and a pruned agent identity can be
  created again. `retentionDays` (1-3650) changes the window; keep it longer than any client retries.
- **Erasure.** Include Slotlock resources, reservations, tombstones, archives, event content,
  occurrences, commands and coverage rows in your tenant-erasure workflow and delete order, and
  delete the tenant's API keys with `createSlotlockApiKeyStore(sql).erase({ tenantRef })`. Only
  their SHA-256 digests stay, with nothing about the tenant, so an erased key is never accepted
  again.

### Production checklist

1. PostgreSQL with TLS, backups and point-in-time recovery.
2. Deploy as the owner; serve as a `NOBYPASSRLS` role granted by `grantApplicationRole`.
3. Every application call runs inside `withTenant`; test isolation with a `NOBYPASSRLS` role.
4. Verify every provider webhook before normalization; keep provider credentials out of Slotlock.
5. Bound retries around serialization and deadlock outcomes; never blindly retry an unknown write.
6. Reconcile external calendars with durable cursors and explicit coverage windows.
7. Monitor conflict rates, hold expiry, sync lag, capped maintenance runs, quota errors, and
   (through `onEvent`) confirmation outcomes and subscription closes.
8. Keep calendar writes approval-gated wherever your policy requires it: `confirmation` asks a person
   on MCP 2026-07-28 and refuses the write where no one can be asked.
9. Size live updates: each open subscription re-reads its resources every `pollIntervalMs`, so the
   backend load is at most `maxTotal` reads per interval. Close the listener with `close()` (or call
   `shutdown()`) so streams end gracefully.
10. Give each agent its own API key with the narrowest scope it needs and an expiry, and revoke the
    keys you no longer use.

## Supported versions

| | Version |
| --- | --- |
| MCP | 2026-07-28 (stateless), 2025-11-25, 2025-06-18; tested with the TypeScript SDK 1.30.1 and 2.1.0 |
| A2A | 1.0, JSON-RPC binding |
| MCP Apps | `io.modelcontextprotocol/ui` 2026-01-26 |
| Node.js | ≥ 22.12 (CI: 22 and 24) |
| PostgreSQL | 16 |
| postgres (peer) | ^3.4.5 |

## Project status and boundaries

0.1 is the core: availability maths, timezone-aware weekly rules, atomic holds and reservations,
revisioned external commands, trusted event CRUD with recurrence, coverage-aware free/busy, tenant
RLS, bounded iCalendar/iTIP interchange, MCP/A2A bindings with human confirmation and live calendar
updates, and an MCP Apps view. Provider transports (Google, Microsoft, CalDAV), credential storage,
delivering notifications to people (email, SMS, push), durable A2A tasks and a human calendar
application are yours to build around it.

Events need a finite, positive duration: all-day events are whole local days (see External
calendars), and a one-off event may last up to 3,660 days. Recurring series are materialized within
the rolling 367-day horizon. Open-ended entries (tasks, events without an end) are rejected rather
than turned into occupation with an ambiguous duration.

The normative semantics are in [SPEC.md](./SPEC.md). Tools can read
[`slotlock.manifest.json`](./slotlock.manifest.json) (schema:
[`slotlock-manifest.schema.json`](./slotlock-manifest.schema.json)) without running package code.
Report vulnerabilities as described in [SECURITY.md](./SECURITY.md); see
[CONTRIBUTING.md](./CONTRIBUTING.md), [GOVERNANCE.md](./GOVERNANCE.md) and
[MAINTAINERS.md](./MAINTAINERS.md) for how the project runs.

## License

Apache-2.0. Copyright 2026 TREFT LTD. Dependency notices are in [NOTICE](./NOTICE).
