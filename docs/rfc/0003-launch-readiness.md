# RFC 0003: Launch readiness: the assistant on Slotlock Cloud, grouped resources, partner access and metered usage

| | |
| --- | --- |
| Status | Proposed |
| Target | PR #161 follow-ups before 9 December 2026, then 0.7.0 (launch) and 0.8.0 (partners) |
| Builds on | PR #161 (hosted plans and Stripe billing), RFC 0002 |
| Decision | GOVERNANCE.md: adds tables, an authorization surface (partner keys, key scopes) and billing; needs the maintainer's approval, and an independent security review for every PR marked T2 below |

## Summary

Three questions came up while preparing Slotlock Cloud for launch. This RFC answers each from the
code at `a54136b` (main) and `23136fa` (PR #161), outlines the plans already written, and lists the
work left, one PR per line, with its tier and release.

1. **"Cloud has a built-in chat assistant with bring-your-own model, but I cannot find it."** The
   assistant is built and tested (`src/assistant.ts`, the dashboard's Assistant page and Settings →
   Assistant). It is off unless the deployment sets `SLOTLOCK_ASSISTANT_SECRET`, and the Cloud
   dashboard Worker does not set it, so neither the **Assistant** sidebar item nor the Settings panel
   is drawn. The landing page advertises the assistant anyway, because the site decides from the
   source code, not from what Cloud runs. Turning it on is one secret; making it safe to keep on
   needs secret rotation and two docs changes.
2. **"What are resources attached to, and can they be grouped?"** A resource belongs to exactly one
   tenant and, at most, to one pool. It has no name, kind, capacity, labels, location or group, and
   an API key reaches every resource in its tenant. Pools mean "interchangeable, book any one"; they
   are not a way to organize. This RFC adds a resource profile, locations (a tree), groups (many to
   many), search by those, and later key scopes, composite resources and test environments.
3. **"Can stackapi.app consume Slotlock and let its users use it through the Slotlock API, with
   pricing and usage tracked end to end?"** Yes, in two shapes. Today, with no code, a stackapi user
   can bring their own Slotlock key. For stackapi to resell Slotlock under its own billing, Slotlock
   needs partner accounts that provision a tenant per stackapi user, and a usage meter it does not
   have yet: today nothing counts use per tenant, by design. The meter is the same one the Free and
   Developer plans need, so it is built once.

PR #161 is sound and should merge, but eight findings below (one about enforcement, one about
erasure and billing, one about duplicate charges) should be fixed before 9 December 2026, the date
its Terms give existing accounts.

## Where the existing plans stand

### RFC 0001 (deploy anywhere)

Still *Proposed*. The local spike passed (`spikes/hyperdrive`, results in the RFC); the run against
real Hyperdrive has not been done, so PRs 2–6 (maintenance lease, `workers/server`, `slotlock
deploy cloudflare`, `slotlock deploy vps`, docs) have not started. Maintenance still uses a
per-tenant advisory lock (`src/maintenance.ts`). Nothing in this RFC depends on it. Cloud runs the
API as `slotlock serve` on OVHcloud and the dashboard as the Worker in `workers/dashboard`.

### RFC 0002 (world class)

| Part | State |
| --- | --- |
| P0-1 to P0-3, P1-11 (correctness and security fixes) | Delivered, 0.3.1 |
| P1-1 agent holds, P1-2 bundles and any-N, P1-4 booking rules, P1-7 time zone changes, P1-9 problem details and `Idempotency-Key`, P1-10 shared limits | Delivered, 0.4.0 to 0.5.x |
| P1-3 pools, P1-5 outbox and webhooks, P1-6 history, P1-8 feed health | Delivered, 0.5.0 to 0.6.0 |
| P2-1 benchmarks, P2-4 interop (VAVAILABILITY, JSCalendar), P2-8 waitlists and no-show release | Delivered (`bench/`, `src/interop.ts`, waitlist and check-in) |
| P2-5 operations | Partly: `traceparent` ids are read and logged, `/metrics` exists, status issues are raised by `scripts/status-probe.sh`; no OpenTelemetry export, no published SLOs |
| P2-2 partitioning, P2-3 home region, P2-6 solver guide, P2-7 SOC 2, DPA, SSO, SCIM | Not started |

Open question 2 of RFC 0002 (round robin or least-used order in pools) is still open; it matters
wherever members of a pool should share the work (vans that wear, rooms that need cleaning,
clinicians who should see as many patients as each other). It is listed again below.

### PR #161 (hosted plans and Stripe billing)

What it does: a `slotlock.tenant_plans` table read and set through definer functions; Free (10
resources, 10 active keys, 2 webhook endpoints) and Developer (100, 100, 10; $10 a month or $100 a
year); each cap is the lower of the plan's and the server's, and the key cap is checked inside
`create_api_key`, so it holds under concurrent creates; a Plan page with Upgrade (Stripe Checkout
with Managed Payments) and Manage billing (the customer portal); a signed webhook that reads the
subscription back from Stripe rather than trusting the event, and never lets a late event about an
old subscription end a newer one; Terms and privacy wording; existing accounts move to Free on 9
December 2026.

Findings, each checked against the branch. All eight are fixed on
`claude/inspiring-dijkstra-bfvqif`, which merges PR #161's branch: finding 8 with the proposed
quota numbers, which apply from 10 December 2026 (open question 3 can still change them before then).

1. **Free is enforced only where the dashboard is used.** A tenant with no plan row keeps the
   server's limits. The Worker puts such a tenant on Free only when, after `SLOTLOCK_FREE_PLAN_FROM`,
   it posts to `/keys`, `/resources` or `/webhooks` in the dashboard (`workers/dashboard/worker.ts`,
   `billing.plan`). A tenant that adds resources through `POST /v1/resources` or endpoints through
   `POST /v1/webhooks` on `slotlock serve` never meets that code, and keeps 10,000 resources and 10
   endpoints. Accounts created between the deploy and 9 December also get the old limits, though the
   Terms say Free applies at once to accounts created from 9 November (that date should be the
   deploy date). *Fix:* a deployment default in the database
   (`slotlock.plan_defaults`: plan, from), which `slotlock.tenant_plan()` returns for a tenant with
   no row once `from` has passed, so both servers enforce the same plan; and a Free row written at
   the first sign-in of a new tenant.
2. **The dashboard still shows the old caps.** The Resources page says "*n* of 100"
   (`SLOTLOCK_DASHBOARD_MAX_RESOURCES`) on Free. *Fix:* show the plan's limit wherever a count is
   shown, and refuse in the form before the store does.
