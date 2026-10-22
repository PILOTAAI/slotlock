# Slotlock

Slotlock is a calendar for AI agents. It books vehicles, rooms, machines, people or anything else
reservable, answers "when is this free?" from weekly availability rules, and lets PostgreSQL reject
double bookings, however many writers race. Agents call it over MCP or A2A; your code calls it as a
TypeScript library.

> **Status: pre-release.** 0.1.0 is not on npm yet. Build it from this repository:
> `npm ci && npm run build`, then `npm install <path-to>/dist` in your project.

## Why it is built for agents

- Resources own calendars, not users, and the tenant comes only from the authenticated caller.
- Intervals are half-open `[start, end)`, so back-to-back bookings never collide.
- A PostgreSQL exclusion constraint decides overlaps; a conflict comes back as data, not an error.
- Writes are idempotent and take an expected revision.
- Free/busy says whether it is *certain*: a calendar not yet synced makes time unproven, not free.
- Tool names, schemas and errors work on Claude, OpenAI and every MCP host.

## Install

```sh
npm install slotlock postgres
```

Node.js 22.12+, PostgreSQL 16 with `btree_gist` (created for you if missing), and `postgres` ^3.4.5
as a peer dependency. TypeScript declarations are included.

## Self-host with Docker

From a clone of this repository:

```sh
cp .env.example .env    # set the four empty secrets: openssl rand -hex 32
docker compose up --build --detach
docker compose exec slotlock slotlock resource add vehicle-42 --timezone Europe/London
```

| URL | What |
| --- | --- |
| `http://localhost:8080/mcp` | MCP, with `Authorization: Bearer <SLOTLOCK_AUTH_TOKEN>` |
| `http://localhost:8080/a2a` | A2A 1.0, same token; card at `/.well-known/agent-card.json` |
| `http://localhost:8080/healthz` | Readiness, including the database |

- The server runs as a role that owns nothing and cannot bypass row-level security; a one-off
  `migrate` service applies the schema as the owner.
- `SLOTLOCK_AVAILABILITY` sets the default bookable hours. A resource can have its own
  (`slotlock hours set`, or the dashboard); with neither, no slot is offered.
  `SLOTLOCK_CONFIRM_WRITES=all` (the default) makes every write wait for a person.
- To serve beyond this machine, put a TLS proxy in front and set `SLOTLOCK_PUBLIC_URL`.

```sh
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=SA","startMinutes":600,"durationMinutes":240}]' --resource vehicle-42
slotlock hours clear --all    # back to SLOTLOCK_AVAILABILITY
```

`slotlock --help` lists every setting.

### Without Docker

From a clone, with Node.js 22.12+ and PostgreSQL 16, build once and run each command as
`node dist/cli.js` (a clone does not put `slotlock` on your `PATH`). Use two roles, as Compose does:
the server connects as a role that owns nothing and cannot bypass row-level security, and `migrate`
connects as the database owner and grants that role what it needs. `serve` refuses to start as a
superuser or a `BYPASSRLS` role, which row-level security does not confine.

```sh
npm ci && npm run build
# Once, as a superuser:
#   CREATE ROLE slotlock_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOBYPASSRLS;
export SLOTLOCK_MIGRATE_DATABASE_URL='postgresql://<owner>:<owner password>@localhost:5432/slotlock'
export DATABASE_URL='postgresql://slotlock_app:<app password>@localhost:5432/slotlock'
export SLOTLOCK_AUTH_TOKEN="$(openssl rand -hex 32)"
export SLOTLOCK_CONFIRMATION_SECRET="$(openssl rand -hex 32)"
node dist/cli.js migrate
node dist/cli.js resource add vehicle-42 --timezone Europe/London
node dist/cli.js serve
```

The `slotlock …` commands in this README run the same way as `node dist/cli.js …` (with Compose,
`docker compose exec slotlock slotlock …`).

### API keys

Give each agent its own key instead of sharing the server token:

```sh
slotlock key create "Booking agent"
slotlock key create "Availability bot" --scope read --expires-in-days 90
slotlock key list
slotlock key rotate <id>
slotlock key revoke <id>
```

