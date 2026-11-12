# Slotlock

Slotlock is a calendar for AI agents. It books vehicles, rooms, machines, people or anything else
reservable, answers "when is this free?" from weekly availability rules, and lets PostgreSQL reject
double bookings, however many writers race. Agents call it over MCP or A2A; your code calls it as a
TypeScript library.

## Why it is built for agents

- Resources own calendars, not users, and the tenant comes only from the authenticated caller.
- Intervals are half-open `[start, end)`, so back-to-back bookings never collide.
- A PostgreSQL exclusion constraint decides overlaps; a conflict comes back as data, not an error.
- Writes are idempotent and take an expected revision.
- Free/busy says whether it is *certain*: a calendar not yet synced makes time unproven, not free.
- Tool names, schemas and errors work on Claude, OpenAI and every MCP host.

## Get started

The documentation is at [slotlock.pylota.io/docs](https://slotlock.pylota.io/docs/), with a page
each for the [booking MCP server](https://slotlock.pylota.io/mcp-server/), the
[booking API](https://slotlock.pylota.io/booking-api/), [use cases](https://slotlock.pylota.io/use-cases/)
and [pricing](https://slotlock.pylota.io/pricing/). There are three ways to run Slotlock:

- **[Slotlock Cloud](docs/hosted/README.md)**: nothing to run. Sign in with GitHub or Google at
  `https://app.slotlock.pylota.io/dashboard`, create a key, and connect an agent to
  `https://slotlock-api.pylota.io/mcp`. Free while it is a preview, best effort, with no service
  level agreement.
- **[Self-host with Docker](#self-host-with-docker)**, or from npm with
  [Self-hosting](https://slotlock.pylota.io/docs/self-host/).
- **[As a TypeScript library](#quick-start-the-next-free-slot)** inside your own Node.js service.

### Self-host with Docker

From a clone of this repository:

```sh
scripts/quickstart-env.sh > .env    # .env.example, its four secrets set to openssl rand -hex 32
docker compose up --build --detach
docker compose exec slotlock slotlock resource add vehicle-42 --timezone Europe/London
```

| URL | What |
| --- | --- |
| `http://localhost:8080/mcp` | MCP, with `Authorization: Bearer <SLOTLOCK_AUTH_TOKEN>` |
| `http://localhost:8080/a2a` | A2A 1.0, same token; card at `/.well-known/agent-card.json` |
| `http://localhost:8080/v1/…` | [REST](https://slotlock.pylota.io/docs/api/): the tools, and the [application API](https://slotlock.pylota.io/docs/reference/#application-api) for admin keys; described at `/openapi.json` |
| `http://localhost:8080/healthz` | Readiness, including the database |
| `http://localhost:8080/metrics` | Prometheus metrics, with `Authorization: Bearer <SLOTLOCK_METRICS_TOKEN>`; off without it |

The server listens on `127.0.0.1:8080`, as a database role that cannot bypass row-level security.
`.env.example` makes every resource bookable on weekdays 09:00 to 17:00 and every write wait for a
person. The [Quickstart](https://slotlock.pylota.io/docs/quickstart/) walks through it with Claude
Code; [Self-hosting](https://slotlock.pylota.io/docs/self-host/) covers the published image,
configuration and commands, and [Operations](https://slotlock.pylota.io/docs/operations/#production-checklist)
the production checklist.

### Quick start: the next free slot

```sh
npm install slotlock postgres
```

Node.js 22.12+, PostgreSQL 16 or newer with `btree_gist` (created for you if missing), and
`postgres` ^3.4.5 as a peer dependency. TypeScript declarations are included. The availability
maths needs no database:

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

The [TypeScript library](https://slotlock.pylota.io/docs/library/) guide sets up PostgreSQL, then
books, holds and reads time under row-level security.

## Connect an agent

Point any Streamable HTTP MCP client at `http://localhost:8080/mcp` with the token (on Slotlock
Cloud, `https://slotlock-api.pylota.io/mcp` with an API key). Claude Code:

```sh
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer $SLOTLOCK_AUTH_TOKEN"
```

On Slotlock Cloud, Claude Code can also install Slotlock as a plugin: its tools, and skills for
booking without double-booking and for setting Slotlock up in a project. Put your API key in
`SLOTLOCK_API_KEY`, then:

```text
/plugin marketplace add PILOTAAI/slotlock
/plugin install slotlock@slotlock
```

Cursor, VS Code, the Claude API and the MCP and A2A SDKs are in
[Connect an agent](https://slotlock.pylota.io/docs/connect/), and every `slotlock_*` tool's input,
output and errors in the [Tools reference](https://slotlock.pylota.io/docs/tools/).

## Documentation

| For | Read |
| --- | --- |
| Running it | [Quickstart](https://slotlock.pylota.io/docs/quickstart/), [Self-hosting](https://slotlock.pylota.io/docs/self-host/), [Slotlock Cloud](docs/hosted/README.md) |
| API keys and scopes | [API keys](https://slotlock.pylota.io/docs/keys/) |
| Bookable hours and booking rules | [Hours and booking rules](https://slotlock.pylota.io/docs/booking-rules/) |
| The dashboard, organizations and the assistant | [Dashboard](https://slotlock.pylota.io/docs/dashboard/), [on Cloudflare Workers](https://slotlock.pylota.io/docs/dashboard-workers/) |
| Agents: tools, errors and protocols | [Connect an agent](https://slotlock.pylota.io/docs/connect/), [Tools reference](https://slotlock.pylota.io/docs/tools/), [Protocol reference](https://slotlock.pylota.io/docs/reference/) |
| REST, the application API, changes and webhooks | [REST API](https://slotlock.pylota.io/docs/api/), [Protocol reference](https://slotlock.pylota.io/docs/reference/#rest-and-openapi) |
| The library: store, holds, waitlists | [TypeScript library](https://slotlock.pylota.io/docs/library/) |
| Recurring events | [Recurring events](https://slotlock.pylota.io/docs/recurring-events/) |
| External calendars and iCalendar | [External calendars](https://slotlock.pylota.io/docs/external-calendars/) |
| Rate limits and tenant limits | [Limits](https://slotlock.pylota.io/docs/limits/) |
| Maintenance, retention and the production checklist | [Operations](https://slotlock.pylota.io/docs/operations/) |
| Scaling and benchmarks | [Scaling](https://slotlock.pylota.io/docs/scaling/), [Benchmarks](https://slotlock.pylota.io/docs/benchmarks/) |
| Clients for Python, Go, Rust, Java and .NET | [Clients](clients/README.md) |
| Concepts and the security model | [Concepts](https://slotlock.pylota.io/docs/concepts/), [Security](https://slotlock.pylota.io/docs/security/), [SECURITY.md](SECURITY.md) |
| The exact rules | [SPEC.md](SPEC.md) |

## Supported versions

| | Version |
| --- | --- |
| MCP | 2026-07-28 (stateless), 2025-11-25, 2025-06-18 |
| A2A | 1.0, JSON-RPC binding |
| MCP Apps | `io.modelcontextprotocol/ui` 2026-01-26 |
| Node.js | ≥ 22.12 (CI: 22 and 24; the image runs 24) |
| PostgreSQL | 16, 17 and 18 (CI runs the database suites on each; Compose ships 18) |
| postgres (peer) | ^3.4.5 |

0.2.0 and older can double-book around daylight-saving changes: [known issues](https://github.com/PILOTAAI/slotlock/blob/main/docs/release/0.2.0-known-issues.md#the-known-issues).

## Project status and boundaries

Slotlock is availability maths, holds and reservations, events with recurrence, coverage-aware
free/busy, tenant isolation, iCalendar interchange, MCP and A2A with human confirmation and live
updates, an MCP Apps view, REST with the application API, scoped API keys, a GitHub sign-in
dashboard, maintenance, and clients for five languages. [Hosted Slotlock](docs/hosted/README.md)
runs it for you, or you self-host it. Provider sync (Google, Microsoft, CalDAV), notifications to people, and a human
calendar app are yours to build around it. What each version promises is in
[VERSIONING.md](VERSIONING.md).

Events need a finite duration (all-day events are whole local days; one event may last 3,660 days).
Open-ended entries are refused rather than guessed.

The normative rules are in [SPEC.md](./SPEC.md); tools can read
[`slotlock.manifest.json`](./slotlock.manifest.json) without running package code. Report
vulnerabilities as described in [SECURITY.md](./SECURITY.md). See [CONTRIBUTING.md](./CONTRIBUTING.md)
and [GOVERNANCE.md](./GOVERNANCE.md) for how the project runs.

## License

Apache-2.0. Copyright 2026 TREFT LTD. Dependency notices are in [NOTICE](./NOTICE).
