---
title: Limits
description: The request limits slotlock serve enforces, how it shares a busy server between tenants, what one tenant may store, and how to set them behind a proxy.
sidebar:
  label: Limits
---

`slotlock serve` bounds how fast each caller may call it, how much of the server one tenant may
hold, and how much one tenant may store. `SLOTLOCK_LIMITS` changes the limits, as `name=value`
pairs; `slotlock --help` lists each one's default. Agents' own event quotas are in
[Operations](/docs/operations/), and the hosted service's in [Slotlock Cloud](/docs/hosted/).

## Request limits

The server limits requests per client address (before any key is looked up), per key, per tenant
and for the whole server, and answers `429 rate_limited` with `Retry-After` and the `RateLimit`
fields. The application API counts an admin key's calls in its tenant's own `app_read` and
`app_write` budgets, apart from the agents'; another key's are its own. The health check is not
counted.

## Recurring writes

A recurring create and every event update (a new title re-expands a recurring event's series too)
takes its write token, then waits for a slot: one at a time per tenant (`tenant_series_writes`) and
per server (`series_writes`); each server process counts its own. A freed slot rests for as long as
the server was busy while the write before held it (at most a second), so with one slot, writes
that each hold it under a second keep the server busy at most about half the time. It then goes to
the waiting tenant with the fewest writes in flight and, among those, the one whose writes have kept
the server busy least lately (halving every ten seconds), then to the first to ask.

So a tenant sending one write at a time waits for the write running, its rest, and the other
tenants with one write in flight whose writes kept the server less busy: many such tenants, new
ones included, can each go ahead of it once. Tenants keeping more writes waiting never go ahead of
it. Four more of a tenant's writes may wait and the rest get 429. When the server's 64 places are
all taken, a write from a tenant with fewer writes in flight than the tenant with the most takes
the place of that tenant's last write, which gets 503 `server_busy`; otherwise it gets 503 at once.

An expansion runs on the server's main thread, so any request may also wait for the one running. A
write that has waited two seconds gets 429 while its tenant's own write is still running, otherwise
503 `server_busy`. An application API maintenance run waits the same way for slots of its own: one
per tenant, `maintenance_runs` per server.

## Database connections

One tenant's requests hold at most `tenant_transactions` (2) of the server's 10 database
connections at once and the rest wait their turn, so a tenant's writes waiting on its own locks
leave the others to other tenants and key lookups; a server with one tenant can set
`tenant_transactions=10`. A request whose transaction waits more than 5 seconds for a lock gets 503
`server_busy`.

## More than one server

With more than one server, `SLOTLOCK_SHARED_LIMITS=on` shares the tenant budgets (`tenant_*`,
`app_*`) through the database, so N servers allow a tenant its rate once, not N times; each server
checks its own buckets first, and goes on with them alone if the database cannot be reached.

## Behind a proxy

Behind a proxy, set `SLOTLOCK_TRUSTED_PROXY_HEADER` to the field it puts the client's address in
(`CF-Connecting-IP` behind Cloudflare) before the server takes traffic, or every client shares the
proxy's budget: the server logs a `client_address_field_ignored` warning when such a field arrives
without the setting.

Behind two proxies, such as Cloudflare and then kamal-proxy, name the first one's field: the server
reads the last address of a list field such as `X-Forwarded-For`, which the second proxy writes as
Cloudflare's. A client can send that field itself, so let nothing reach the server except through
the proxy. Where something else can reach it (another container on kamal-proxy's network), also set
`SLOTLOCK_TRUSTED_PROXY_SECRET` and have the proxy set `X-Slotlock-Proxy-Proof` to it on every
request (a Cloudflare request header transform rule): the field is then believed only beside that
exact value, and any other request is counted by its connection's address.

## Usage and monthly quotas

With `SLOTLOCK_USAGE=on` (off by default) the server meters each tenant's use in
`slotlock.usage_daily`, by UTC day, API key and surface: every operation that runs (MCP, A2A,
REST, the application API and the dashboard assistant), counted in memory and recorded every 15
seconds and when the server stops, each batch once however often it is sent; and the bookings
(`reservation.created`, `event.created`, `hold.confirmed`) and holds (`hold.created`) its feed
shows committed, rolled up by maintenance before the feed is pruned, so a write that rolled back
is never counted and maintenance's own changes never are. Counts only, never what was asked; kept
400 days, erased with the tenant. It also counts webhook deliveries endpoints accepted, messages to
the assistant, and each day's resources (a count, archived included). Every answer carries
`Slotlock-Request-Id`; with metering on, one whose operations ran carries
`Slotlock-Usage: operations=<n>`. Read it back with `GET /v1/usage` (an admin key: totals, by day,
by key and by surface), `readSlotlockTenantUsage` (usage.ts), and on the dashboard's Usage page.
Writes from
before the release that created the tables are not counted. The dashboard Worker takes the same
setting for the assistant's operations.

With `SLOTLOCK_QUOTAS=on` too (off by default), a tenant on a hosted plan is held to that plan's
monthly quotas (`SLOTLOCK_PLAN_QUOTAS` in plans.ts; a tenant on no plan, as on a self-hosted
server, has none): past its operations this UTC month every operation is refused but reading its
usage and erasing it, past its bookings only those that can book, with `429 quota_exceeded` and `Retry-After` at the month's end.
Each operation's answer lists the quotas in `RateLimit` and `RateLimit-Policy`
(`"operations_month"`, `"bookings_month"`), and the feed records `usage.threshold_reached` once at
80% and at 100% of each. A server reads the month so far at most every 30 seconds (every 2 near
the stop) and adds its own unrecorded operations, so a tenant can pass its stop by what other
servers counted in the last few seconds; a count it cannot read lets the operation run. The
dashboard Worker takes the same setting for the assistant's operations.

## What a tenant may store

The server also bounds what one tenant may store, whichever key, agent or application writes it:
10,000 holds, and 100,000 each of bookings, calendar events and coverage rows, counted as the
store's `tenantLimits` count them, besides 10,000 resources. A write past one answers 409
`hold_limit_reached`, `reservation_limit_reached`, `event_limit_reached` or
`coverage_limit_reached`; `SLOTLOCK_LIMITS` changes them (`tenant_holds`, `tenant_reservations`,
`tenant_events`, `tenant_coverage`).