- A key (`slk_…`) is shown once and stored only as a SHA-256. Send it as `Authorization: Bearer`.
- It acts in the tenant it was created for (`SLOTLOCK_TENANT`), so one server serves many tenants.
- `read` covers the five tools that only look; `write` covers create, update and delete. Default:
  both.
- `rotate` keeps the key's id, scopes and bookings; `revoke` stops it on its next request.
- A tenant may hold 100 active keys. The last six characters are a checksum secret scanners can
  verify offline.

### Dashboard

The server can also serve a dashboard where people sign in with GitHub and manage their own keys and
resources, so you can give each person API keys without running `slotlock key create` for them:

1. On GitHub, open Settings, Developer settings, OAuth apps, New OAuth App, and set the
   "Authorization callback URL" to `<SLOTLOCK_PUBLIC_URL>/dashboard/callback`. Then generate a
   client secret on the app's page.
2. Set `SLOTLOCK_GITHUB_CLIENT_ID` and `SLOTLOCK_GITHUB_CLIENT_SECRET` from the app,
   `SLOTLOCK_SESSION_SECRET` to 32+ random characters (`openssl rand -hex 32`), and
   `SLOTLOCK_DASHBOARD_USERS` to the GitHub user ids that may sign in (`gh api users/<login> --jq .id`),
   or to `*` for every GitHub account.
3. Run `slotlock serve` and open `<SLOTLOCK_PUBLIC_URL>/dashboard`. With Compose, set the four in
   `.env` (empty, the default, leaves the dashboard off) and run `docker compose up --detach`.

- Each person gets a tenant of their own, `github:<user id>`: the keys, resources and bookings in it
  are theirs alone. Keys made with `slotlock key create` act in `SLOTLOCK_TENANT` instead.
- Sign-in asks GitHub for no scope, uses `state` and PKCE, and keeps nothing from GitHub but the user
  id and login: the GitHub token is used once and dropped.
- A session is a signed, HttpOnly cookie that lasts 12 hours. The allowlist is checked on every
  request, dashboard and API alike: removing an id and restarting the server signs that person out
  and stops every key in their tenant at once.
- Every form carries a token bound to the session and must come from the server's own origin; the
  pages run no inline script, under a Content-Security-Policy that allows only their own files.
- Give the dashboard an origin of its own (`https://slotlock.example.com`, not a path beside other
  apps): its cookies are host-wide, so any other app on the same origin could read them.
- Finished sign-ins (a callback works once), signed-out sessions (a copied cookie stays out) and sent
  forms (a reload does not create or rotate a key twice) are recorded in Postgres, so they hold on
  every server that shares the database, behind any load balancer. Each is a SHA-256 digest, kept
  until its cookie or form expires (12 hours at most); a form record also carries a digest of the
  GitHub user id that sent it. The server role reaches them only through two SECURITY DEFINER
  functions, and `serve` refuses to start the dashboard until `migrate` has granted them.
- The database's clock decides when a sign-in or session has expired, so servers whose clocks drift
  from it or from each other cannot let a replay or a signed-out session through. Keep clocks in
  sync all the same: a server more than 12 hours ahead of the database cannot sign anyone in.
