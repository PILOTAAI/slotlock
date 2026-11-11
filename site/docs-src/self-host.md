---
title: Self-hosting
seoTitle: 'Self-host Slotlock: open-source booking server on PostgreSQL'
description: Run the Slotlock server from the published image or from npm, configure it with environment variables, and check it end to end.
sidebar:
  label: Self-hosting
---

The [Quickstart](/docs/quickstart/) runs Slotlock with Docker Compose from a clone. This page is
for running it anywhere else.

## Two database roles

| Role | Used by | Needs |
| --- | --- | --- |
| Owner | `slotlock migrate`, once per release | Owns the `slotlock` schema |
| Server | `slotlock serve`, all traffic | Owns nothing, `NOSUPERUSER NOBYPASSRLS` |

```sql
CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
```

`migrate` applies the schema as the owner and grants the server role what it needs. `serve`
refuses a superuser or a role that can bypass row-level security, which row-level security does
not confine, and warns (`serving_as_schema_owner`) when its role owns the schema.

## What it serves

| Path | What |
| --- | --- |
| `/mcp` | MCP, with `Authorization: Bearer <SLOTLOCK_AUTH_TOKEN>` or an [API key](/docs/keys/) |
| `/a2a` | A2A 1.0, same token; card at `/.well-known/agent-card.json` |
| `/v1/…` | [REST](/docs/api/): the tools, and the [application API](/docs/reference/#application-api) for admin keys; described at `/openapi.json` |
| `/healthz` | Readiness, including the database |
| `/metrics` | Prometheus metrics, with `Authorization: Bearer <SLOTLOCK_METRICS_TOKEN>`; off without it ([Scaling](/docs/scaling/#observe-it)) |
| `/dashboard` | The [dashboard](/docs/dashboard/), when it is configured |

To serve beyond this machine, put a TLS proxy in front and set `SLOTLOCK_PUBLIC_URL`.

## The published image

`ghcr.io/pilotaai/slotlock:{{version}}` runs `slotlock serve` on `0.0.0.0:8080` as an unprivileged
user, with a health check. Any `slotlock` command runs in it:

```sh
docker run --rm \
  -e DATABASE_URL=postgresql://slotlock_app:…@db:5432/slotlock \
  -e SLOTLOCK_MIGRATE_DATABASE_URL=postgresql://<owner>:…@db:5432/slotlock \
  ghcr.io/pilotaai/slotlock:{{version}} migrate

docker run -d -p 127.0.0.1:8080:8080 \
  -e DATABASE_URL=postgresql://slotlock_app:…@db:5432/slotlock \
  -e SLOTLOCK_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e SLOTLOCK_PUBLIC_URL=https://calendar.example.com \
  ghcr.io/pilotaai/slotlock:{{version}}
```

## Without Docker

```sh
npm install slotlock@{{version}}
DATABASE_URL=… SLOTLOCK_MIGRATE_DATABASE_URL=… npx slotlock migrate
DATABASE_URL=… npx slotlock serve
```

Two URLs: `SLOTLOCK_MIGRATE_DATABASE_URL` is the schema owner's, for `migrate`; `DATABASE_URL` is
the serving role's (`NOSUPERUSER NOBYPASSRLS`, owning nothing), for `serve`. Node.js 22.12+ and
PostgreSQL 16+ with `btree_gist`.

From a clone, build once and run each command as `node dist/cli.js` (a clone does not put
`slotlock` on your `PATH`):

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

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `DATABASE_URL` | required | The server role's connection |
| `SLOTLOCK_MIGRATE_DATABASE_URL` | | The owner's connection, for `migrate` |
| `SLOTLOCK_PUBLIC_URL` | `http://localhost:$PORT` | The URL clients use, behind your TLS proxy |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where it listens (`0.0.0.0` in the image) |
| `SLOTLOCK_AUTH_TOKEN` | | A read and write token for `SLOTLOCK_TENANT`; [API keys](/docs/keys/) work with or without it |
| `SLOTLOCK_TENANT` | `default` | The tenant of the token and of the CLI's commands |
| `SLOTLOCK_AVAILABILITY` | none | Default weekly [bookable hours](/docs/booking-rules/), as JSON rules |
| `SLOTLOCK_CONFIRM_WRITES` | `none` | `all`, or a list of write tools that wait for a person ([Security](/docs/security/#confirmation-before-writes)) |
| `SLOTLOCK_CONFIRMATION_SECRET` | | Signs pending confirmations; required unless `SLOTLOCK_CONFIRM_WRITES=none` |
| `SLOTLOCK_REST_API` | `on` | `off` serves MCP and A2A only |
| `SLOTLOCK_LIMITS` | see `--help` | Rate limits and per-tenant storage [limits](/docs/limits/), as `name=value` pairs |
| `SLOTLOCK_SHARED_LIMITS` | off | `on` shares tenant budgets between servers through the database |
| `SLOTLOCK_TRUSTED_PROXY_HEADER` | | The field your proxy puts the client address in, such as `CF-Connecting-IP` |
| `SLOTLOCK_TRUSTED_PROXY_SECRET` | | A secret your proxy also sets in `X-Slotlock-Proxy-Proof`; with it, the field above is believed only beside that value ([behind a proxy](/docs/limits/#behind-a-proxy)) |
| `SLOTLOCK_METRICS_TOKEN` | | Turns on `/metrics` for this bearer token, 32+ random characters |
| `SLOTLOCK_GITHUB_*`, `SLOTLOCK_SESSION_SECRET`, `SLOTLOCK_DASHBOARD_*`, `SLOTLOCK_ASSISTANT_*` | | The [dashboard](/docs/dashboard/) and its assistant |

`slotlock --help` lists every command and variable, with each limit's default.

## Check it works

```sh
curl https://calendar.example.com/healthz
curl -X POST https://calendar.example.com/mcp \
  -H "Authorization: Bearer $SLOTLOCK_API_KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

From a clone, `node scripts/smoke-deployment.mjs` checks health, discovery, MCP, A2A, holds and
reservations, with `SLOTLOCK_URL` and a short-lived admin key in `SLOTLOCK_ADMIN_KEY`.

## Manage resources and tenants

```sh
slotlock resource add vehicle-42 --timezone Europe/London
slotlock resource archive vehicle-42      # no new bookings, holds or events; history kept
slotlock resource restore vehicle-42
slotlock resource delete vehicle-42       # with its history; refused while anything on it is live
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]' --all
slotlock tenant status
slotlock tenant suspend --reason "unpaid" # reads only; needs the owner's URL
slotlock tenant unsuspend
slotlock tenant erase --confirm default   # everything, keys included, for good
```

- The resource commands take a reference or an id, and act in `SLOTLOCK_TENANT`. Hours and
  booking rules are on [their own page](/docs/booking-rules/).
- A suspended tenant may read and writes nothing; its keys still authenticate, but it gets no new
  key or secret. Only the schema owner suspends or lifts a suspension, so `suspend` and `unsuspend`
  connect as `SLOTLOCK_MIGRATE_DATABASE_URL`'s role when it is set.
- `erase` deletes everything the tenant has, its API keys included, at once and for good;
  `--confirm` must repeat the tenant. A suspension outlives it.

## Upgrade

Run `slotlock migrate` with the new version before starting its server: an older schema makes
`serve` refuse with `schema_outdated`. Each release's upgrade notes are in the
[changelog](/docs/changelog/). Then work through [Operations](/docs/operations/) for maintenance,
retention and the production checklist.