3. **The Plan page undercounts resources.** The cap counts archived resources ("archived ones
   included", `src/plans.ts`), but the page counts `options.resources.list()`, which leaves archived
   ones out and stops at 101. A Free tenant with 7 archived and 3 in use sees "3 of 10" and is
   refused at the next add. *Fix:* a count from the store that includes archived resources, and one
   line saying archived resources count until deleted.
4. **Two tabs can buy two subscriptions, and cancelling one can drop the plan.** Upgrade checks the
   stored plan, which changes only when the webhook arrives, so two Checkouts started before then
   both charge. The plan row then names whichever subscription's webhook came last; cancelling that
   one puts the tenant on Free while the other still renews. *Fix:* before creating a Checkout for a
   known customer, list its subscriptions with status `active`, `trialing` or `past_due` and refuse
   if one exists; when a subscription ends, look for another live one of the same tenant before
   setting Free; log a second live subscription as `slotlock billing duplicate subscription` for
   the owner to refund.
5. **Erasure does not touch Stripe.** `erase_tenant` deletes the plan row, but the subscription
   keeps renewing and the customer keeps its tenant metadata. The privacy notice in the PR says "A
   Developer plan is cancelled before the account is erased"; nothing enforces it. *Fix:* `slotlock
   tenant erase` and `/v1/tenant/erase` refuse with `billing_active` while the plan row names a
   live subscription, and the erasure runbook cancels it in Stripe first.
6. **A personal address is the default contact.** `readBilling` defaults `SLOTLOCK_PLAN_CONTACT` to
   a personal Gmail address, which is then published in the page and in this public repository.
   *Fix:* require the setting (or default to `mailto:support@pylota.io`) and remove the address.
7. **Managed Payments needs three things the PR does not set.** The parameter is right: Stripe
   documents `managed_payments[enabled]=true` on the Checkout Session, Managed Payments has been
   generally available since 22 April 2026, and the United Kingdom is an eligible seller country.
   But it must also be activated in the Stripe Dashboard (accepting its terms), every product needs
   an eligible tax code (SaaS for business use is `txcd_10103001`), and the request needs API
   version `2025-03-31.basil` or later, while the PR sends `Stripe-Version` only when
   `STRIPE_API_VERSION` is set and otherwise uses the account's default. *Fix:* pin
   `STRIPE_API_VERSION` to a current version (the PR already reads `current_period_end` from both
   places it has lived), set the tax code, and run one live Checkout and cancellation before 9
   December. The PR's Checkout uses none of the parameters Managed Payments forbids
   (`automatic_tax`, `tax_id_collection`, `payment_method_types`, shipping, Connect).
8. **There is no usage limit.** A Free tenant is bounded only by rate limits: `tenant_read` is 20
   a second, about 52 million reads a month. The plans need a monthly quota, and the Terms need to
   name it now, because they promise 30 days' notice of any lower limit. *Fix:* put the quotas of
   [Pricing](#pricing-and-plans-after-this-rfc) into the plans table in PR #161 before it merges,
   so the one notice covers them, and enforce them with [the meter](#3-usage-metering).

Also true, and fine for launch: Plans exist only on the Worker dashboard (`slotlock serve`'s own
dashboard has no billing, which is right for self-hosting); Cloud serves `github-org:` tenants
only when listed in `SLOTLOCK_DASHBOARD_ORGS`, so "organization owners" on the Plan page are, on
Cloud, people on their personal tenants (see [Teams on Cloud](#later)).

## 1. The chat assistant on Slotlock Cloud

### What exists

- **Bring your own model.** An owner connects the organization's model in Settings → Assistant:
  Anthropic's Messages API, or any OpenAI-compatible chat completions API (OpenAI, OpenRouter,
  vLLM, Ollama, LM Studio, and others behind a public URL). The key is sealed with AES-256-GCM under
  a key derived from `SLOTLOCK_ASSISTANT_SECRET`, bound to the tenant, and shown only by its last
  four characters (`src/assistant.ts`).
- **Reads run, writes wait.** Seven read operations run at once; seven writes become cards a member
  approves, run once under the same booking rules and limits as an agent, and are recorded as
  "Assistant for @login" (`SLOTLOCK_ASSISTANT_TOOL_USE`). Keys, webhooks, rules, pools and erasure
  are never offered.
- **Bounds.** 8 model calls a message, 10 messages a minute per member, 4 pending changes,
  conversations kept 2 hours; model URLs on loopback, private and metadata addresses, and the
  deployment's own hosts, are refused (#157).
- **Covered already:** the privacy notice ("if the dashboard offers the assistant", PRIVACY.md) and
  the Terms (TERMS.md, "your own AI provider key").

### Why Cloud does not show it

- `createSlotlockDashboard` draws the **Assistant** nav item only when `options.assistant` is set
  (`src/dashboard.ts`, the nav list), and Settings draws the Assistant panel only then.
- The Worker sets `options.assistant` only when `SLOTLOCK_ASSISTANT_SECRET` is a secret of the
  Worker (`workers/dashboard/worker.ts`, `config.assistantSecret`). It is marked optional in
  `wrangler.jsonc`, and Cloud's Worker does not have it: the Cloud sidebar has no such item.
- The landing page shows "Operate it by chat" whenever the source mentions the secret
  (`site/scripts/sync-content.mjs`, `assistant: selfHost.includes("'SLOTLOCK_ASSISTANT_SECRET'")`),
  so it promises the feature to Cloud visitors whether or not Cloud runs it. The hosted page
  (`docs/hosted/README.md`) does not mention it at all.

### Plan

A2, A3, A4 and A5 are done on `claude/inspiring-dijkstra-bfvqif` (A2 is T2 and needs its
independent review); A1 waits on the owner, who holds the Cloudflare credentials (this repository
holds none, by design). A4 is built as below: **Load models** checks the URL as saving does, sends
the saved key only to the provider and URL it was saved for (a key typed in the form otherwise),
never follows a redirect, saves nothing, and counts as one of the member's assistant messages
against its rate.

| # | Change | Tier |
| --- | --- | --- |
| A1 | **Owner:** `openssl rand -hex 32`, then `npx wrangler secret put SLOTLOCK_ASSISTANT_SECRET` on the Cloud Worker, keep the value in the password manager, redeploy, and check that Assistant appears in the sidebar and Settings → Assistant offers the form. Losing the value makes every saved model key unopenable (owners must enter them again); A2 makes changing it safe. | Ops |
| A2 | `SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS`: keys sealed under an earlier secret still open, and are sealed again under the current one the next time they are used. The secret must still differ from every other secret. | T2 |
| A3 | `docs/hosted/README.md` gains an Assistant row: on, bring your own model, what is sent to the provider, that a model on your own machine is not reachable from Cloud (use a hosted provider or a public HTTPS URL). The site's assistant section is shown for Cloud only when the hosted page says so, and `release-hosted-docs` pins the two together. | T0 |
| A4 | Provider presets in Settings: Anthropic, OpenAI, OpenRouter, Google (its OpenAI-compatible endpoint), Mistral, Groq, Together, and Custom, each filling the base URL; **Load models** lists the provider's models (`GET /v1/models`) for the Model field. No JavaScript: a preset is a submit button that fills the form. | T1 |
| A5 | Agent operations the assistant runs count in the usage meter (part 3) as `origin = dashboard-assistant`, so a busy organization's assistant is bounded by its plan's quota as an agent is. The assistant itself is on every plan: the model and its cost are the customer's. | T1 |

Worker budget: a message makes at most 8 model calls (30 s each, 90 s a turn) and at most 24 agent
operations (`SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST`). A paid Worker allows 10,000 subrequests and
30 s of CPU per request by default, and sets no limit on the duration of an HTTP request while the
client stays connected; the turn's time is spent waiting on the model, not on CPU. Nothing needs
raising.

## 2. What a resource is attached to, and grouping

### Today, from the schema

`slotlock.resources` (`src/ddl.ts`) has: `id`, `tenant_ref`, `external_ref` (unique in the tenant),
`timezone`, `availability_rules`, `booking_rules`, `pool_ref`, `visibility` (`shared` or
`private`, fixed at creation), `archived_at`, `check_in_since` and `created_at`.

| Attached to a resource | Attached to the tenant |
| --- | --- |
| Reservations and holds (and hold groups), events and their occurrences (each owned by the key or agent that wrote it), coverage per external source, waitlist entries, history | API keys (tenant and scopes only), webhook endpoints (filtered by event type only), booking-rule defaults (tenant-wide and per pool), assistant settings, the plan |

- **A tenant is the only container.** On Cloud it is a person (`github:<id>`), or an organization
  listed in `SLOTLOCK_DASHBOARD_ORGS` (`github-org:<id>`). Forced row-level security isolates it.
- **A pool is the only grouping**, and it is booking semantics: one pool per resource, flat, used
  by `slotlock_book_pool` (take any free member), pool availability (how many are free), pool rule
  defaults and pool waitlists.
- **Missing:** a display name (agents and the dashboard show `external_ref`), description, kind,
  capacity, attributes, labels, a location or site, many-to-many groups, a parent made of children
  (a divisible hall), API keys limited to some resources, webhooks for some resources, and a test
  environment beside live.
- **Search takes ids.** `free-busy` and `next-available` take up to 100 `resource_ids`,
  `available-slots` up to 20. "A physiotherapist free at the Leeds clinic on Tuesday", "a room for
  ten with video on floor 3" or "an electric van at Heathrow tomorrow" is each a list call, a
  filter in the agent, then a search.

### What the use cases need

Slotlock is not a fleet product. SPEC.md says "Vehicles, rooms, machines, and people are all
resources; no semantic rule assumes a particular industry", and the site says "Each car, room,
person and machine is its own calendar", with a van, a meeting room, a clinician and a machine in
its demo. Grouping has to serve all four equally, and the organizations around them, so no case
below comes first and no field is named after one industry.

| Resources | Groups they need | Edge cases |
| --- | --- | --- |
| People (clinicians, tutors, consultants, technicians, support staff) | Team or department → site; skills or services as labels | One person at different sites on different days; an appointment that needs a person, a room and a device together; spreading bookings fairly across a team |
| Rooms, desks and spaces (meeting rooms, studios, courts, hot desks) | Building → floor → zone; capacity; features (video, whiteboard) | A divisible hall: booking the hall blocks its parts and booking a part blocks the hall; desks booked by zone |
| Vehicles (rental cars, vans, delivery and service fleets) | Class (an ACRISS code such as `CDMR`) → branch → region; attributes (electric, seats, transmission, accessible) | Book by class at a branch; a one-way hire ends the vehicle somewhere else (its location changes over time); a vehicle with a driver (two resources, one booking); maintenance blocks |
| Machines and equipment (lab instruments, 3D printers, tools, hire stock) | Item → product → kit; site | 50 identical chairs (quantity, not identity); kits made of items; a machine that needs an operator |
| Sessions with seats (classes, tours, events) | Session → seats | Capacity per slot; a group taking several seats at once |
| Agencies, franchises and platforms | Customer → their resources | Each customer isolated, billed and supported separately: a tenant each (part 4) |
| Teams inside one customer | Site or team → its resources | Staff and keys that see only their own site |

### Design

Three concepts, kept apart because they mean different things:

- **Pool** (unchanged): interchangeable members, booked as a class. One per resource.
- **Location**: where a resource is. A tree, one per resource, used for search and scoping.
- **Group**: any set a tenant wants (a team, a department, a contract, "Saturday clinic", "airport
  vans"). Many per resource, no booking semantics.

**G1. Resource profile (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, as below, except
that the dashboard edits name, description, kind, capacity and labels while attributes are set over
the API. Columns on `slotlock.resources`, each
optional:

| Field | Bound | Use |
| --- | --- | --- |
| `name` | 1–200 characters | Shown to agents and people instead of the reference |
| `description` | ≤ 2,000 characters | Shown in the dashboard and on `slotlock_list_resources` (truncated to 500) |
| `kind` | `person`, `room`, `desk`, `space`, `vehicle`, `machine`, `equipment`, `service`, `other` (default) | Filtering; icons in the dashboard. A hint, never a rule: no booking behaves differently by kind, as SPEC.md requires |
| `capacity` | 1–100,000 | People or seats it holds; informational, never enforced as concurrent bookings |
| `labels` | ≤ 20, each `^[a-z0-9][a-z0-9._-]{0,63}$` | Filtering (`ev`, `wheelchair`, `projector`), GIN-indexed |
| `attributes` | JSON object, ≤ 50 keys, ≤ 4 KiB, string, number or boolean values | Data the integrator wants back (a staff number, an asset tag, a plate, a room's floor plan link) |

- `POST /v1/resources` accepts them; `PATCH /v1/resources/{id}` changes them; the dashboard's
  resource page edits them.
- `slotlock_list_resources` returns `name`, `kind`, `capacity`, `labels`, `location`, `groups`, and
  filters by `kind`, `label` (all of them), `location` and `group`.
- The outbox and history record **which** profile fields changed, never their values: the feed's
  rule is "ids, times and states, never titles", and a name may name a person.
- The privacy notice lists resource names and descriptions under calendar content.

**G2. Locations (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, as below; `POST
/v1/locations` creates or updates by reference, and the dashboard's Locations and groups page edits
them, and a resource's page sets its location. `slotlock.locations (tenant_ref, ref, name, parent_ref, timezone)`, forced
RLS like every tenant table; depth at most 5 (region, site, building, floor, zone); 1,000 per
tenant; deleting one is refused while a resource or child uses it. A resource has at most one
`location_ref`; a new resource takes its location's time zone when none is given. API:
`GET/POST /v1/locations`, `PATCH` and `DELETE /v1/locations/{ref}`. A location filter includes the
locations below it.

**G3. Groups (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, as below, with `DELETE
/v1/groups/{ref}` too. A resource joining or leaving a group (its deletion included) is a
`resource.updated` on the feed with its `groups` before and after. The dashboard's Locations and
groups page edits groups, and a resource's page sets its groups. `slotlock.resource_groups (tenant_ref, ref, name, description)` and
`slotlock.resource_group_members (tenant_ref, group_ref, resource_id)`; 500 groups a tenant, 20
groups a resource. API: `GET/POST /v1/groups`, `PUT` and `DELETE
/v1/groups/{ref}/members/{resource_id}`. Pools stay as they are; a pool is not a group.

**G4. Search by selection (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, with the
selection as top-level fields (`location`, `group`, `labels`, `kind`, `pool`) rather than a `select`
object, as a GET query string carries them, and resolved by the backend's `selectResources` as the
call starts rather than in the search's own transaction, so a backend that only searches named
resources works unchanged; `selection_empty` answers a selection that matches none. `free-busy`, `next-available`, `available-slots` and their tools
accept a `select` of `location`, `group`, `labels`, `kind` and `pool` in place of `resource_ids`.
It resolves inside the same transaction, in a stable order, to at most the operation's limit (100,
or 20 for slots), and is refused with `selection_too_large` beyond it, so a search is never silently
partial. The answer names the resources it covered.

**G5. Webhook filters (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, as below, set
when the endpoint is created (there is no route to change an endpoint) and shown on the dashboard;
with any filter, changes about no resource are not sent. An endpoint may also filter by `resource_ids`, `pools`, `locations`
or `groups`, matched when the change is delivered (the outbox row has the resource id).

**G6. Keys limited to part of a tenant (T2, 0.8.0).** Status: built on
`claude/inspiring-dijkstra-bfvqif`, as below, with the key's resources worked out when each
transaction starts (`slotlock.resource_scope`, a uuid[]), a restrictive `resource_scope_v1` policy on
each table keyed by resource or by event, limited keys read and write only, set when the key is made
(`slotlock key create --locations --groups`, or the dashboard on Developer). An API key may carry a scope of locations
and groups. It is enforced in the database: a restrictive RLS policy on resources and on every table
keyed by resource compares the row's resource with a transaction-local setting that `withTenant`
sets from the key, so a scoped key cannot read or write outside its scope through any code path. A
resource outside the scope answers `resource_not_found`, never `forbidden`, so a scoped key learns
nothing about the rest.

**G7. Pool order (T1).** Status: built on `claude/inspiring-dijkstra-bfvqif`, as below, set with
`PUT /v1/pools/{pool}/order` and read in `GET /v1/pools`; `least_booked` counts confirmed bookings
made in the last 30 days, and `round_robin` starts after the member it last booked, both by id after
that. `slotlock_book_pool` tries members in a stable order today. Add a pool
setting, `order`: `stable` (today), `least_booked` (fewest bookings in the last 30 days first) or
`round_robin`, to share bookings across a pool's members: vans, rooms or a team of people (RFC 0002
open question 2).

**G8. Composite resources (T2, later).** A parent made of children (a hall of three rooms), one
level deep. Each occupancy row gains a span, an `int4range` over the parent's children: a booking of
the whole parent writes one row on the parent spanning all of them; a booking of child *i* writes its
own row and a row on the parent spanning `[i, i+1)`. The exclusion constraint becomes
`EXCLUDE (resource_id WITH =, during WITH &&, span WITH &&)`: the whole conflicts with every part,
two different parts never conflict, and the guarantee is still PostgreSQL's. A child's free/busy
adds the parent's rows whose span covers it. Existing rows get the full span, so nothing changes for
a resource without children.

**G9. Test environments (T2, later).** A `slk_test_` key acts in `<tenant>~test`, a tenant of its
own with the same plan limits and no billing; the dashboard switches between Live and Test.
`slotlockServeAllowsTenant` must learn the suffix: today it lets through any reference that is not
`github:<id>` or `github-org:<id>`, whatever `SLOTLOCK_DASHBOARD_USERS` says, so a removed person's
`github:<id>~test` would keep working.

Quantity (50 chairs) stays a pool of 50 members, created at once by `slotlock resource add
--count 50 --pool chair`; a seat counter cannot be expressed as an exclusion constraint, and this
RFC does not weaken the guarantee to get one.

## 3. Usage metering

Nothing counts use per tenant today, by design: `/metrics` labels come from closed sets and never
name a tenant or key (`src/metrics.ts`), and the API logs record "each call's operation and
outcome, never its arguments or who made it" (PRIVACY.md). Plans, partner billing and stackapi's
reconciliation all need per-tenant counts, so one meter serves all three.

### What is counted

Status: every metric below, `GET /v1/usage`, the Plan page's usage, `Slotlock-Request-Id` and
`Slotlock-Usage` are built on `claude/inspiring-dijkstra-bfvqif`, off unless `SLOTLOCK_USAGE=on` (a
self-hoster may not want per-tenant counts kept; Cloud sets it). Quotas are built too, off unless
`SLOTLOCK_QUOTAS=on` (which needs `SLOTLOCK_USAGE=on`): see [Enforcement](#enforcement).

| Metric | One unit is | Counted from | Exact? |
| --- | --- | --- | --- |
| `operations` | A named operation that reached the backend (REST, the application API, an MCP `tools/call`, an A2A message, an approved or read assistant call), whatever it then returned. Protocol messages (`initialize`, `tools/list`), and calls refused before they run (401, 400 arguments, 403, 413, 429, a declined confirmation), are not counted | The server, in memory, recorded every 15 s and on shutdown | At most 15 s lost on a crash; never counted twice |
| `bookings` | A committed `reservation.created`, `event.created` (a recurring series is one) or `hold.confirmed` (a bundle of five resources is five) | The outbox, in the transaction that wrote it | Exact |
| `holds` | A committed `hold.created` | The outbox | Exact |
| `webhook_deliveries` | A delivery the endpoint accepted | The webhook pass | Exact |
| `resources` | Resources at the end of each day, archived included | A daily count | Exact |
| `assistant_messages` | A member's message to the assistant | The dashboard Worker, in the request | Exact |

Maintenance's own changes (expiry, no-show release) are `origin = maintenance` and never counted.

### How it is counted, end to end

```text
request ─▶ authenticate (tenant, key, partner) ─▶ Slotlock-Request-Id ─▶ quota check ─▶ operation
                                                                                     │
                 ┌───────────────────────────────────────────────────────────────────┤
                 ▼                                                                   ▼
   in-memory delta (operations)                                  outbox row (in the same transaction)
                 │ every 15 s                                                         │ every minute
                 ▼                                                                   ▼
   slotlock.record_usage(flush_id, rows) ──────▶ slotlock.usage_daily ◀────── outbox rollup (cursor)
                                                        │
          ┌────────────────────┬────────────────────────┼───────────────────────┬──────────────────┐
          ▼                    ▼                        ▼                       ▼                  ▼
   quota cache (30 s)   Plan page and          partner usage API       partner invoice       threshold
   in every server      GET /v1/usage          and period webhook      (monthly, once)       webhooks
```

- **Tables (owner only, read through definer functions, erased with the tenant):**
  `slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)`, primary key on all but
  `count`; `slotlock.usage_flushes (flush_id, at)`, kept 7 days; `slotlock.usage_cursor
  (txid, id)` for the outbox rollup.
- **Operations** are added to a per-process map keyed by (tenant, key, origin) at the point where
  `consumeRateLimit` already runs for every named operation (`src/self-host.ts`), and flushed by
  `slotlock.record_usage(flush_id, rows)`, which inserts the flush id and adds the counts in one
  transaction. A flush whose answer was lost is retried with the same id and adds nothing, so a
  count is never doubled. On shutdown the server flushes before it exits.
- **Writes** are rolled up from `slotlock.outbox` by maintenance, which already reads it in
  committed order with `(txid, id)` and the snapshot's `xmin`: each pass adds the counts and moves
  the cursor in one transaction, well inside the outbox's retention. No write path changes, and a
  write that rolled back is never counted.
- **The Worker** (assistant and dashboard operations) adds its counts with one
  `slotlock.record_usage` call per request in `ctx.waitUntil`, with a flush id per request.
- **Every response** carries `Slotlock-Request-Id` (a UUID, also logged with the outcome) and, for
  a counted call, `Slotlock-Usage: operations=1` (and `bookings=n` for a write), so a gateway can
  count on its side and compare.

### Enforcement

Status: built (`src/quotas.ts`, with the numbers of [Pricing](#pricing-and-plans-after-this-rfc)),
with these differences from the design below:

- The quotas are the plan's (`SLOTLOCK_PLAN_QUOTAS` in `src/plans.ts`), not columns per tenant:
  nothing sells a custom quota on the hosted plans, and a change reaches every tenant on a plan
  with the release that makes it, after the Terms' 30 days' notice.
- A check reads `slotlock.tenant_quota_usage(tenant, month)`, which adds the bookings in the feed
  past the roll-up cursor to what `usage_daily` holds, in one statement. A booking counts at once,
  not when maintenance next rolls it up. Between reads, a server adds its operations the meter has
  not recorded yet and the booking operations it ran, and it reads every 2 s instead of 30 s once
  a tenant is past 90% of a stop.
- A count it cannot read lets the operation run, on the last counts of the month if it has any:
  the quota never takes the service down with the database.
- The `RateLimit` fields name each quota, `"operations_month"` and `"bookings_month"`, after the
  tightest per-second bucket. `q` is the stop (Developer's 110%), so `r` counts down to the
  refusal, and `w` is the month's length in seconds.
- The notice is a `usage.threshold_reached` change, sent once per tenant, month, metric and share
  (`slotlock.usage_notices`, erased with the tenant), and a warning on the Plan page rather than on
  every page. `/metrics` and the refusal log count `quota_exceeded`.
- The assistant's operations are checked when they run (`admit`), never when the model proposes
  one, on serve's dashboard and on the Worker.

The design as proposed:

- A plan gains monthly quotas per metric (UTC calendar month, so every tenant resets at the same
  instant and the Plan page can say when).
- Each server keeps month-to-date counts per tenant, read from `slotlock.tenant_usage(tenant,
  month)` at most every 30 s plus its own unflushed delta. With one API server the overshoot is
  bounded by 30 s of traffic; with several, by that times their number. This is a quota, not a
  ledger: billing reads the table, not the cache.
- Over quota, an operation is refused before it runs with `429 quota_exceeded`, a problem detail
  naming the metric, the limit and the reset, and `Retry-After` set to the reset. Reads stay
  allowed when only `bookings` is used up, so an agent can still tell a person why it cannot book.
- Free stops at 100%. Developer stops at 110%, so production is not cut off by a busy day; both
  are told at 80% and 100%.
- Notices: a `usage.threshold_reached` event in the tenant's feed (a tenant-level outbox row, so
  webhooks and live updates carry it), a banner on every dashboard page, and the
  `RateLimit-Policy` and `RateLimit` response fields of draft-ietf-httpapi-ratelimit-headers-11
  (for example `RateLimit-Policy: "month";q=500000;w=2592000` and `RateLimit: "month";r=1200;t=86400`),
  which also carry the existing per-second limits. It is still a draft: the docs name the
  revision implemented, and a later revision is a change under VERSIONING.md.

### Reading it

- `GET /v1/usage?from=&to=&group_by=day|key` (admin scope): counts per metric, per day or per key,
  with the plan's quotas and the reset.
- The Plan page: each metric this month against its quota, a 30-day bar chart drawn server-side as
  SVG (no script), and the counts per key.

### Privacy and retention

The privacy notice gains a row: "How much your account uses the service: counts per day of
operations, bookings, holds, webhook deliveries, resources and assistant messages, by API key and
surface, never what was asked or answered. Kept 13 months, then deleted; erased with the account."
Thirteen months covers a yearly plan and its disputes; invoices are Stripe's records, not ours.

## 4. stackapi.app consuming Slotlock

This environment could not reach `stackapi.app` (the network policy refused the host) and search
engines have no page for it, so this part does not depend on how stackapi works inside. It covers
the two ways any API platform can offer another API to its users. Open question 1 asks which one
stackapi is.

### Shape A: users bring their own Slotlock key (works today)

A stackapi user signs up to Slotlock Cloud, picks a plan, creates a key, and gives it to stackapi,
which forwards their calls to `https://slotlock-api.pylota.io` (REST, MCP or A2A). Slotlock bills
the user; stackapi bills nothing for Slotlock.

