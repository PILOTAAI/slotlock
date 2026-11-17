---
title: API keys
seoTitle: 'API keys for AI agents: scopes, expiry and revoking | Slotlock'
description: Give each agent a key of its own, limited to what it needs and revocable without a restart.
sidebar:
  label: API keys
---

A key stands in for the server token for one agent or app. Create it on the server, then send it
as a bearer token. On [Slotlock Cloud](/docs/hosted/), create keys in the dashboard at
`https://app.slotlock.pylota.io/dashboard` instead.

## Create a key

```sh
docker compose exec slotlock slotlock key create "Booking agent" | jq -r .key
```

`key create` prints one JSON line with the key's id, prefix and scopes; `.key` is the `slk_…`
secret. It is shown once and Slotlock keeps only its SHA-256, so store it now.

Commands here run inside the Compose service, as above. With npm, run `npx slotlock …`; from a
built clone, `node dist/cli.js …`. The rest of this page writes `slotlock …` for short.

## Use it

```sh
curl http://localhost:8080/v1/resources -H "Authorization: Bearer slk_…"
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer slk_…"
```

## Choose its scopes

| Scope | Allows | Give it to |
| --- | --- | --- |
| `read` | Listing resources, free/busy, the next free slot, reading events | An agent that only answers questions |
| `write` | Creating, changing and cancelling events | An agent that books |
| `admin` | The [application API](/docs/api/): resources, hours, holds, reservations, the tenant | Your own backend, never an agent |

`read` covers the eight tools that only look; `write` covers create, update and delete; `admin`
covers the application API, which no agent needs. A key gets `read` and `write` unless you say
otherwise:

```sh
slotlock key create "Availability bot" --scope read --expires-in-days 90
slotlock key create "Booking site" --scope read,write,admin
slotlock key create "North desk" --locations north --groups night-shift
slotlock key create "Trial agent" --max-holds 3 --requests-per-minute 60 --requires-approval
slotlock key limits <id> --max-held-hours 48
```

## Limit a key

- A key can be limited to part of its tenant: `--locations` (each with every location in it) and
  `--groups`, up to 20 of each, or the dashboard's "Limit to locations or groups" (Developer plan and
  up on a hosted server). It then reaches only those resources, as they are when each call starts,
  and nothing else is there for it: another resource is `resource_not_found`, never `forbidden`, and
  the feed shows it only changes about its resources. The database holds it to that, not the
  server: `withTenant` sets the key's resources for the transaction and a restrictive row-level
  security policy (`resource_scope_v1`) on every table keyed by resource narrows each read and
  write to them. A limited key reads and writes only (no `admin`), and keeps its limit for good.
