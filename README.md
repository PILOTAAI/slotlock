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
- `SLOTLOCK_AVAILABILITY` sets the bookable hours; without it no slot is ever offered.
  `SLOTLOCK_CONFIRM_WRITES=all` (the default) makes every write wait for a person.
- To serve beyond this machine, put a TLS proxy in front and set `SLOTLOCK_PUBLIC_URL`.

Without Docker: `slotlock migrate`, then `slotlock serve`. `slotlock --help` lists every setting.

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
resources, which is how the hosted Slotlock hands out keys:

1. On GitHub, open Settings, Developer settings, OAuth apps, New OAuth App, and set the
   "Authorization callback URL" to `<SLOTLOCK_PUBLIC_URL>/dashboard/callback`. Then generate a
   client secret on the app's page.
2. Set `SLOTLOCK_GITHUB_CLIENT_ID` and `SLOTLOCK_GITHUB_CLIENT_SECRET` from the app,
   `SLOTLOCK_SESSION_SECRET` to 32+ random characters (`openssl rand -hex 32`), and
   `SLOTLOCK_DASHBOARD_USERS` to the GitHub user ids that may sign in (`gh api users/<login> --jq .id`),
   or to `*` for every GitHub account.
3. Run `slotlock serve` and open `<SLOTLOCK_PUBLIC_URL>/dashboard`.

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
- Each instance remembers, in bounded memory, sign-ins it finished (a callback works once), sessions
  signed out (a copied cookie stays out) and forms sent (a reload does not create or rotate a key
  twice). Run one instance, or route each person to one, for these to hold across instances; the
  signed cookies, the allowlist and CSRF hold everywhere.
- A person may add 100 resources. Bookable hours come from `SLOTLOCK_AVAILABILITY` and apply to every
  tenant's resources. Rate-limit `/dashboard/sign-in` and `/dashboard/callback` at your proxy: each
  callback costs a call to GitHub, and an instance runs at most eight at once.

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

- `withTenant` sets the tenant for every call in the callback, on one connection. Outside it, forced
  row-level security shows no rows.
- `expectedRevision: 0` creates; an update passes the revision it last read and a new idempotency
  key. Replaying a command returns its first result.
- An overlap comes back as `{ ok: false, code: 'overlap' }`. Transparent events never block.
- Cancelling leaves a tombstone, so a late retry cannot bring the event back.
- Lists return at most 1,000 rows and page with cursors.

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

### External calendars

Provider adapters (Google, Microsoft, CalDAV) stay in your application, with their credentials.
Slotlock gives them neutral boundaries:

- `normalizeExternalCalendarChange` for webhook changes; `parseICalendarChanges` and `emitICalendar`
  for bounded iCalendar in and out; `emitITipCalendar` for invitations.
- All-day events become whole local days in the calendar's time zone; a feed without one is refused.
- `recordCalendarCoverage` marks how much of a feed is read. Pass the sources a resource depends on as
  `requiredSources`, and any coverage short of `complete` means the time is not proven free.

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
- `availabilityRules` returns a resource's bookable hours. No rules means never bookable.
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
| `not_found`, `resource_not_found`, `event_not_found` | Not visible to this caller |
| `overlap` | The time is taken |
| `revision_conflict`, `idempotency_conflict`, `event_cancelled` | Re-read, then retry with the current revision or a new key |
| `owner_event_quota_exceeded`, `owner_command_quota_exceeded` | Per-caller quota reached (see [Operations](#operations)) |
| `confirmation_required` | The write needs a person, and this client cannot ask one |
| `confirmation_declined`, `confirmation_cancelled` | The person said no, or dismissed the question |
| `invalid_cursor`, `invalid_event`, `invalid_window`, … | The store rejected a bounded input |
| `request_aborted`, `store_inconsistent` | Transient; retry |

#### Errors from your own backend

Throw `new SlotlockAgentOperationError('snake_case_code', status)` and the agent receives the code.
Any other exception is a server fault, and its message never leaves the server.

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
will change, such as `Book "Vehicle handover" on resource vehicle-42: 2027-03-29 10:00–11:00
(Europe/London).` Only an explicit yes runs the write.

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
import { type SlotlockStore, calendarEventRollingHorizon } from 'slotlock';

const MAX_BATCHES = 10;

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let horizonCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const roll = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window }),
    );
    extended += roll.extended;
    conflicts += roll.conflicts;
    if (!roll.hasMore) {
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
  return { extended, conflicts, pruned, capped: horizonCapped || retentionCapped };
}
```

- It keeps recurring events stored across the 367-day horizon and frees quota by pruning
  idempotency records older than the 30-day replay window (`retentionDays`).
- Each agent may keep 1,000 events and 10,000 idempotency records (`agentOwnerEventQuota`,
  `agentOwnerCommandQuota` on `createSlotlockStore`).
- Erasure: delete the tenant's resources, reservations, events and coverage, and its API keys with
  `createSlotlockApiKeyStore(sql).erase({ tenantRef })`.

### Production checklist

1. PostgreSQL with TLS, backups and point-in-time recovery.
2. Deploy as the owner; serve as a `NOBYPASSRLS` role granted by `grantApplicationRole`.
3. Run every call inside `withTenant`; test isolation with a `NOBYPASSRLS` role.
4. Verify provider webhooks before normalizing them; keep provider credentials out of Slotlock.
5. Bound retries on serialization failures; never blindly retry an unknown write.
6. Reconcile external calendars with durable cursors and coverage windows.
7. Monitor conflicts, sync lag, capped maintenance runs, quota errors and confirmation outcomes.
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