- Works now: `/openapi.json` is OpenAPI 3.1 with stable `operationId`s, `x-slotlock-scope` per
  operation, a bearer scheme and the server's public URL; MCP and A2A take the same key;
  `server.json` lists Slotlock in the MCP registry.
- Adds: `Slotlock-Request-Id` and `RateLimit` fields (part 3) so stackapi can show them, and a
  `Slotlock-Client` request field (for example `stackapi.app/1`), matched against a list of known
  integrators and counted as `other` otherwise, so `/metrics` shows traffic by integrator and still
  names no one.
- `server.json` already describes Slotlock for the MCP registry, which a catalogue can import.

### Shape B: stackapi resells Slotlock (needs the partner API)

stackapi holds the relationship and the billing. Each stackapi user gets a Slotlock tenant of their
own, created and managed by stackapi; stackapi pays Pylota wholesale and charges its users retail.

**P1-P4 status:** built on `claude/inspiring-dijkstra-bfvqif`, as below, with a partner's own
tenant `partner:<id>` holding no data, the partner key format `slk_partner_` (40 random base62 and
a 6-character checksum, as tenant keys), the contract kept as snake_case JSON (`plans`,
`key_scopes`, `pricing`), `tenant_plans.source` `direct` or `partner` (not `stripe`), and the
partner API as eleven application operations of their own scope, including listing an account's
keys. Suspension through the partner API is recorded with a `partner: ` reason, so a partner lifts
only its own.

