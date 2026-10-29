---
title: Self-hosting
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
refuses a superuser or a role that can bypass row-level security.

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

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `DATABASE_URL` | required | The server role's connection |
| `SLOTLOCK_MIGRATE_DATABASE_URL` | | The owner's connection, for `migrate` |
| `SLOTLOCK_PUBLIC_URL` | `http://localhost:$PORT` | The URL clients use, behind your TLS proxy |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where it listens (`0.0.0.0` in the image) |
| `SLOTLOCK_AUTH_TOKEN` | | A read and write token for `SLOTLOCK_TENANT`; [API keys](/docs/keys/) work with or without it |
| `SLOTLOCK_TENANT` | `default` | The tenant of the token and of the CLI's commands |
| `SLOTLOCK_AVAILABILITY` | none | Default weekly bookable hours, as JSON rules |
| `SLOTLOCK_CONFIRM_WRITES` | `none` | `all`, or a list of write tools that wait for a person ([Security](/docs/security/#confirmation-before-writes)) |
| `SLOTLOCK_CONFIRMATION_SECRET` | | Signs pending confirmations; required unless `SLOTLOCK_CONFIRM_WRITES=none` |
| `SLOTLOCK_REST_API` | `on` | `off` serves MCP and A2A only |
| `SLOTLOCK_LIMITS` | see `--help` | Rate limits and per-tenant storage limits, as `name=value` pairs |
| `SLOTLOCK_TRUSTED_PROXY_HEADER` | | The field your proxy puts the client address in, such as `CF-Connecting-IP` |
| `SLOTLOCK_GITHUB_*`, `SLOTLOCK_SESSION_SECRET`, `SLOTLOCK_DASHBOARD_USERS` | | The [dashboard](/docs/dashboard/) |

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
slotlock resource archive vehicle-42      # no new bookings; what is on it stays
slotlock resource restore vehicle-42
slotlock resource delete vehicle-42       # refused while anything on it is live
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]' --all
slotlock tenant suspend --reason "unpaid" # reads only; needs the owner's URL
slotlock tenant erase --confirm default   # everything, keys included, for good
```

## Upgrade

Run `slotlock migrate` with the new version before starting its server: an older schema makes
`serve` refuse with `schema_outdated`. Each release's upgrade notes are in the
[changelog](/docs/changelog/). Then work through [Operations](/docs/operations/) for maintenance,
retention and the production checklist.