- Each form carries a single-use value bound to its session. A person may have 1,000 forms
  recorded at once (12 hours' worth); past that the dashboard answers 429 until the oldest expire.
  Signing out always works.
- A person may add 100 resources. The database holds the cap, so adds racing on any number of servers
  stop at 100; a resource they already have can still change time zone.
- Each resource uses the server's bookable hours (`SLOTLOCK_AVAILABILITY`) until its owner sets its
  own on the hours page: two windows a day, overnight or all day, or closed. One form sets them
  for every resource at once.

### Dashboard on Cloudflare Workers

The same dashboard can run as a Cloudflare Worker at an origin of its own (`workers/dashboard`),
while agents keep using the server. It shows the server's MCP and A2A URLs (`SLOTLOCK_SERVICE_URL`),
and reaches the server's database through Hyperdrive, as the role the server serves as.

`workers/dashboard/wrangler.jsonc` is an example: copy it into your own deployment and replace what
it marks as yours. This repository's Dashboard workflow only checks that the Worker bundles. Deploy
from your own pipeline with your own Cloudflare token: a token that can deploy Workers can replace
this one and read its session secret, which signs in as any tenant.

1. Create a Hyperdrive configuration for that role, with caching off: the dashboard reads back a
   sign-in or a form it has just recorded, and a cached sign-out check would keep a copied session
   working. Check it before each deploy (`wrangler hyperdrive get <id>`). For a database on a private
   network, connect it through Workers VPC, on the Cloudflare Tunnel that reaches it. Point the VPC
   service at a listener that serves only Slotlock's database, such as a PgBouncer with TLS and only
   that database and role, rather than at the whole Postgres:
   ```sh
   cd workers/dashboard && npm ci
   npx wrangler vpc service create slotlock-postgres --type tcp --tunnel-id <tunnel id> \
     --ipv4 <listener host> --tcp-port <listener port> --app-protocol postgresql
   read -rs SLOTLOCK_DB_PASSWORD   # not on the command line, so not in your shell history
   npx wrangler hyperdrive create slotlock-dashboard --service-id <vpc service id> \
     --database <database> --user <server role> --password "$SLOTLOCK_DB_PASSWORD" --caching-disabled
   ```
2. In your copy of the configuration, set:
   - the configuration's id;
   - your hostname (`routes`);
   - `SLOTLOCK_PUBLIC_URL`, `SLOTLOCK_SERVICE_URL` and `SLOTLOCK_DASHBOARD_USERS` (`vars`);
   - the two rate limiting bindings, each with a `namespace_id` unique in your account.
3. Create the GitHub OAuth app as above, with the callback URL
   `<SLOTLOCK_PUBLIC_URL>/dashboard/callback` on the Worker's origin.
4. Store the secrets on the Worker: `npx wrangler secret put` for `SLOTLOCK_GITHUB_CLIENT_ID`,
   `SLOTLOCK_GITHUB_CLIENT_SECRET` and `SLOTLOCK_SESSION_SECRET`.
5. Deploy: `npm ci --omit=dev` at the repository root (the Worker bundles Slotlock's sources), then
   `npx wrangler deploy --config <your configuration>` in `workers/dashboard`.

- Each request opens its own database client, at most five connections, and closes it when the
  response is sent; Hyperdrive keeps the pool.
- Anyone may start a sign-in, and each callback costs a database write and a request to GitHub
  with the app's client secret. An isolate runs at most eight at once, but Workers run many
  isolates, so two rate limiting bindings bound them all:
  - `SLOTLOCK_CLIENT_RATE_LIMIT` counts every dashboard request per client address;
  - `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts sign-ins and callbacks from every client together.

  Their counts are per Cloudflare location. Without either binding the Worker answers 503.
- The server checks a dashboard tenant against `SLOTLOCK_DASHBOARD_USERS` only when it serves the
  dashboard itself. With the dashboard on Workers, removing a person from the Worker's list signs
  them out of the dashboard; to stop their keys, revoke them or erase the tenant.
- A missing or weak secret makes the Worker answer 503 and log which variable, never its value.

## Connect an MCP client

Point any Streamable HTTP client at `http://localhost:8080/mcp` with the token.

**Claude Code:**

```sh
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer $SLOTLOCK_AUTH_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`):

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

**VS Code** (`.vscode/mcp.json`; it asks for the token once):

```json
{
  "inputs": [
    { "type": "promptString", "id": "slotlock-token", "description": "Slotlock token", "password": true }
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

With `SLOTLOCK_CONFIRM_WRITES=all`, writes need a client that can show a confirmation (MCP
2026-07-28 with form elicitation); other clients get `confirmation_required`. Set it to `none` to let
agents book on their own.

## Quick start: the next free slot

The availability maths needs no database:

<!-- example: examples/availability.ts#next-slot -->
```ts
import { expandRules, findNextAvailable } from 'slotlock';

const searchWindow = {
  start: new Date('2026-09-14T00:00:00Z'),
  end: new Date('2026-09-21T00:00:00Z'),
};

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
// slot: 2026-09-14 10:00–12:00 UTC, the first two free hours after the busy one
```

A rule `expandRules` cannot evaluate adds no availability; it never invents a slot.

## Set up PostgreSQL

| Role | Owns | Used for |
| --- | --- | --- |
| Deployment | the `slotlock` schema | `applySchema`, `applyTenantRls`, `grantApplicationRole`, once per release |
| Application | nothing (`NOSUPERUSER NOBYPASSRLS`) | all traffic, confined to one tenant by forced row-level security |

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
    await store.applySchema();
    await store.applyTenantRls();
    await store.grantApplicationRole(applicationRole);
  } finally {
    await sql.end();
  }
}
```

- `applySchema` is idempotent and safe to run from several instances at once.
- `grantApplicationRole` grants schema usage and DML on Slotlock's tables, and refuses
  (`unsafe_application_role`) a role that could get around row-level security. Run it after every
  `applySchema`. [SECURITY.md](./SECURITY.md#security-model) lists what it checks.
- `applySchema` refuses a `slotlock` schema another role controls (`unsafe_slotlock_schema`).
- Already have a tenant setting such as `app.tenant_id`? Pass `{ tenantContextSetting:
  'app.tenant_id' }` to `createSlotlockStore`.

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
      expectedRevision: 0,
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
    return { vehicle, handover, freeBusy };
  });
}
```

`withTenant` validates the tenant, sets the context transaction-locally on the one connection every
callback call uses, supports nested savepoints, and restores the previous context. Do not issue a
standalone `set_config(..., true)` through a pool: its transaction ends before the next call.
`withTenant(tenantRef, callback, { isolation: 'read committed' })` runs the callback in a READ
COMMITTED transaction whatever the role's default, and refuses inside a caller's transaction of
another level.

`createResource({ ..., maxTenantResources })` refuses a new resource (`resource_limit_reached`) once
the tenant has that many (1-100,000); an existing `externalRef` is still updated. Capped creates for
one tenant take a database lock and count under READ COMMITTED, so racing ones stop at the cap on
any number of servers; inside a REPEATABLE READ or SERIALIZABLE transaction they refuse
(`invalid_transaction_isolation`). Uncapped creates take no lock.

`setResourceAvailability({ tenantRef, id, rules })` gives a resource its own bookable hours (`null`
uses the default, `[]` closes it); `setTenantAvailability({ tenantRef, rules })` sets every resource
of a tenant. `createSlotlockStoreAgentBackend` answers from a resource's own hours and calls
`availabilityRules` only for resources without them.

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
      materializationWindow: {
        start: new Date('2027-03-30T00:00:00Z'),
        end: new Date('2027-05-30T00:00:00Z'),
      },
    }),
  );
}
```