**P1. Partner accounts (T2).** `slotlock.partners (id, name, status, tenant_prefix, stripe_customer,
contract jsonb)`, created only by the deployment owner (`slotlock partner create stackapi`).
Partner keys (`slk_partner_…`), stored like API keys (SHA-256 digests, definer functions), carry a
new scope, `partner`, which reaches only the partner API: no calendar data, no tenant's tools.

**P2. Sub-tenants.** A partner's tenants are `partner:<partner id>:<account>`, where `account` is
stackapi's own id for the user (`^[A-Za-z0-9._-]{1,128}$`). They are ordinary tenants: forced RLS
isolates each stackapi user from every other, and every limit, history and erasure works as for a
direct customer. A suspended partner suspends every sub-tenant at once; `slotlockServeAllowsTenant`
refuses a `partner:` tenant whose partner is not active.

**P3. Partner API (REST, `partner` scope).**

| Call | Does |
| --- | --- |
| `PUT /v1/partner/accounts/{account}` | Create the sub-tenant, or update it; idempotent. Body: `plan` (one of the partner's contract plans) |
| `GET /v1/partner/accounts`, `GET …/{account}` | List, read: plan, status, created, counts |
| `POST …/{account}/keys`, `POST …/keys/{id}/rotate`, `DELETE …/keys/{id}` | API keys for the sub-tenant, shown once, scopes capped by the contract |
| `POST …/{account}/suspend`, `…/unsuspend` | As `slotlock tenant suspend` |
| `POST …/{account}/erase` | Erase, with the account repeated as confirmation, as `/v1/tenant/erase` |
| `GET /v1/partner/usage?from=&to=&account=&group_by=day` | `usage_daily` for the partner's sub-tenants |

stackapi stores each user's Slotlock key (encrypted, its side) and forwards the user's calls with
it. Every existing path then works unchanged, per key, with no new way to act as a tenant. Acting
on behalf with one partner key and a `Slotlock-Account` field, shaped like Stripe Connect's
`Stripe-Account` header, is possible later (T2), and only if stackapi cannot keep a key per user.
The likeness is in the API only: Slotlock's billing does not use Connect, which Managed Payments
does not support.

**P4. Plans for sub-tenants.** `tenant_plans` gains `source` (`stripe` or `partner`) and
`partner_id`; a partner sets a sub-tenant's plan from its contract's list (for example
`partner_free` and `partner_pro` with their own quotas), never above it. Stripe never sees
sub-tenants: Pylota bills the partner.

**P5 and P6 status:** built on `claude/inspiring-dijkstra-bfvqif` as `slotlock partner close <id>
[--month YYYY-MM]` (`src/partner-billing.ts`), run by the owner on the 1st, not by a scheduler in
`serve`: it closes an ended month only, prices it with the contract (each account rounded up on its
own; an account on a plan the contract no longer has is billed as active, never for overage),
records the lines once, sends `usage.period_closed` (webhook id
`usage_period_closed_<partner>_<YYYY_MM>`, signed with the secret `partner webhook` printed), then
adds each line Stripe has not taken as an invoice item, and exits 1 while any line waits, so a
retry finishes the month. The webhook carries the lines and the checksum covers them too. The
`Slotlock-Client` field is counted as `slotlock_requests_by_client_total{client}` for the names in
`SLOTLOCK_KNOWN_CLIENTS`. Known gap: an account erased before its month closes takes its usage
with it and is not billed for that month. The daily cross-check and the 0.5% incident are the
owner's runbook, not code.

**P5. Usage to the partner, end to end.**

- `GET /v1/partner/usage` (above), the same counts Pylota invoices from.
- A signed webhook to the partner, `usage.period_closed`, on the 1st of each month: the month's
  totals per account and metric, and a SHA-256 of the canonical rows, so both sides can check they
  hold the same numbers.
- Each response's `Slotlock-Request-Id` and `Slotlock-Usage` let stackapi count independently. A
  daily job on each side compares totals; a difference above 0.5% opens an incident on our side.
- Disputes are settled from `usage_daily` (13 months). A request id stackapi sends can be found in
  our log with its operation and outcome; the log still names no tenant.

**P6. Billing the partner.** Pylota invoices the partner monthly through Stripe as an ordinary
business customer. Managed Payments cannot be used here: it sells "directly to customers, not
through a platform or marketplace", and a reseller is the second.

- At month close, a job reads the partner's month from `usage_daily`, prices it with the contract
  (active accounts, usage above each account's quota, the minimum), and adds one invoice item per
  line to the partner's next invoice.
- `slotlock.partner_invoices (partner_id, month, line, quantity, amount, stripe_item)` records
  each line before it is sent and its Stripe id after, so a month is billed once even if the job
  is retried days later. Stripe's own deduplication cannot be relied on for that: an idempotency
  key, like a meter event's `identifier`, is kept for about 24 hours.
- The invoice lines are our totals, so reconciliation is a comparison of the same numbers, and
  the `usage.period_closed` webhook (P5) sends the partner the same lines and checksum first.
- Billing Meters are not used: with one partner the volume is a few lines a month, and Stripe now
  directs new usage-based integrations to Metronome. If a partner later needs usage shown live in
  Stripe, that is a separate decision.
- Pylota is then the merchant: VAT on these invoices is ours to handle (B2B reverse charge outside
  the UK), which the accountant should confirm.

**P7. Contract (owner).** A partner agreement and DPA: Pylota processes stackapi's users' data for
stackapi; the Acceptable Use Policy flows down; stackapi gives its users first-line support; Pylota
may suspend a sub-tenant for abuse; on termination stackapi can export each account and Pylota
erases them after 30 days. The privacy notice says partner accounts are covered by the partner's
notice, as it already says of self-hosted deployments.

## Pricing and plans after this RFC

Prices and resource numbers are PR #161's. The quotas are proposed, sized so that one agent booking
(list, search, hold, confirm: four to six operations) fits many times over, and so that a runaway
Free loop at the rate limit uses its month in about 20 minutes rather than costing us all month.
The owner sets the final numbers before PR #161 merges (finding 8).

| | Free | Developer | Partner (wholesale) | Custom |
| --- | --- | --- | --- | --- |
| Price | $0 | $10 a month or $100 a year | Per active account a month, plus usage above the account's quota, with a monthly minimum (contract) | Agreed in writing |
| Resources | 10 | 100 | Per contract plan | Own servers |
| Active API keys | 10 | 100 | Per contract plan | |
| Webhook endpoints | 2 | 10 | Per contract plan | |
| Operations a month | 25,000 | 500,000 (stops at 110%) | Per contract plan | |
| Bookings a month | 1,000 | 25,000 (stops at 110%) | Per contract plan | |
| Assistant (bring your own model) | Yes | Yes | No (stackapi's users have no Slotlock dashboard) | |
| Locations and groups | Yes | Yes | Yes | |
| Keys limited to locations or groups (0.8.0) | No | Yes | Yes | |

- An *active account* is a sub-tenant with at least one counted operation in the month, so
  stackapi pays nothing for users who signed up and left.
- A wholesale price at about 60–70% of retail leaves stackapi a margin on Developer-sized users;
  the owner sets it.
- Usage above quota stays a hard stop for Free and Developer at launch. Stripe documents
  subscriptions under Managed Payments but says nothing about metered prices either way, so
  metered overage for Developer (a price per 10,000 operations) waits until Stripe confirms it.
- What Stripe keeps of a $10 month: 3.5% for Managed Payments, 0.7% for Billing, plus card
  processing and its fixed fee. The yearly price pays the fixed fee once instead of twelve times,
  so the Plan page should offer it first.

## Launch checklist (owner, outside the code)

- [ ] Stripe live mode as PR #161 lists (product, two prices, portal, webhook for
      `checkout.session.completed` and `customer.subscription.*`), and one real Checkout and
      cancellation end to end.
- [ ] Worker secrets `STRIPE_SECRET_KEY` (restricted), `STRIPE_WEBHOOK_SECRET`,
      `SLOTLOCK_ASSISTANT_SECRET`; variables `SLOTLOCK_STRIPE_PRICE_MONTHLY`,
      `SLOTLOCK_STRIPE_PRICE_YEARLY`, `SLOTLOCK_FREE_PLAN_FROM=2026-12-09`, `SLOTLOCK_PLAN_CONTACT`.
- [ ] A lawyer reviews the Terms and privacy changes of PR #161 and of parts 3 and 4, and the
      partner agreement.
- [x] The quotas in the Terms (from 10 December 2026, so the 30 days' notice covers every
      account), pending the lawyer's review; turn on `SLOTLOCK_QUOTAS=on` for serve and the Worker
      on that day, not before.
- [ ] The status probe switched on (`docs/hosted/status.md`: it stays off until the service opens).
- [ ] A restore from the R2 backups, timed, on a scratch server.
- [ ] support@, abuse@ and privacy@ watched, with an erasure runbook that cancels Stripe first.
- [ ] The landing page and hosted page say the same about the assistant (A3).

## Delivery

Each line is one PR with its own red-to-green test. T2 PRs need an independent security review
before merge (GOVERNANCE.md).

| # | PR | Tier | Release |
| --- | --- | --- | --- |
| 1 | Plan default in the database, Free at first sign-in (finding 1) | T2 | 0.6.4, before 9 Dec |
| 2 | Plan limits in every counter; a store count with archived resources (findings 2, 3) | T1 | 0.6.4 |
| 3 | Refuse a second subscription; log a duplicate (finding 4) | T1 | 0.6.4 |
| 4 | Erasure refused while billing is live; runbook (finding 5) | T1 | 0.6.4 |
| 5 | Contact from config; personal address removed (finding 6) | T0 | 0.6.4 |
| 6 | Assistant on Cloud: hosted docs, the site fact pinned to them (A3); owner sets the secret (A1) | T0 | 0.6.4 |
| 7 | Previous assistant secrets (A2) | T2 | 0.6.4 |
| 8 | Usage meter: tables, `record_usage`, operation counter, outbox rollup, `Slotlock-Request-Id`, `Slotlock-Usage` | T2 | 0.7.0 |
| 9 | Quotas in plans, `quota_exceeded`, `RateLimit` fields, threshold events and banner | T2 | 0.7.0 |
| 10 | `GET /v1/usage` and usage on the Plan page; privacy notice row | T1 | 0.7.0 |
| 11 | Resource profile (G1), with list filters and dashboard editing | T1 | 0.7.0 |
| 12 | Locations and groups (G2, G3) | T1 | 0.7.0 |
| 13 | Search by selection (G4) and webhook filters (G5) | T1 | 0.7.0 |
| 14 | Pool order (G7) | T1 | 0.7.0 |
| 15 | Provider presets and model list (A4); assistant usage (A5) | T1 | 0.7.0 |
| 16 | Partner accounts, partner keys, sub-tenants and the partner API (P1–P4) | T2 | 0.8.0 |
| 17 | Partner usage API, `usage.period_closed`, `Slotlock-Client` label (P5) | T1 | 0.8.0 |
| 18 | Partner invoices from usage at month close, billed once, and the reconciliation (P6) | T1 | 0.8.0 |
| 19 | Keys limited by location and group, by RLS (G6) | T2 | 0.8.0 |

### Later

- **Teams on Cloud (T2):** organizations that enable themselves (an owner signs in with
  `read:org` and turns Slotlock on for the organization, stored in the database rather than in
  `SLOTLOCK_DASHBOARD_ORGS`), then a Team plan per organization.
- **Sign-in without GitHub (T2):** Google (OpenID Connect) for the people who run a front desk, a
  clinic's rota or a depot and use the assistant, who often have no GitHub account.
- **Test environments (G9), composite resources (G8), acting on behalf of a sub-tenant (P3).**
- **Metered overage for Developer**, once Stripe confirms Managed Payments supports metered prices.
- RFC 0002 P2: OpenTelemetry export and published SLOs first, as a paid service needs them.

## Vendor facts

Read 2026-11-09 from each vendor's documentation (links under [Sources](#sources)).

| Fact | Value | Used in |
| --- | --- | --- |
| Managed Payments status | Generally available since 22 April 2026, 39 seller countries, the United Kingdom among them, after Stripe's eligibility review | Finding 7 |
| Managed Payments fee | 3.5% per successful transaction, on top of payment processing | Pricing |
| Turning it on | `managed_payments[enabled]=true` on the Checkout Session; activated in the Dashboard; API version `2025-03-31.basil` or later | Finding 7 |
| What it forbids in Checkout | `automatic_tax`, `tax_id_collection`, `payment_method_types`, `customer_update` name and address, shipping, Connect | Finding 7 |
| Eligible products | Digital only, each with an eligible tax code (SaaS for business `txcd_10103001`), sold directly, not through a platform or marketplace | Finding 7, P6 |
| Subscriptions and portal | Supported, created through Checkout or Payment Links; the customer portal works | PR #161 |
| Metered prices under Managed Payments | Not documented either way | Pricing |
| Stripe Billing fee | 0.7% of Billing volume (pay as you go) | Pricing |
| Meter event `identifier` | Unique within a rolling period of at least 24 hours; timestamps up to 35 days back; 1,000 calls a second in live mode | P6 |
| Stripe's advice on meters | New usage-based integrations should use Metronome | P6 |
| Workers (paid) | 10,000 subrequests a request by default; 30 s CPU by default, up to 5 minutes; no duration limit for an HTTP request while the client is connected; `waitUntil` runs up to 30 s more | Part 1, part 3 (Worker usage writes) |
| Workers rate limiting binding | Approximate, counted separately in each Cloudflare location | Part 3 (quotas are kept in PostgreSQL, not in the binding) |
| RateLimit fields | draft-ietf-httpapi-ratelimit-headers-11 (May 2026), a working-group draft, not an RFC | Part 3 |

How others group what they book, which the design in part 2 follows:

| Product | Hierarchy | Flat grouping | Attributes |
| --- | --- | --- | --- |
| Google Workspace resources | Building → floor → floor section | Features | Category, type, capacity |
| Microsoft Graph Places | Building → floor → section → room, workspace or desk (`parentId`) | Room lists | Capacity, tags, custom properties, wheelchair access, booking type |
| HL7 FHIR R5 | `Location.partOf` | HealthcareService | `Schedule.actor` may name several actors (person, room, device) at once; capacity is repeated slots |
| Skedda | Venue → spaces | Space tags | Type, capacity; "space sharing" blocks the whole and its parts both ways (G8) |
| Robin | Location → floor → space | Zones of seats | Type, capacity |
| Fleetio | Groups and subgroups, permissions rolling down (G6) | | |
| Booqable | Product group → product → stock items | Bundles with combined availability | Tracking: none, bulk or individual |
| Cal.com | Organization → teams | Round-robin groups; attributes for routing | Seats per booking |
| Cronofy, Nylas | | Availability across participants: all, or any *n* (Cronofy); collective and round robin (Nylas) | Nylas rooms carry building, floor and capacity |
| Car rental | Region → branch | ACRISS class code (category, type, transmission, fuel) | |

## Open questions

1. **What is stackapi.app?** A catalogue that forwards the user's own keys (Shape A, nothing to
   build), or a platform that bills its users for the APIs it offers (Shape B, PRs 16–18)? Does it
   speak MCP to its users, or REST only? Can it keep a key per user?
2. **Which grouping comes first?** Part 2 orders G1–G5 for every kind of resource alike. If launch
   customers lean one way (people and teams, rooms and buildings, or vehicles and branches), G2
   (locations), G7 (pool order) and G8 (composite) can move up or down. Pylota's own app could be
   the first partner, which would test P1–P6 before stackapi.
3. **Quotas:** the numbers in the pricing table, and whether Developer should stop at 110% or 100%.
4. **Archived resources:** keep counting them against the plan (today, simple) or count only
   resources in use and check the limit on restore (friendlier)?
5. **A bundle of five resources:** five bookings (proposed) or one?

## Sources

**Slotlock code:** `src/assistant.ts`, `src/dashboard.ts` (nav, Settings → Assistant, the Resources
counter), `workers/dashboard/worker.ts` and `wrangler.jsonc` (the assistant secret, `readBilling`),
`site/scripts/sync-content.mjs` (the site's assistant fact), `src/ddl.ts` (resources, outbox,
webhook endpoints, API keys, rate buckets), `src/types.ts` (`SlotlockResource`), `src/metrics.ts`,
`src/self-host.ts` (`authenticate`, `consumeRateLimit`, `slotlockServeAllowsTenant`),
`openapi.json`; on PR #161: `src/plans.ts`, `src/billing.ts`, its `src/ddl.ts`, `src/dashboard.ts`,
`workers/dashboard/worker.ts`, `TERMS.md`, `PRIVACY.md`.

**Not reachable:** `stackapi.app`, `pylota.io` and `slotlock.pylota.io` were refused by this
environment's network policy, and no search engine had a page for `stackapi.app`.

**Stripe** (read 2026-11-09): Managed Payments
[overview](https://docs.stripe.com/payments/managed-payments),
[how it works](https://docs.stripe.com/payments/managed-payments/how-it-works),
[set up](https://docs.stripe.com/payments/managed-payments/set-up),
[Checkout changes](https://docs.stripe.com/payments/managed-payments/update-checkout),
[eligibility](https://docs.stripe.com/payments/managed-payments/eligibility),
[changelog](https://docs.stripe.com/payments/managed-payments/changelog);
[pricing](https://stripe.com/pricing);
[meter event](https://docs.stripe.com/api/billing/meter-event/create),
[recording usage](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api),
[usage-based billing](https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works),
[billing credits](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits);
[Connect authentication](https://docs.stripe.com/connect/authentication).

**Cloudflare:** [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

**IETF:** [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11).

**Resource models:** Google
[calendar resources](https://developers.google.com/admin-sdk/directory/reference/rest/v1/resources.calendars);
Microsoft [place](https://learn.microsoft.com/en-us/graph/api/resources/place?view=graph-rest-1.0);
FHIR R5 [Schedule](https://hl7.org/fhir/R5/schedule.html), [Slot](https://hl7.org/fhir/R5/slot.html),
[Location](https://hl7.org/fhir/R5/location.html),
[HealthcareService](https://hl7.org/fhir/R5/healthcareservice.html); Skedda
[space sharing](https://support.skedda.com/manage-spaces/space-sharing),
[space attributes](https://support.skedda.com/en/articles/9969743-space-attributes); Robin
[space](https://docs.robinpowered.com/reference/space), [zone](https://docs.robinpowered.com/reference/zone);
Fleetio [groups and subgroups](https://help.fleetio.com/en_US/groups-subgroups); Booqable
[product groups](https://developers.booqable.com/api/product_groups.md),
[bundles](https://developers.booqable.com/api/bundles.md); Cal.com
[round robin](https://cal.com/help/event-types/round-robin), [seats](https://cal.com/help/event-types/offer-seats),
[routing with attributes](https://cal.com/help/routing/routing-with-attributes); Cronofy
[availability](https://docs.cronofy.com/api-reference/availability-control/availability/),
[meeting rooms](https://docs.cronofy.com/developers/scheduling/meeting-rooms/); Nylas
[room resources](https://developer.nylas.com/docs/cookbook/calendar/book-room-resources/),
[availability](https://developer.nylas.com/docs/v3/calendar/calendar-availability/);
[ACRISS car codes](https://www.acriss.org/car-codes/).