- A key can be held below the server's limits, never above them: `--max-holds` (its live holds,
  under `holder_holds`), `--max-held-hours` (under `holder_held_hours`), `--requests-per-minute`
  (reads and writes alike, beside the server's per-key rates; a refusal names `key_limit`) and
  `--requires-approval` (every booking it makes waits for a person, as an
  [approval policy](/docs/tools/#alternatives-dry-runs-and-approvals) named `api-key` would hold it). `slotlock key limits <id>`
  replaces them, and none at all gives the key the server's again; the dashboard's key form and
  "Limits" do the same, and so does the partner API's `limits` for an account's key. They apply
  from the key's next request and are kept through rotation. A role granted before them
  authenticates keys without their limits until `grantApplicationRole` (`slotlock migrate`) runs.

## Rotate and revoke

```sh
slotlock key list            # one JSON object per key, never the secret
slotlock key rotate <id>     # a new secret; the id, scopes and bookings stay
slotlock key revoke <id>     # stops working on its next request
```

## Limits

- 100 active keys per tenant.
- A key may expire after 1 to 3,650 days (`--expires-in-days`); without it, it never expires.
- A key acts in the tenant it was created in (`SLOTLOCK_TENANT`), so one server can serve many
  tenants.
- The last six characters are a checksum, so secret scanners can recognise a leaked key offline.

## Test environments

- Every tenant has a test environment, `<tenant>~test`: a tenant of its own (its own resources,
  keys, webhooks and history), on its live tenant's plan limits and quotas and never billed. Its
  keys start `slk_test_`, and only its keys do (the database holds that). Make one with
  `SLOTLOCK_TENANT=<tenant>~test slotlock key create …` or the dashboard's Live/Test switch. It is
  suspended with its live tenant and erased with it, and a server that refuses a person's keys
  refuses their test keys too.
- A test environment is a sandbox to try an agent against (`SLOTLOCK_TENANT=<tenant>~test`, a
  `slk_test_` key, or the dashboard's Test overview). `slotlock sandbox seed car-rental` (or
  `clinic`, `desks`) fills an empty one with locations, groups, resources with profiles, hours,
  booking rules, pools, a composite and three bookings tomorrow. `slotlock sandbox race car-1
  --agents 100` races that many agents for one hour on a resource and prints who booked, who was
  refused and why, and how long the answers took. `slotlock sandbox fast-forward 60` makes the
  holds, waitlist offers and approvals that would lapse within an hour lapse now and runs
  maintenance, so an agent's handling of a lapsed hold or an expired approval can be tried
  without waiting; bookings and events keep their times. `slotlock sandbox reset` empties it,
  keeping its keys, webhooks and plan. The same are `POST /v1/sandbox/seed`, `/race`,
  `/fast-forward` and `/reset` for an admin test key. Each refuses a live tenant
  (`sandbox_test_only`), and so does the database's reset. On `slotlock serve`, a race takes a write
  token for each agent and runs one at a time with the environment's fast-forwards and maintenance
  runs ([Limits](/docs/limits/)), and it ends with its request: when the client leaves or the
  request times out, the agents still waiting never run and the race answers 503
  `request_aborted`.

## Partner accounts

A platform that resells Slotlock to its own users (a partner) runs a Slotlock tenant for each of
them, `partner:<partner>:<account>`, and pays the deployment for them:

```sh
# As the schema owner (SLOTLOCK_MIGRATE_DATABASE_URL): the partner, its contract and its key.
slotlock partner create stackapi "stackapi.app" --contract @stackapi-contract.json
slotlock partner key stackapi "Main"
slotlock partner list
slotlock partner suspend stackapi        # every account with it; its keys stop
```

- A contract names the plans its accounts may be on (`plans`: each with `resources`, `api_keys`,
  `webhook_endpoints`, monthly `operations` and `bookings`, and `stop_percent`), the scopes their
  keys may carry (`key_scopes`, `read` and `write` unless it says) and the partner's prices
  (`pricing`, for its monthly invoice).
- A partner key (`slk_partner_…`, stored as a SHA-256 like any key) carries the `partner` scope,
  which reaches the partner API under `/v1/partner` and nothing else: no calendar data and no
  tenant's tools. No tenant key reaches the partner API.
- With it the partner creates an account and puts it on a contract plan (`PUT
  /v1/partner/accounts/{account}`: the account's limits and quotas are that plan's), lists and
  reads them, makes, rotates and revokes their keys (`/v1/partner/accounts/{account}/keys`, shown
  once, scopes capped by the contract), suspends one and lifts its own suspension (never one the
  deployment made, before the partner's or after: the deployment's takes the partner's over),
  erases one that is not suspended (`403 tenant_suspended`; a suspension the deployment made keeps
  the data for it), and reads their usage (`GET /v1/partner/usage`, the counts the partner is
  invoiced from). Another partner's accounts are not there for it.
- An account is an ordinary tenant: forced row-level security keeps each from every other, and its
  keys work over MCP, A2A and REST as any key. A suspended account's keys stop authenticating until
  the suspension is lifted, whoever made it, and a suspended partner suspends all its accounts.
- A partner that cannot keep a key per account may act for one with its own key and a
  `Slotlock-Account: <account>` field, where its contract says `"act_on_behalf": true`: the
  request then runs as that account, with the contract's key scopes, and never reaches the partner
  API. An account it does not have, a contract without it, or the field with any other credential
  is refused (401).

Each month is closed once it has ended, by the schema owner (the 1st is a good day):

```sh
slotlock partner customer stackapi cus_…                 # the Stripe customer it is billed as
slotlock partner webhook stackapi https://stackapi.app/hooks/slotlock   # prints the signing secret once
STRIPE_SECRET_KEY=sk_live_… slotlock partner close stackapi              # last month; or --month 2026-10
```

- `partner close` reads the month's usage of every account, prices it with the contract (active
  accounts, each account's operations and bookings above its plan's quota, the minimum's
  shortfall) and records those lines in `slotlock.partner_invoices`. The first run freezes the month
  (`slotlock.partner_month_closes`): every later run uses the same totals and lines, whatever
  arrived or changed since. An account erased before its month is closed is still billed: erasure
  keeps what it used in unclosed months (`slotlock.partner_erased_usage`, by the partner's account
  name only).
- It then sends the partner `usage.period_closed`, signed as any Slotlock webhook (`webhook-id`,
  `webhook-timestamp`, `webhook-signature`): each account's totals by metric, the lines, and a
  SHA-256 of both, so the two sides can check they hold the same numbers. Every run sends the same
  body under the same id until the endpoint answers 2xx; after that, none.
- With `STRIPE_SECRET_KEY`, each line Stripe has not taken becomes an invoice item on the partner's
  next invoice, and its id is kept. An item Stripe made in a run that stopped before recording it
  is found by its metadata and adopted, never made twice. It exits 1 while a line waits or the
  webhook was not taken: run it again for the same month.
- A partner checks its counts against Slotlock's each day with `POST /v1/partner/usage/reconcile`
  (one ended UTC day, each account's operations and, if it keeps them, bookings): the answer gives
  both counts and the difference, and a day off by more than 0.5% for any account is recorded
  (`slotlock.partner_reconciliations`) as an incident on our side.
- `slotlock billing daily`, run once a day by the schema owner (cron), does the rest: it closes
  last month for every active partner once the month has been over for 6 hours, reports overage
  when `SLOTLOCK_OVERAGE` is on, and lists the last week's reconciliation mismatches, exiting 1
  when anything waits or differs. For example, `15 7 * * * slotlock billing daily` with
  `SLOTLOCK_MIGRATE_DATABASE_URL` and `STRIPE_SECRET_KEY` set. Each run, and each `slotlock overage
  report`, is recorded (`slotlock.maintenance_runs`, the newest 400 of each) with what it printed,
  for the admin console.
- `/metrics` counts authenticated requests by the integrator their `Slotlock-Client` field names
  (`slotlock_requests_by_client_total`): the names in `SLOTLOCK_KNOWN_CLIENTS`, else `other`, or
  `none` without the field.

Would you rather people made their own keys? Turn on the [dashboard](/docs/dashboard/).