Occurrences are stored for a window of at most 367 days and 2,000 occurrences; maintenance rolls
the window forward. Past it, free/busy reports the time as unproven.

A rule is expanded within a budget: 50,000 steps and a second for a feed (the whole read, from its
text), or for a stored series as maintenance rolls it; half of that for one event as it is written.
A feed's own time zones (VTIMEZONE) count against the same budget. A feed may carry 100 time zones,
1,000 of their observances and 2,000 RDATE values in them, and 20,000 RDATE and EXDATE values in
its events; a property's name and parameters may take 8 KB and list 100. A SECONDLY to WEEKLY step,
a `DURATION`, or an event's length may be a century at most. A calendar that needs more, such as a
rule that never occurs (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`), is refused: `invalid_event` on a
write, `invalid_icalendar` from a feed.

A feed's rules are expanded from their start. A stored series keeps where its last expansion
stopped, and the next one resumes there, so a daily series keeps rolling for as long as it runs:
its budget goes on the window, not on the years before it. A write that changes a series searches
from its start, and resumes from where it stopped only if that search is over the budget. A place
serves only the rule, start and time zone it was kept for, read by the same version of ical.js, and
never lies past an occurrence that could still reach the window (one within the event's length and
a day of it, or one an exception moves into it). Otherwise the series is searched from its start,
within the same budget. During maintenance, a stored series that outgrows the budget is counted as
`refused` (its ids in `refusedEventIds`) and keeps its old coverage.

### External calendars

Provider adapters (Google, Microsoft, CalDAV) stay in your application, with their credentials.
Slotlock gives them neutral boundaries:

- `normalizeExternalCalendarChange` for webhook changes; `parseICalendarChanges` and `emitICalendar`
  for bounded iCalendar in and out; `emitITipCalendar` for invitations.
- All-day events become whole local days in the calendar's time zone; a feed without one is refused.
- `recordCalendarCoverage` marks how much of a feed is read. Pass the sources a resource depends on as
  `requiredSources`, and any coverage short of `complete` means the time is not proven free.

Read a feed someone else controls with `createICalendarWorkerPool`, which runs the same parsers on
worker threads. However costly the feed, the thread that serves requests never runs ical.js on it: a
worker past its deadline (3 seconds by default) or its heap (128 MB) is stopped, and the feed is
refused with `CalendarExpansionLimitError`. When every worker is busy and the queue is full, the
pool answers `ICalendarWorkerBusyError` at once. A worker starts in about 40 ms and is reused; idle
workers do not keep the process alive. The pool runs from the built package (the worker is
`ical-worker-thread.js`), not from Slotlock's TypeScript sources.

<!-- example: examples/feeds.ts#feeds -->
```ts
import {
  CalendarExpansionLimitError,
  ICalendarWorkerBusyError,
  createICalendarWorkerPool,
} from 'slotlock';

// One pool for the process. Each feed is read on a worker thread; one that runs past its deadline
// or its heap is stopped, and the feed refused, while this thread carries on.
const feeds = createICalendarWorkerPool({ size: 2, deadlineMs: 3_000 });

export async function readFeed(text: string, window: { start: Date; end: Date }) {
  try {
    return {
      ok: true as const,
      changes: await feeds.parseICalendarChanges(text, undefined, window),
    };
  } catch (error) {
    // Every worker is busy and the queue is full: read this feed on the next sync.
    if (error instanceof ICalendarWorkerBusyError) return { ok: false as const, retry: true };
    // The feed takes more than Slotlock will spend reading one: tell its owner, do not retry.
    if (error instanceof CalendarExpansionLimitError) return { ok: false as const, retry: false };
    throw error;
  }
}

export function closeFeeds() {
  return feeds.close();
}
```

## Expose Slotlock to agents

One HTTP handler serves the tools over MCP and A2A. The tenant comes from your `authenticate`, never
from a tool argument.

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
  publicBaseUrl: string;
  port: number;
  verifyToken(token: string): Promise<SlotlockAgentPrincipal | null>;
  allowInsecureLocalhost?: boolean;
  confirmationSecret?: string;
}

export async function startCalendarServer(config: CalendarServerConfig) {
  const server = createSlotlockAgentServer({
    publicBaseUrl: config.publicBaseUrl,
    allowInsecureLocalhost: config.allowInsecureLocalhost === true,
    ...(config.confirmationSecret
      ? {
          confirmation: {
            operations: ['slotlock_create_event', 'slotlock_update_event'] as const,
            secrets: [config.confirmationSecret],
          },
        }
      : {}),
    resourceWindowDays: 90,
    subscriptions: { pollIntervalMs: 5_000 },
    backend: createSlotlockStoreAgentBackend(config.store, {
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 480 },
      ],
    }),
    authenticate: async (request) => {
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return token ? config.verifyToken(token) : null;
    },
    authorize: async ({ operation }) => ALLOWED_OPERATIONS.has(operation),
    health: async () => ({ ready: true, checks: ['database'] }),
  });

  const listener = createSlotlockNodeServer(server, {
    requestOrigin: new URL(config.publicBaseUrl).origin,
  });
  await listener.listen({ host: '127.0.0.1', port: config.port });
  return listener;
}
```

- `authorize` runs on every call with the current tool name, even when a client used an old alias.
  Prefer an allow-list, so a tool added in a later release stays off until you allow it.
- `availabilityRules` returns the default bookable hours, for resources without their own. No
  rules means never bookable.
- `confirmation` makes the listed writes wait for a person ([Confirm before writing](#confirm-before-writing)).
- `publicBaseUrl` must be HTTPS (`allowInsecureLocalhost` permits `http://localhost` for
  development). Run the Node listener behind a TLS proxy, or mount `server.fetch` in any Fetch
  runtime.
- The server sends no CORS headers: call it from your backend, not a web page.

### Endpoints

| Method and path | What |
| --- | --- |
| `POST {base}/mcp` | MCP over Streamable HTTP, stateless |
| `POST {base}/a2a` | A2A 1.0 JSON-RPC |
| `GET {base}/.well-known/agent-card.json` | A2A agent card, also at the origin root |
| `GET {base}/manifest.json` | Protocol versions, endpoints and every tool's JSON Schemas |
| `GET {base}/healthz` | Readiness from your `health` callback |
| `GET /.well-known/oauth-protected-resource{/path}` | OAuth metadata, when `oauth` is set |
| `{base}/v1/…`, `GET {base}/openapi.json` | [REST API](#rest-and-openapi) and its OpenAPI 3.1 document, when `rest` is on |

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

A query window is at most 367 days. Each caller sees only the events it created, but everyone's
events count as busy time. The older names `calendar.<verb>` and `calendar_<verb>` still work and
are no longer advertised.

### Errors

A refusal is a result the model can act on:

- **MCP**: `isError: true` with text `{"error":{"code":"…"}}`.
- **A2A**: the reply's data part is `{"error":{"code":"…"}}`.

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | Input failed the schema, or a window is inverted or longer than 367 days |
| `forbidden` | `authorize` refused the call |
| `rate_limited` | `consumeRateLimit` refused the call |
| `not_found`, `resource_not_found`, `event_not_found` | Not visible to this caller, or no such id: a resource id is the `id` `slotlock_list_resources` returns, not its `external_ref` |
| `overlap` | The time is taken |
| `revision_conflict`, `idempotency_conflict`, `event_cancelled` | Re-read, then retry with the current revision or a new key |
| `owner_event_quota_exceeded`, `owner_command_quota_exceeded` | Per-caller quota reached (see [Operations](#operations)) |
| `confirmation_required` | The write needs a person, and this client cannot ask one |
| `confirmation_declined`, `confirmation_cancelled` | The person said no, or dismissed the question |
| `invalid_cursor`, `invalid_event`, `invalid_window`, … | The store rejected a bounded input |
| `request_aborted`, `store_inconsistent` | Transient; retry |

#### Errors from your own backend

Throw `new SlotlockAgentOperationError('snake_case_code', status)` and the agent receives the code.
Any other exception is a server fault, and its message never leaves the server: the agent gets
`internal_error`, and `onError(error, { operation })` gets the error, as it does a result outside
the operation's output schema, so you can log it. `slotlock serve` logs it as an `agent_error` line
on stderr.

#### Protocol errors

| Where | Error |
| --- | --- |
| HTTP | `401` with `WWW-Authenticate`, `403` disallowed origin, `413`/`415` bad body, `429` rate limit |
| MCP | `-32602` unknown tool or altered confirmation, `-32603` server fault, `-32601` unknown method |
| MCP 2026-07-28 | `-32020` header disagrees with body, `-32021` form elicitation not declared, `-32022` unsupported revision, `-31029` rate limit |
| A2A | `-32009` unsupported `A2A-Version`, `-32003` push notifications, `-32004` streaming, `-32001` task not found (the server keeps no tasks) |

### Authentication and OAuth discovery

`authenticate` checks whatever bearer token you issue. To let OAuth-capable MCP hosts find your
authorization server, publish RFC 9728 metadata:

<!-- example: examples/oauth.ts#oauth -->
```ts
import type { SlotlockAgentServerOAuthOptions } from 'slotlock';

export const oauth: SlotlockAgentServerOAuthOptions = {
  authorizationServers: ['https://auth.example.com'],
  scopesSupported: ['calendar:read', 'calendar:write'],
  requiredScopes: ['calendar:read'],
};
```

A `401` from `/mcp` then points clients at the metadata and asks for `requiredScopes`. Slotlock only
publishes it: `authenticate` must still validate each token, including its audience.

### Confirm before writing

With `confirmation`, a listed write first asks the person a yes/no question that says exactly what
will change, such as `Book vehicle-42 for 2027-03-29 10:00–11:00 (Europe/London): "Vehicle
handover".` Only an explicit yes runs the write.

- Facts come first: the resource by its own reference, times in its own zone, and an event as it
  stands now, read through your backend's `describeResource` and `getEvent` when the caller may
  read them (within 2 seconds in all). Otherwise things are named by id, and each time carries its
  UTC offset. The agent's own text comes last, quoted.
- A repeating booking says how many times it books, the first and the last, and each moved
  occurrence, from the same expansion the store books with; a change to one says it covers every
  repeat. Agents may send RFC 5545 rules that repeat daily or less often and can occur.
- The pending question is sealed (HMAC-SHA256) to the caller, the tool and the exact arguments, and
  expires after `ttlSeconds` (600).
- Clients that cannot ask (MCP 2025 revisions, A2A) get `confirmation_required`; nothing is written.
- `secrets` holds 1 to 8 keys of 32+ bytes: list the new one first to rotate. `onEvent` reports each
  outcome for audit.

### Calendar resources and live updates

On MCP 2026-07-28 each resource is also an MCP resource, `slotlock://resources/{id}`, whose read
returns busy time and coverage for the next `resourceWindowDays` (30). `subscriptions/listen` streams
`notifications/resources/updated` when a resource's free/busy changes.

- Changes are found by re-reading through your backend every `subscriptions.pollIntervalMs` (10 s),
  re-checking the caller each time.
- A subscription ends after `maxDurationMs` (15 minutes), on `shutdown()`, or when access is lost.
- At most 4 open per caller and 256 per server (`maxPerPrincipal`, `maxTotal`).
  `subscriptions: false` turns them off.

### Caching and tracing

2026-07-28 results carry cache hints: discovery and tool lists are public for an hour, free/busy is
never cached. W3C `traceparent`, `tracestate` and `baggage` reach your backend as `context.trace`.

### REST and OpenAPI

`rest: true` (`SLOTLOCK_REST_API=on` for `slotlock serve`) also serves each tool as plain HTTP,
described by an OpenAPI 3.1 document at `/openapi.json`:

| Request | Tool |
| --- | --- |
| `GET /v1/resources` | `slotlock_list_resources` |
| `GET /v1/free-busy` | `slotlock_get_free_busy` |
| `GET /v1/next-available` | `slotlock_find_next_available` |
| `GET /v1/events` | `slotlock_list_events` |
| `POST /v1/events` | `slotlock_create_event` |
| `GET /v1/events/{event_id}` | `slotlock_get_event` |
| `PATCH /v1/events/{event_id}` | `slotlock_update_event` |
| `DELETE /v1/events/{event_id}` | `slotlock_delete_event` |

```sh
curl "http://localhost:8080/v1/resources" -H "Authorization: Bearer $SLOTLOCK_API_KEY"
```

- `GET` and `DELETE` take the tool's arguments as query parameters (a list repeats:
  `resource_ids=a&resource_ids=b`); `POST` and `PATCH` take a JSON body. The event id is in the path.
- Keys, scopes, `authorize` and the rate limit apply as over MCP. The body is the tool's output, or
  `{"error":{"code":…}}` with the matching HTTP status.
- REST cannot ask a person, so a write listed in `confirmation` answers `428 confirmation_required`.
- There are no CORS headers: call it from a server, not a browser.

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

A refusal or conflict is a result (`isError`), not an exception. Slotlock speaks MCP 2026-07-28 to
clients that ask for it and 2025-11-25 or 2025-06-18 to the rest.

### MCP 2026-07-28: confirmation and live updates

With the TypeScript SDK v2 (`@modelcontextprotocol/client`), a client shows Slotlock's confirmation
to the person and hears about changes:

<!-- example: examples/mcp-live.ts#live -->
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { slotlockCalendarResourceUri } from 'slotlock';

export interface LiveCalendarOptions {
  mcpUrl: string;
  token: string;
  resourceId: string;
  confirm(message: string): Promise<boolean>;
  onChange(uri: string): void;
}

export async function openLiveCalendar(options: LiveCalendarOptions) {
  const client = new Client(
    { name: 'fleet-assistant', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
  );
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

### Claude Code and the Claude API

**Claude Code:**

```sh
claude mcp add --transport http slotlock https://calendar.example.com/slotlock/mcp \
  --header "Authorization: Bearer $SLOTLOCK_TOKEN"
```

**Claude API** (MCP connector, `anthropic-beta: mcp-client-2025-11-20`; the server must be public
over HTTPS):

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
  const client = await new ClientFactory().createFromUrl(baseUrl);
  const reply = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
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
  const part = 'parts' in reply ? reply.parts[0] : undefined;
  return part?.content?.$case === 'data' ? part.content.value : undefined;
}
```

Send one `application/json` data part, `{"skill": "<id>", "arguments": {…}}`, with header
`A2A-Version: 1.0`. Each skill in the agent card has an example; replies are synchronous.

### MCP Apps

Read-only tools link to `ui://slotlock/calendar`, a self-contained calendar view that hosts
supporting MCP Apps (`io.modelcontextprotocol/ui`) render in a sandbox. It makes no network requests
and never writes.

## Operations

Run this at least daily for every tenant:

<!-- example: examples/maintenance.ts#maintenance -->
```ts
import {
  type CalendarHorizonRollCursor,
  type CalendarHorizonRollResult,
  type SlotlockStore,
  calendarEventRollingHorizon,
} from 'slotlock';

const MAX_BATCHES = 10;

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let refused = 0;
  let horizonCapped = true;
  let after: CalendarHorizonRollCursor | null = null;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const from = after;
    const roll: CalendarHorizonRollResult = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window, ...(from ? { after: from } : {}) }),
    );
    extended += roll.extended;
    conflicts += roll.conflicts;
    refused += roll.refused;
    after = roll.next;
    if (!after) {
      horizonCapped = false;
      break;
    }
  }

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
  return { extended, conflicts, refused, pruned, capped: horizonCapped || retentionCapped };
}
```

- **Run maintenance at least daily for every tenant.** Forced RLS hides other tenants from the
  application role, so iterate your own tenant list.
- **Page the roll with `next`.** Pass each batch's `next` as `after` to the next batch of the same
  pass. A series left in conflict or refused keeps its place at the front of the order, so without
  `after` every later batch would examine it again.
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
  again. The dashboard's records hold no tenant and expire within 12 hours; a form record carries a
  SHA-256 digest of the GitHub user id that sent it.

### Production checklist

1. PostgreSQL with TLS, backups and point-in-time recovery.
2. Deploy as the owner; serve as a `NOBYPASSRLS` role granted by `grantApplicationRole`
   (`slotlock serve` refuses a superuser or `BYPASSRLS` role).
3. Run every call inside `withTenant`; test isolation with a `NOBYPASSRLS` role.
4. Verify provider webhooks before normalizing them; keep provider credentials out of Slotlock.
5. Bound retries on serialization failures; never blindly retry an unknown write.
6. Reconcile external calendars with durable cursors and coverage windows.
7. Monitor conflicts, refused rules, sync lag, capped maintenance runs, quota errors and confirmation outcomes.
8. Keep writes confirmation-gated wherever your policy needs a person.
9. Size live updates: at most `maxTotal` backend reads per `pollIntervalMs`.
10. Give each agent its own API key with the narrowest scope and an expiry.

## Supported versions

| | Version |
| --- | --- |
| MCP | 2026-07-28 (stateless), 2025-11-25, 2025-06-18 |
| A2A | 1.0, JSON-RPC binding |
| MCP Apps | `io.modelcontextprotocol/ui` 2026-01-26 |
| Node.js | ≥ 22.12 (CI: 22 and 24) |
| PostgreSQL | 16 |
| postgres (peer) | ^3.4.5 |

## Project status and boundaries

0.1 is the core: availability maths, holds and reservations, events with recurrence, coverage-aware
free/busy, tenant isolation, iCalendar interchange, MCP and A2A with human confirmation and live
updates, and an MCP Apps view. Provider sync (Google, Microsoft, CalDAV), notifications to people,
and a human calendar app are yours to build around it.

Events need a finite duration (all-day events are whole local days; one event may last 3,660 days).
Open-ended entries are refused rather than guessed.

The normative rules are in [SPEC.md](./SPEC.md); tools can read
[`slotlock.manifest.json`](./slotlock.manifest.json) without running package code. Report
vulnerabilities as described in [SECURITY.md](./SECURITY.md). See [CONTRIBUTING.md](./CONTRIBUTING.md)
and [GOVERNANCE.md](./GOVERNANCE.md) for how the project runs.

## License

Apache-2.0. Copyright 2026 TREFT LTD. Dependency notices are in [NOTICE](./NOTICE).
