# Slotlock

Slotlock is a calendar for AI agents. It books vehicles, rooms, machines, people or anything else
reservable, answers "when is this free?" from weekly availability rules, and lets PostgreSQL reject
double bookings, however many writers race. Agents call it over MCP or A2A; your code calls it as a
TypeScript library.

## Known issues in 0.2.0

Slotlock 0.2.0 can occupy less time than an event was written with, so another booking can take the
rest: around daylight-saving changes, in any time zone that has them, and at the end of some series.
The library and `slotlock serve` are both affected (the last case below is in the library's
iCalendar readers only); the 0.1 releases are older still and unsupported. 0.3.0, released on
2026-10-27, fixes all six cases: upgrade (`npm install slotlock@0.3.0` or
`ghcr.io/pilotaai/slotlock:0.3.0`, then `slotlock migrate`, as the [changelog](CHANGELOG.md) says).
While you run 0.2.0, do not rely on it alone to refuse bookings in them.

- A recurring event whose first occurrence spans a daylight-saving change gets that occurrence an
  hour short: in spring, an hour of the written time is free to book.
- Recurring events written through the store (the agent tools and the application API) lose the
  repeated hour of an autumn change: times in it move an hour early, and a series whose first
  occurrence spans it can store no occurrences, so all of its time is free.
- A stored recurring series cannot cancel or move an occurrence that falls in the skipped hour of a
  spring change; the time it was moved to stays free.
- An occurrence that starts in the skipped hour and lasts longer than the skipped hour is cut short:
  a 75-minute occurrence occupies 15 minutes.
- A timed recurring series with a date-only `UNTIL` ends at midnight UTC, so it can lose its last
  day.
- An event read from iCalendar (`parseICalendarChanges`, `parseTrustedICalendarEvents` or the
  worker pool) whose `DURATION` counts hours loses an hour across a spring change, whether it is a
  single event, a series, an `RDATE` period or a moved occurrence: `DURATION:PT48H` occupies 47
  hours.

0.1.0, 0.1.1 and 0.2.0 also pin zod 4.6.5 exactly, which has a high advisory
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): validating an oversized
array can exhaust memory), which `npm audit` reports. While you run one of them, add this to your
application's `package.json` and run `npm install`:

```json
"overrides": {"zod": "4.6.7"}
```

The full notice, with the versions affected, is in
[docs/release/0.2.0-known-issues.md](https://github.com/PILOTAAI/slotlock/blob/main/docs/release/0.2.0-known-issues.md).

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

Node.js 22.12+, PostgreSQL 16 or newer with `btree_gist` (created for you if missing; CI runs 16,
17 and 18), and `postgres` ^3.4.5 as a peer dependency. TypeScript declarations are included.

## Self-host with Docker

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
| `http://localhost:8080/v1/…` | [REST](#rest-and-openapi): the tools, and the [application API](#application-api) for admin keys; described at `/openapi.json` |
| `http://localhost:8080/healthz` | Readiness, including the database |
| `http://localhost:8080/metrics` | Prometheus metrics, with `Authorization: Bearer <SLOTLOCK_METRICS_TOKEN>`; off without it |

- Metrics count calls by protocol, operation and outcome (`slotlock_calls_total`, with their
  duration in `slotlock_call_duration_seconds`), confirmations, subscriptions, refusals, maintenance
  and webhook deliveries. No label names a tenant, key or client. `createSlotlockMetrics` builds
  them for a server of your own, from its hooks.
- The server runs as a role that owns nothing and cannot bypass row-level security; a one-off
  `migrate` service applies the schema as the owner.
- `SLOTLOCK_AVAILABILITY` sets the default bookable hours. A resource can have its own
  (`slotlock hours set`, or the dashboard); with neither, no slot is offered.
  `SLOTLOCK_CONFIRM_WRITES=all` (as `.env.example` sets it; the server's default is `none`) makes
  every write wait for a person.
- To serve beyond this machine, put a TLS proxy in front and set `SLOTLOCK_PUBLIC_URL`.
- The server limits requests per client address (before any key is looked up), per key, per
  tenant and for the whole server, and answers `429 rate_limited` with `Retry-After` and the
  `RateLimit` fields. The application API counts an admin key's calls in its tenant's own
  `app_read` and `app_write` budgets, apart from the agents'; another key's are its own. A recurring create and every event update (a new title
  re-expands a recurring event's series too) takes its write token, then waits for a slot: one at
  a time per tenant (`tenant_series_writes`) and per server (`series_writes`); each server process
  counts its own. A freed slot rests for as long as the server was busy while the write before
  held it (at most a second), so with one slot, writes that each hold it under a second keep the
  server busy at most about half the time. It then goes to the waiting tenant with the fewest
  writes in flight and, among those, the one whose writes have kept the server busy least lately
  (halving every ten seconds), then to the first to ask. So a tenant sending one write at a time
  waits for the write running, its rest, and the other tenants with one write in flight whose
  writes kept the server less busy: many such tenants, new ones included, can each go ahead of it
  once. Tenants keeping more writes waiting never go ahead of it. Four more of a tenant's writes
  may wait and the rest get 429. When the server's 64 places are all taken, a write from a tenant
  with fewer writes in flight than the tenant with the most takes the place of that tenant's last
  write, which gets 503 `server_busy`; otherwise it gets 503 at once. An expansion runs on the
  server's main thread, so any request may also wait for the one running. A write that has waited
  two seconds gets 429 while its tenant's own write is still running, otherwise 503
  `server_busy`. An application API maintenance run waits the same way for slots of its own: one
  per tenant, `maintenance_runs` per server. The health check is not counted. One tenant's
  requests hold at most `tenant_transactions` (2) of the server's 10 database connections at once
  and the rest wait their turn, so a tenant's writes waiting on its own locks leave the others to
  other tenants and key lookups; a server with one tenant can set `tenant_transactions=10`. A
  request whose transaction waits more than 5 seconds for a lock gets 503 `server_busy`.
  With more than one server, `SLOTLOCK_SHARED_LIMITS=on` shares the tenant budgets (`tenant_*`,
  `app_*`) through the database, so N servers allow a tenant its rate once, not N times; each server
  checks its own buckets first, and goes on with them alone if the database cannot be reached.
  `SLOTLOCK_LIMITS` changes the limits; behind a proxy, set `SLOTLOCK_TRUSTED_PROXY_HEADER` to the field it puts the
  client's address in (`CF-Connecting-IP` behind Cloudflare) before the server takes traffic, or
  every client shares the proxy's budget: the server logs a `client_address_field_ignored` warning
  when such a field arrives without the setting. Behind two proxies, such as Cloudflare and then
  kamal-proxy, name the first one's field: the server reads the last address of a list field such
  as `X-Forwarded-For`, which the second proxy writes as Cloudflare's. A client can send that field
  itself, so let nothing reach the server except through the proxy.
- The server also bounds what one tenant may store, whichever key, agent or application writes
  it: 10,000 holds, and 100,000 each of bookings, calendar events and coverage rows, counted as
  the store's `tenantLimits` count them, besides 10,000 resources. A write past one answers 409
  `hold_limit_reached`, `reservation_limit_reached`, `event_limit_reached` or
  `coverage_limit_reached`; `SLOTLOCK_LIMITS` changes them (`tenant_holds`,
  `tenant_reservations`, `tenant_events`, `tenant_coverage`).

```sh
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=SA","startMinutes":600,"durationMinutes":240}]' --resource vehicle-42
slotlock hours clear --all    # back to SLOTLOCK_AVAILABILITY
```

A rule is `rrule`, `startMinutes` and `durationMinutes` here and in `SLOTLOCK_AVAILABILITY`. The
REST application API spells every field in snake_case, so there it is `rrule`, `start_minutes` and
`duration_minutes`. `slotlock --help` lists every setting.

#### Booking rules

A resource can also say what a booking on it must satisfy:

```sh
slotlock rules set '{"minNoticeMinutes":120,"slotStepMinutes":30,"turnaroundMinutes":30,"enforceHours":true}' --resource vehicle-42
slotlock rules clear --resource vehicle-42
```

| Rule | A booking made now |
| --- | --- |
| `minNoticeMinutes` | starts at least this far ahead |
| `maxAdvanceDays` | starts at most this far ahead |
| `slotStepMinutes` | starts on a step from local midnight in the resource's time zone |
| `stepOffsetMinutes` | starts this far past each step (0 to the step less one): with a 30-minute step, 15 starts bookings on :15 and :45 |
| `bufferBeforeMinutes` | keeps this long free before it: its leading buffer, which the database enforces |
| `turnaroundMinutes` | keeps this long free after it: its trailing buffer, which the database enforces |
| `enforceHours` | lies inside the resource's bookable hours |
| `checkInMinutes` | is claimed (`checkInReservation`) this long after its start, or maintenance releases it |
| `requireCertain` | lies in time every calendar sync recording coverage for the resource has read within a day |

- Holds, reservations, moves and agents' events are checked when they are made, by the database's
  clock; a refusal names the rule (`booking_rule_violated` with `rule` in the store,
  `booking_rule_min_notice`, `_max_advance`, `_slot_step`, `_outside_hours` or `_uncertain` to an
  agent). Under `requireCertain`, a search (the store's and the tools') needs those syncs' coverage
  too, read within a day, of the slot and its turnaround, so it offers no slot they leave unproven.
- A series is judged on its first occurrence for notice and advance, and on every occurrence for
  step and hours. Imported calendar events are not checked: they happened elsewhere.
- Searches (`slotlock_find_next_available`, `slotlock_find_available_slots`, `findNextAvailableFor`)
  offer only slots the rules allow, so an offered slot is one the write accepts.
- Two bookings stay at least the earlier one's trailing buffer plus the later one's leading buffer
  apart: each occupies from its start less its leading buffer to its end plus its trailing one, and
  the exclusion constraint keeps those apart. Free/busy reports that time as busy.
- The REST application API sets them with `PUT /v1/resources/{resource_id}/booking-rules`, in
  snake_case; the store with `setResourceBookingRules`.
- Defaults: rules for every resource of the tenant (`PUT /v1/booking-rules`) and for every member
  of a pool (`PUT /v1/pools/{pool}/booking-rules`), read back with `GET /v1/booking-rules`; the
  store's `setBookingRuleDefaults` and `getBookingRuleDefaults`. A resource's rules as they apply
  (`effective_booking_rules`, `effectiveBookingRules`) are the tenant's defaults, overlaid by its
  pool's, overlaid by its own: a rule set at a narrower level wins. `checkInMinutes` is a resource's
  own only. The dashboard's resource page shows which rules a resource inherits, and from where.
- With no rule set anywhere, nothing changes: every rule is opt-in.
- A tenant has default rules for at most 1,000 pools (`pool_rules_limit_reached`, 409, for one
  more). Merged rules are read leniently: a pool's `stepOffsetMinutes` under a resource's shorter
  step applies modulo that step, and a field that is invalid on its own is ignored (and logged),
  never read as refusing every booking.

### Without Docker

With Node.js 22.12+ and PostgreSQL 16 or newer, run each command as `npx slotlock` after
`npm install slotlock postgres`, or from a clone, built once, as `node dist/cli.js` (a clone does not
put `slotlock` on your `PATH`). Use two roles, as Compose does:
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
slotlock key create "Booking site" --scope read,write,admin
slotlock key list
slotlock key rotate <id>
slotlock key revoke <id>
```

- A key (`slk_…`) is shown once and stored only as a SHA-256. Send it as `Authorization: Bearer`.
- It acts in the tenant it was created for (`SLOTLOCK_TENANT`), so one server serves many tenants.
- `read` covers the five tools that only look; `write` covers create, update and delete; `admin`
  covers the [application API](#application-api), which no agent needs. Default: read and write.
- `rotate` keeps the key's id, scopes and bookings; `revoke` stops it on its next request.
- A tenant may hold 100 active keys. The last six characters are a checksum secret scanners can
  verify offline.

### Retiring resources and tenants

```sh
slotlock resource archive vehicle-42   # no new bookings, holds or events; history kept
slotlock resource restore vehicle-42
slotlock resource delete vehicle-42    # with its history; refused while anything on it is live
slotlock tenant status
slotlock tenant suspend --reason "chargeback review"
slotlock tenant unsuspend
slotlock tenant erase --confirm "$SLOTLOCK_TENANT"
```

- The resource commands take a reference or an id, and act in `SLOTLOCK_TENANT`.
- A suspended tenant may read and writes nothing; its keys still authenticate, but it gets no new
  key or secret. Only the schema owner suspends or lifts a suspension, so `suspend` and `unsuspend`
  connect as `SLOTLOCK_MIGRATE_DATABASE_URL`'s role when it is set.
- `erase` deletes everything the tenant has, its API keys included, at once and for good;
  `--confirm` must repeat the tenant. A suspension outlives it.

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

- Its pages: an Overview with the coming week's bookings, events and live holds across every
  resource (each in its resource's time zone) and the latest changes agents made, named by key;
  Resources, each with its own page for bookable hours, booking rules, pool, coming bookings and
  activity; Waitlist, to see who waits and remove an entry; API keys, with the MCP and A2A
  endpoints; Webhooks, to add, delete and re-enable endpoints and see which are failing; and
  Settings.
  Everything on them is read from the tenant's own data. `SLOTLOCK_DASHBOARD_NAME` sets what the
  dashboard calls the deployment (Slotlock by default).
- Each person gets a tenant of their own, `github:<user id>`: the keys, resources and bookings in it
  are theirs alone. Keys made with `slotlock key create` act in `SLOTLOCK_TENANT` instead.
- **For organizations instead of people**, set `SLOTLOCK_DASHBOARD_ORGS` to the GitHub organization
  ids the dashboard serves (`gh api orgs/<login> --jq .id`). Each is then one tenant,
  `github-org:<id>`, that its members share: keys, resources and hours. A person signs in to the
  served organizations they are an active owner or member of (a billing manager is neither),
  switching between them when there are several; someone in none of them is refused. Every member
  has the same power: each can create, rotate and revoke the organization's keys, and the key list
  says who created each one. Membership is read at each sign-in, so a person who leaves keeps
  the dashboard until their session ends (12 hours at most), and keys they made work until revoked.
  Removing an id from the list signs its sessions out and stops its keys at once. An organization
  that restricts OAuth apps must approve the dashboard's app (its Settings, Third-party access), or
  GitHub hides the membership. `SLOTLOCK_DASHBOARD_USERS` still says who may sign in at all, and a
  key records the person who created it (`github:<user id>`): erasing that person's own tenant
  leaves it on keys they made in an organization, which go with the organization's erasure. Only the
  first 100 memberships GitHub lists, and the first 20 served organizations by login, are read.
- Sign-in uses `state` and PKCE, and keeps nothing from GitHub but the user id and login (and, with
  organizations, the served ones the person belongs to): the GitHub token is used once and dropped.
  It asks for no scope, or `read:org` with organizations.
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

#### Assistant: operate Slotlock by chat

With `SLOTLOCK_ASSISTANT_SECRET` set (32+ random characters, `openssl rand -hex 32`), the dashboard
gains an Assistant page where every member chats with a model their organization connects, instead
of clicking. Each organization brings its own model:

- **Connect it** in Settings, Assistant (owners only; with personal tenants, each person): the
  provider (`Anthropic Messages API`, or `OpenAI-compatible`, which covers OpenAI, OpenRouter,
  vLLM, Ollama and LM Studio), the base URL (`https://api.anthropic.com`, or the one ending in
  `/v1`: `https://api.openai.com/v1`, `http://localhost:11434/v1`; https, or http only on
  `localhost` or `127.0.0.1`), the model name (`your-model`) and the API key, which a local model
  may not need. As with webhooks, a URL whose host is, or resolves to, a loopback, private,
  link-local, shared (CGNAT), unique-local or metadata address (`169.254.169.254`) is refused, when
  it is saved and at each connection (the address the socket connects to is checked, so a name
  rebound to one is refused too), and the page says why. For a self-hosted model on the server's
  own machine or network (Ollama, vLLM), the operator sets `SLOTLOCK_ASSISTANT_PRIVATE_URLS=on`.
  On Cloudflare Workers the literal check applies and names are not resolved: a Worker's fetch
  reaches no private network. Changing the provider or the base URL takes the key again (decided in the
  database write, so racing saves cannot get past it), so the stored key is only ever sent where it
  was entered for, even on an origin that serves several accounts. **Test connection** makes one real request
  and checks the model answers with one correct tool call. The organization's messages, and the bookings and resources the assistant
  reads, are sent to the provider it configures.
- **The key** is stored sealed with AES-256-GCM under a key derived from `SLOTLOCK_ASSISTANT_SECRET`,
  bound to the organization, in `slotlock.assistant_settings` (forced row-level security, erased
  with the tenant). The dashboard shows only that it is set and its last four characters. Changing
  the secret makes stored keys unreadable: owners enter them again.
- **Reads run, writes wait.** The server runs the tool loop, up to 8 model calls a message, with a
  fixed list of the agent tools (the reads: resources, free-busy, next free time, slots, pool
  availability, events; the writes: holds, bookings, pool and bundle bookings, changes and
  cancellations). A read runs at once through the same operation boundary as an agent's. A write
  never runs when the model asks: it appears as a proposed change the member approves (or
  dismisses) with a form, and only then runs, once (its idempotency key is the dashboard's), with
  the same booking rules, tenant limits and rate limits as an agent, recorded as
  `dashboard-assistant:github:<user id>` (shown as "Assistant for @login"). The card leads with
  the sentence a confirmation would ask (the resource by name, the times in its zone, and for a
  change or cancellation the event's title, resource and time as it stands) and then shows every
  argument in full; a change too large to show (16 KB of arguments) is not proposed, and a
  conversation has at most 4 waiting. A proposal is only checked: the series-write slot and the
  write's rate token are taken when the approved change runs. A message's reads share a budget of
  16 calls and 400 resource-days. API keys, webhooks, booking rules, pools, erasure and
  coverage are never offered; a tool the model names outside the list is refused.
- Tool results and booking data are data to the model, never instructions, and the system prompt
  says so; the tool list does not change with what the model says. A member may send 10 messages
  a minute; each model call has 30 seconds and a message 90. Conversations are kept per member in
  `slotlock.assistant_conversations` for 2 hours after the last message, then deleted: by
  `serve`'s maintenance, which sweeps every tenant's expired conversations every quarter hour (a
  tenant only the dashboard serves included), by `slotlock maintain`, and whenever the tenant's
  conversations are read (so on Workers too). They are bounded in UTF-8 bytes; **New conversation** forgets one. On Workers, the
  assistant's agent calls are capped at 24 a request and by `tenant_read` and `tenant_write` of
  `SLOTLOCK_LIMITS` in each isolate. A provider's failure is shown as a plain message, never with
  the key or the provider's answer.
- It works as plain forms: no script is needed.

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
   - the three rate limiting bindings, each with a `namespace_id` unique in your account.
3. Create the GitHub OAuth app as above, with the callback URL
   `<SLOTLOCK_PUBLIC_URL>/dashboard/callback` on the Worker's origin.
4. Store the secrets on the Worker: `npx wrangler secret put` for `SLOTLOCK_GITHUB_CLIENT_ID`,
   `SLOTLOCK_GITHUB_CLIENT_SECRET` and `SLOTLOCK_SESSION_SECRET`, and `SLOTLOCK_ASSISTANT_SECRET`
   for the assistant.
5. Deploy: `npm ci --omit=dev` at the repository root (the Worker bundles Slotlock's sources), then
   `npx wrangler deploy --config <your configuration>` in `workers/dashboard`.

- Each request opens its own database client, at most five connections, and closes it when the
  response is sent; Hyperdrive keeps the pool.
- Anyone may start a sign-in, and each callback costs a database write and a request to GitHub
  with the app's client secret. An isolate runs at most eight at once, but Workers run many
  isolates, so three rate limiting bindings bound them all:
  - `SLOTLOCK_CLIENT_RATE_LIMIT` counts every dashboard request per client address (an IPv6
    client's /64, as `slotlock serve` counts it);
  - `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts sign-ins and callbacks per client network (an IPv6
    client's /48, a site's allocation, as `slotlock serve` counts its sign-ins), so a site rotating
    through its /64s cannot use up the ceiling;
  - `SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT` counts them from every client together, set far above one
    client's limit so a few clients cannot use it up for everyone.

  Their counts are per Cloudflare location. Without either of the first two the Worker answers 503.
  Without the ceiling, as in a configuration from before it, `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts
  every client together, and the Worker logs a warning: add the ceiling before lowering that
  binding's limit to one client's. The example configuration also removes query strings (a
  callback's OAuth code) from the URLs Workers Logs keep.
- With organizations, set `SLOTLOCK_DASHBOARD_ORGS` on both the Worker and the server: the server
  takes an organization's keys only while its own list names it, whether or not it serves the
  dashboard.
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

A rule `expandRules` cannot evaluate adds no availability; it never invents a slot. A search window
may be 367 days at most (`invalid_window`), here and in `findNextAvailableFor`.

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
another level. A store sharing one pool among tenants can bound each tenant's share:
`createSlotlockStore(sql, { maxTenantTransactions, tenantLockTimeoutMs })` runs at most that many
of a tenant's `withTenant` transactions at once (the rest wait in the process, and leave the line
when `withTenant`'s `signal` aborts), and refuses one that waits longer than that for a lock with
`lock_timeout`, safe to retry. `slotlock serve` sets `tenant_transactions` (2) and 5,000.

`createResource({ ..., maxTenantResources })` refuses a new resource (`resource_limit_reached`) once
the tenant has that many (1-100,000); an existing `externalRef` is still updated. Capped creates for
one tenant take a database lock and count under READ COMMITTED, so racing ones stop at the cap on
any number of servers; inside a REPEATABLE READ or SERIALIZABLE transaction they refuse
(`invalid_transaction_isolation`). Uncapped creates take no lock.

`setResourceAvailability({ tenantRef, id, rules })` gives a resource its own bookable hours (`null`
uses the default, `[]` closes it); `setTenantAvailability({ tenantRef, rules })` sets every resource
of a tenant. `createSlotlockStoreAgentBackend` answers from a resource's own hours and calls
`availabilityRules` only for resources without them.

Waitlists: `joinWaitlist({ tenantRef, resourceId | pool, start, end, holderRef, offerTtlMs })`
waits for a window that is taken now. When it comes free (a cancel, a released or expired hold, a
no-show), `offerWaitlist` gives it to the entries in the order they joined: the first whose window
is free, on its resource or the first free member of its pool, gets a hold for its holder, and the
feed says so (`waitlist.offered`, with `hold_id`). Confirm the hold to book it; let it go and the next
is offered. Cancels, releases and moves, whether an agent (MCP, A2A) or the application API makes
them, offer at once; maintenance offers what lapses on its own (an expired hold, a no-show) and
expires entries whose window has started (`waitlist.expired`). With `checkInMinutes` in a
resource's booking rules, maintenance releases a booking made since the rule was set that nobody
checked in that long after its start, or after it was made for a walk-in (`reservation.no_show`),
and the waitlist is offered its time. Check-in opens an hour before the start; moving a booking to
another start clears it. Leaving the waitlist lets an offer not yet confirmed go with it.

Calendar tools speak the standards: `emitVAvailability({ rules, timezone, uid })` writes rules as an
iCalendar VAVAILABILITY (RFC 7953) and `parseVAvailability(text)` reads one back as
`{ timezone, rules }`; `toJSCalendarEvent(event)` answers a calendar event as a JSCalendar Event
(RFC 8984). The API serves them at `/v1/resources/{resource_id}/availability/ical` and
`/v1/tenant/events/{event_id}/jscalendar`.

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
the window forward, never moving its end back. Outside it, before or after, free/busy reports the
time as unproven.

A rule is expanded within a budget of steps, a count of work that reads no clock, so the same input
is accepted or refused however loaded the machine: 500,000 for a feed (the whole read, from its
text) or for a stored series as maintenance rolls it, about half a second, and 50,000 for one event
as it is written, refused within a tenth of a second whatever its rule or time zone (on a laptop; a
4-vCPU Linux server takes up to twice as long). A step is about a microsecond: a step of ical.js's
search costs three, a weekday compared one, five days walked one, a year scanned three (and one for
each eight days it lists), and two weekdays of a year listed one. Each occurrence passed costs one
more, each conversion of a time in an IANA zone half (one and a half in a zone only the feed
defines), and each instant Intl is asked for to read a zone's offsets five, the first time an
expansion reads that day of the zone, whatever the process has read before. A feed's own time zones
(VTIMEZONE) count against the same budget, each change listed when one is expanded costing four
tenths: one written the way Outlook writes them, from 1601, costs about 6,000. A feed may carry 100
time zones and name 100 it does not define, 1,000 observances and 2,000 RDATE values in the zones it
carries, and 20,000 RDATE and EXDATE values in its events, and an event 8 RRULEs, each further one
costing a step at every occurrence its expansion passes; a property's name and parameters may take
8 KB and list 100. A MINUTELY to WEEKLY step, a `DURATION`, or an event's length may be a century at
most. A calendar that needs more, such as a rule that never occurs
(`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`), is refused: `invalid_event` on a write, `invalid_icalendar`
from a feed.

A feed's rules are expanded from their start, and each series may pass 4,000 occurrences on the way
(a daily one, about 11 years) whatever the feed's other series take. A feed series with one DAILY or
WEEKLY rule and no COUNT, RDATE or `RANGE=THISANDFUTURE` override is searched from just before the
window instead, so a daily standup since 2014 reads like one that began this year. A stored series
keeps where its last expansion stopped, and the next one resumes there, so a daily series keeps
rolling for as long as it runs: its budget goes on the window, not on the years before it. A write
that changes a series searches from its start, and resumes from where it stopped only if that search
is over the budget. A place serves only the rule, start and time zone it was kept for, read by the
same version of ical.js, and never lies past an occurrence that could still reach the window (one
within the event's length and a day of it, or one an exception moves into it). Otherwise the series
is searched from its start, within the same budget. During maintenance, a stored series that
outgrows the budget, that an earlier release stored and this one refuses, or whose roll fails for
any other reason (a row no release could have written, such as a rule ical.js cannot read), is
counted as `refused` (its ids in `refusedEventIds`), keeps its old coverage and waits an hour behind
the others. A pass whose roll fails still prunes, then reports the failure.
`storedCalendarEventProblem(event)` says why this
release would refuse a stored event (a rule shape it no longer expands, `COUNT` with a yearly day
some years lack, or an exception that names no occurrence), or `null`; run it over your stored
events before upgrading.

A stored rule is daily or less frequent and follows RFC 5545's grammar: `COUNT=0`, an unknown or
repeated part, or `COUNT` with `UNTIL` is refused. Shapes ical.js 2.2.1 expands differently from
RFC 5545 are refused everywhere, a feed included, and `recurrenceRuleProblem(rule)` says why:
`BYWEEKNO`; a two-digit `BYDAY` ordinal; `BYSETPOS` other than with `FREQ=MONTHLY` and `BYDAY`
alone; `BYMONTH` with `FREQ=MONTHLY`; a negative `BYMONTHDAY` other than with `FREQ=MONTHLY` and
no `BYDAY`; `FREQ=YEARLY` with `BYMONTHDAY` but no `BYMONTH`, with a day none of its months has,
with `COUNT` or `BYDAY` and a day one of its months can lack, with `BYYEARDAY` and `BYMONTH` or
`BYMONTHDAY`, or with a numbered `BYDAY` and `BYMONTHDAY`; `BYHOUR` with `FREQ=HOURLY`,
`BYMINUTE` or `BYSECOND` with `FREQ=MINUTELY`, and any of them with `FREQ=MONTHLY` or `YEARLY`;
and `FREQ=SECONDLY`. A yearly day some years lack (29 February, or a 31st with April) occurs only
in the years that have it, as RFC 5545 says, so its series may not add an RDATE or a second RRULE.
A DATE `UNTIL` on a timed series includes its whole day on the series' clock. An event's time zone
is an IANA name, stored in its canonical spelling (`europe/london` becomes `Europe/London`); a UTC
offset such as `+05:00` is refused.

A recurrence exception names the occurrence it cancels or moves by that occurrence's instant, as
`expandCalendarEventOccurrences` reports it, and is exported as a UTC `RECURRENCE-ID`; one that
names no occurrence is refused, so a mistyped instant is an error rather than a cancellation that
frees nothing. A series' occurrences never overlap each other: one that reaches past the next one's
start (a day-long occurrence the night the clocks go forward) ends there, and the next ends at the
later of the two ends, so the series holds the same time as separate reservations.

### External calendars

Provider adapters (Google, Microsoft, CalDAV) stay in your application, with their credentials.
Slotlock gives them neutral boundaries:

- `normalizeExternalCalendarChange` for webhook changes; `parseICalendarChanges` and `emitICalendar`
  for bounded iCalendar in and out; `emitITipCalendar` for invitations.
- `parseICalendarFeed` reads a feed series by series: a series it cannot read (a refused rule
  shape, an end the clocks move onto its start, DTEND with DURATION, more than 4,000 occurrences
  from its start, or more work than the feed's budget has left) is named in `refused` by UID, with
  `limit: true` for the last two, and the rest is read. Treat a refused series' time as busy, or the
  feed's coverage as incomplete. `parseICalendarChanges` refuses the whole feed instead.
- All-day events become whole local days in the calendar's time zone; a feed without one is refused.
- A TZID Intl knows is read as that IANA zone, whether or not the feed defines it (a VTIMEZONE's
  own rules for such a name are not used); one only the feed defines, such as a Windows name, is
  read from its VTIMEZONE. A floating time is read in the calendar's zone. So an UNTIL, EXDATE,
  RDATE or RECURRENCE-ID written in UTC or another zone names the occurrence it means, a floating
  UNTIL is read on the series' own clock, and a `RANGE=THISANDFUTURE` exception moves every later
  occurrence by its own shift.
- An event with no length (a DATE-TIME DTSTART without DTEND or DURATION) occupies no time and is
  left out. A PERIOD RDATE ends where its period does. A document whose root is not a VCALENDAR, or
  an event that ends before it starts, is refused as `invalid_icalendar`.
- A series' DTSTART is its first occurrence, with or without an RRULE; every RRULE is expanded; an
  instant two of them, or an RRULE and an RDATE, name is one occurrence; every EXDATE excludes the
  occurrence it names (RFC 5545 §3.8.5). A DATE EXDATE of a timed series names the occurrence at the
  series' start time that day.
- An occurrence of a series occupies both readings of it when the clocks change inside it: its
  exact length from its start (RFC 5545 §3.8.5.3) and its written end on the wall clock (the later
  instant of a repeated hour). 00:00-06:00 holds six hours the night the clocks go forward and
  seven the night they go back. A start in a skipped hour moves forward by the gap; one in a
  repeated hour is its first instant. One-off events, overrides and PERIOD RDATEs occupy exactly
  the times they give. A series' occurrences never overlap each other, as for stored series. SPEC.md,
  "Daylight-saving time", lists the cases.
- An override without DTEND or DURATION lasts its series' length. One whose RECURRENCE-ID names no
  occurrence, or whose occurrence the series also EXDATEs, occupies its own time, as the provider
  shows it. The instances of a CalDAV-expanded series are each read, the first with or without a
  RECURRENCE-ID. An event with both DTEND and DURATION is refused.
- `parseTrustedICalendarEvents` reads times as `parseICalendarChanges` does, so a series stored from
  it occupies what the feed reports; an all-day series, stored from local midnight to local
  midnight, may also hold the hour after a midnight the clocks go forward on, never less. It drops
  an EXDATE that names no occurrence, and refuses what a stored series cannot hold: a zone only the
  feed defines (a Windows name such as `GMT Standard Time`; map it to an IANA zone first), a DTSTART
  or DTEND the clocks skip (an all-day series' first midnight included), a `DURATION` that counts
  days or weeks outside UTC, an instance whose transparency differs from its series', or a moved
  instance that names no occurrence.
- `emitICalendar` and `emitITipCalendar` write a VTIMEZONE for the zone their times name (RFC 5545
  §3.6.5), from the IANA rules: every change over the years the event covers, and, where a zone
  changes on the same numbered or last weekday of a month every year, yearly rules that carry a
  series on past them. A zone that does not, such as Casablanca, Gaza, Jerusalem or Santiago, is
  exact over those years only.
- `recordCalendarCoverage` marks how much of a feed is read. Pass the sources a resource depends on as
  `requiredSources`, and any coverage short of `complete` means the time is not proven free.

Read a feed someone else controls with `createICalendarWorkerPool`, which runs the same parsers on
worker threads. However costly the feed, the thread that serves requests never runs ical.js on it: a
worker past its deadline (3 seconds by default) or its heap (128 MB) is stopped, and the feed is
refused with `CalendarExpansionLimitError`. The pool offers `parseICalendarFeed` too. When every
worker is busy and the queue is full, the pool answers `ICalendarWorkerBusyError` at once. A worker
starts in about 40 ms and is reused; idle workers do not keep the process alive. The pool runs from
the built package (the worker is `ical-worker-thread.js`), not from Slotlock's TypeScript sources.

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
  createSlotlockStoreChangeSource,
} from 'slotlock';
import { createSlotlockNodeServer } from 'slotlock/node-server';
import type { Sql } from 'postgres';

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
  /** The store's client: live updates read the change feed's head with it. */
  sql: Sql;
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
    // Live updates follow each tenant's change feed: a booking is announced as it commits.
    subscriptions: { changes: createSlotlockStoreChangeSource(config.store, config.sql) },
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
| `slotlock_find_available_slots` | Up to 50 *certain* slots, earliest first, to offer a choice | read-only |
| `slotlock_hold_slots` | Hold up to 5 candidates for 30-900 seconds while a person chooses | write |
| `slotlock_release_slots` | Release a hold and the rest of its group | write |
| `slotlock_book_together` | Book the same time on 2-20 resources, all or none | write |
| `slotlock_book_pool` | Book any one free member of a pool (a vehicle class, a room type) | write |
| `slotlock_get_pool_availability` | How many of a pool's members are free across a window | read |
| `slotlock_list_events` | Events the caller created in a window | read-only |
| `slotlock_get_event` | One event the caller created | read-only |
| `slotlock_create_event` | Create an event of up to 3,660 days (idempotent) | write |
| `slotlock_update_event` | Patch at an expected revision, optionally fenced to `expected_resource_id` | write |
| `slotlock_delete_event` | Tombstone at an expected revision | write, destructive |

A query window is at most 367 days. Each caller sees only the events it created, but everyone's
events count as busy time.

An agent offering a person several times holds them first, so none is taken while the person
decides: `slotlock_hold_slots` holds each free candidate in one group (and lists the taken ones in
`refused`), and `slotlock_create_event` with one `hold_id` books that time and releases the rest in
the same transaction. A hold belongs to the agent that took it: another agent can neither book nor
release it. One agent may have 20 live holds at once, holding at most 2,160 hours together in
`slotlock serve` (`SLOTLOCK_LIMITS`: `holder_holds`, `holder_held_hours`; `maxHoldsPerHolder` and
`maxHeldHoursPerHolder` in `createSlotlockStore`); past either it is refused, `hold_limit_reached` or
`held_time_limit_reached`. Unbooked holds expire by the database clock.
Notice was judged when the time was held, so booking the hold does not judge it again.

A booking that needs several resources at once (a van and its driver, a room and its projector)
uses `slotlock_find_available_slots` with `require_free` (every resource, or any n of them, free
together, each judged by its own hours and rules) and books with `slotlock_book_together`: one event
per resource in one transaction, all or none. A refusal names the `resource_id` that refused, on
MCP and A2A in the error beside its `code`, on REST in the problem. Bundles take their resources
in one order, so two racing over the same ones end with one booked, never a deadlock.

Rentals sell a class, not a plate. Put interchangeable resources in a pool
(`PUT /v1/resources/{id}/pool`, `setResourcePool`); agents see each resource's `pool`, list a pool's
members with `slotlock_list_resources` and `pool`, and book the class with `slotlock_book_pool`,
which takes the first member that is free and allows the booking, in one transaction: a class of
five sells exactly five for a time, however many race (`pool_full` after that). To see how many are
free, `slotlock_get_pool_availability` splits a window where that number changes (counting each
member busy over its bookings' occupied time, buffers included, but not the buffers a new booking
would keep, so a member it counts free may still refuse a booking that abuts another); to see which,
search the members with `slotlock_find_available_slots` and `require_free: 1`: each slot names the
members free in `resource_ids`. `GET /v1/pools` lists the pools with their capacity. The older names `calendar.<verb>` and `calendar_<verb>` still work and
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
| `request_aborted`, `server_busy`, `store_inconsistent` | Transient; retry |

#### Errors from your own backend

Throw `new SlotlockAgentOperationError('snake_case_code', status)` and the agent receives the code.
Any other exception is a server fault, and its message never leaves the server: the agent gets
`internal_error`, and `onError(error, { operation })` gets the error, as it does a result outside
the operation's output schema, so you can log it. `slotlock serve` logs it as an `agent_error` line
on stderr.

#### Protocol errors

| Where | Error |
| --- | --- |
| HTTP | `401` with `WWW-Authenticate`, `403` disallowed origin, `413`/`415` bad body, `429` rate limit (MCP, REST) |
| MCP | `-32602` unknown tool, `arguments` that are not an object, or altered confirmation; `-32603` server fault; `-32601` unknown method |
| MCP 2026-07-28 | `-32020` header disagrees with body, `-32021` form elicitation not declared, `-32022` unsupported revision, `-31029` rate limit |
| A2A | `-32602` malformed message or parameters, `-32029` rate limit (`RATE_LIMITED`, in the 200 envelope like every A2A error), `-32009` unsupported `A2A-Version`, `-32003` push notifications, `-32004` task subscription or extended card, `-32001` task not found (the server keeps no tasks) |

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

- A booking that leaves the time free (`transparency: 'transparent'`) says so, and a write names
  the other fields it sets (`also description, attendees`) without quoting them.
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
- The yes comes from the client: Slotlock relies on the MCP client to ask its person, and a key
  holder's own client can answer for itself. Confirmation keeps an agent from writing unasked; it is
  not an authorization boundary. Scopes and `authorize` decide who may write.
- `secrets` holds 1 to 8 keys of 32+ bytes: list the new one first to rotate. `onEvent` reports each
  outcome for audit.

### Calendar resources and live updates

On MCP 2026-07-28 each resource is also an MCP resource, `slotlock://resources/{id}`, whose read
returns busy time and coverage for the next `resourceWindowDays` (30). `subscriptions/listen` streams
`notifications/resources/updated` when a resource's free/busy changes.

- With `subscriptions.changes` (`createSlotlockStoreChangeSource(store, sql)`; `slotlock serve`
  sets it), changes come from the tenant's change feed: one reader per tenant per process, shared by
  all its subscriptions, polls the feed by cursor, one indexed query per read, under the tenant's
  row-level security. It reads again 250 ms after a read that found changes
  (`SLOTLOCK_FEED_BUSY_MS`, also the least gap between two reads) and backs off to once a second
  when quiet (`SLOTLOCK_FEED_IDLE_MS`), so a booking is announced within about a second. A change
  re-reads the subscriptions watching its resource, at most once a second each however many
  changes arrive, and each announces only what actually changed in its window. A cursor the feed
  has pruned past announces every watched resource once, then follows from now.
- Each subscription is also re-read every `pollIntervalMs` (15 s with a feed, 10 s without one,
  which is then the only way changes are found), re-checking the caller each time, so a revoked key
  or what the feed does not carry (bookable hours) is caught.
- A subscription ends after `maxDurationMs` (15 minutes), on `shutdown()`, or when access is lost.
- At most 4 open per caller and 256 per server (`maxPerPrincipal`, `maxTotal`). `maxPerTenant`
  caps one tenant's across all its callers (default `maxTotal`; `slotlock serve` sets 16), so a
  tenant with many keys cannot hold every slot. When the server is full, a tenant holding fewer
  than the tenant holding most, less one, ends that tenant's oldest stream instead of being
  refused, so many tenants cannot hold every slot either. `slotlock serve` sets `maxTotal` to
  `subscriptions` (256) and lets one key hold `key_subscriptions` (4), and always fewer than its
  tenant may unless that is one, so one key cannot lock its tenant's other keys out.
  `subscriptions: false` turns them off.

### Caching and tracing

2026-07-28 results carry cache hints: discovery and tool lists are public for an hour, free/busy is
never cached. W3C `traceparent`, `tracestate` and `baggage` reach your backend as `context.trace`.

`onEvent` hears about every call that names an operation, so you can count, time and correlate them:

- `{ type: 'call', protocol, operation, outcome, durationMs, traceId? }` for an MCP `tools/call` or
  A2A `SendMessage`; `outcome` is `ok`, the refusal's code (`overlap`, `rate_limited`, …), or why
  it was refused before it ran: `invalid_arguments`, `missing_capability` (a guarded write from a
  client that cannot confirm), `invalid_message` or `invalid_message_parameters` (A2A).
- `{ type: 'rest', operation, status, durationMs, traceId? }` for a REST call, or one refused before
  it ran: a body that is not JSON (415, 400), too large (413) or not an object (400).
- `{ type: 'confirmation', operation, outcome }` for each confirmation, before the call it decides.
- A request refused before its operation is read is not reported: a missing credential, the rate
  limit, an `A2A-Version` other than 1.0, a JSON-RPC envelope that does not parse, a path no route
  has.
- `traceId` is the trace id of a valid `traceparent` from `_meta` or the header. Arguments, callers,
  the parent span, `tracestate` and `baggage` are never reported, and an `onEvent` or `onError` that
  throws, or returns a promise that rejects, changes nothing a client sees. Resource reads and
  subscription polls are not reported.

`slotlock serve` writes each as a JSON line (`"event":"call"`, `duration_ms`, `trace_id`).

### REST and OpenAPI

`rest: true` also serves each tool as plain HTTP, described by an OpenAPI 3.1 document at
`/openapi.json`. `slotlock serve` has it on; `SLOTLOCK_REST_API=off` turns it off.

| Request | Tool |
| --- | --- |
| `GET /v1/resources` | `slotlock_list_resources` |
| `GET /v1/free-busy` | `slotlock_get_free_busy` |
| `GET /v1/next-available` | `slotlock_find_next_available` |
| `GET /v1/available-slots` | `slotlock_find_available_slots` |
| `POST /v1/slot-holds` | `slotlock_hold_slots` |
| `DELETE /v1/slot-holds/{hold_id}` | `slotlock_release_slots` |
| `POST /v1/bundles` | `slotlock_book_together` |
| `POST /v1/pool-bookings` | `slotlock_book_pool` |
| `GET /v1/pool-availability` | `slotlock_get_pool_availability` |
| `GET /v1/events` | `slotlock_list_events` |
| `POST /v1/events` | `slotlock_create_event` |
| `GET /v1/events/{event_id}` | `slotlock_get_event` |
| `PATCH /v1/events/{event_id}` | `slotlock_update_event` |
| `DELETE /v1/events/{event_id}` | `slotlock_delete_event` |

```sh
curl "http://localhost:8080/v1/resources" -H "Authorization: Bearer $SLOTLOCK_API_KEY"
```

- `GET` and `DELETE` take the tool's arguments as query parameters (a list repeats:
  `resource_ids=a&resource_ids=b`); `POST`, `PUT` and `PATCH` take a JSON body. Ids are in the path;
  percent-encode one that holds `/`.
- Keys, scopes, `authorize` and the rate limit apply as over MCP. The body is the tool's output, or
  an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with
  the matching HTTP status: `type` (a tag URI, one per code), `title`, `status`, `code`, and
  `error.code` as well, the body earlier clients read. An `overlap` names the `resource_id`, `start`
  and `end` it refused. A `Link: <…>; rel="describedby"` header points at these docs.
- A write's `idempotency_key` may come as the `Idempotency-Key` header instead
  ([draft 08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)): a
  quoted Structured Field String (`Idempotency-Key: "booking-BK-42"`) or the bare key, equal to the
  argument when both are sent. A write that needs one and gets neither answers
  `400 idempotency_key_required`; the same key with another request, `422 idempotency_conflict`.
  An event write's key is kept 30 days (or `SLOTLOCK_RETENTION_DAYS`), then removed by maintenance,
  after which the key is new; a
  hold's until the hold would have expired, is released or is confirmed.
- REST cannot ask a person, so a write listed in `confirmation` answers `428 confirmation_required`.
- Free/busy and the next-available search read each resource they name once, however often it is
  named, and 10,000 busy intervals in all; the next-available search also expands 100,000 bookable
  windows from its resources' hours in all. Past either they answer `400 calendar_work_limit`: ask
  for fewer resources or a shorter window.
- There are no CORS headers: call it from a server, not a browser.
- From Python, Go, Rust, Java or .NET, use the [clients](clients/README.md): one method per
  operation, the application API included, each tested against the server in CI. For another
  language, generate one from [`openapi.json`](openapi.json) (or a server's `/openapi.json`, or
  `slotlock/openapi.json` in the npm package) with any OpenAPI 3.1 generator.

### Application API

What the application around the agents does, from any language: the store's resource, hours, hold,
reservation, coverage and maintenance calls, as REST beside the tools. It needs a key with the
`admin` scope ("Full" in the dashboard); the server's own `SLOTLOCK_AUTH_TOKEN`, the token agents
are given, reads and writes but is never admin. It is never an MCP tool or an A2A skill, and never
waits for a confirmation.

| Request | Does |
| --- | --- |
| `POST /v1/resources` | Create the resource with this `external_ref`, or update its `timezone`; `visibility: "private"` hides it from agents |
| `GET /v1/resources/{resource_id}` | One resource, with its own weekly hours, visibility and `archived_at` |
| `POST /v1/resources/{resource_id}/archive` | Take it out of use; `…/restore` puts it back |
| `DELETE /v1/resources/{resource_id}` | Delete it with its history (`409 resource_in_use` while anything on it is live) |
| `GET /v1/resources/{resource_id}/busy?start=…&end=…` | Its occupied time, private resources included |
| `PUT /v1/resources/{resource_id}/availability` | Its own weekly hours; `[]` never bookable, `null` the server's |
| `PUT /v1/availability` | Every resource's weekly hours at once |
| `POST /v1/holds` | Hold a window for `ttl_seconds` (up to 7 days) |
| `GET /v1/holds/{hold_id}` | One live hold; `GET /v1/resources/{resource_id}/holds` lists them |
| `POST /v1/holds/{hold_id}/confirm` | Turn the hold into a reservation |
| `DELETE /v1/holds/{hold_id}` | Release the hold |
| `GET /v1/reservations/{reservation_ref}` | The booking at its current revision |
| `GET /v1/resources/{resource_id}/reservations?start=…&end=…` | Its bookings in a window |
| `PUT /v1/reservations/{reservation_ref}` | Book (`revision: 1`) or move (the current revision plus 1) |
| `DELETE /v1/reservations/{reservation_ref}?revision=…` | Cancel, at the current revision plus 1 |
| `PUT /v1/resources/{resource_id}/coverage/{source}` | Record that `source`'s events are complete for a window |
| `GET /v1/tenant/events?resource_id=…&start=…&end=…` | Every key's events on a resource, with the `id` the next two take |
| `GET /v1/tenant/events/{event_id}` | One of them |
| `DELETE /v1/tenant/events/{event_id}?expected_revision=…` | Cancel it, whichever key wrote it |
| `GET /v1/tenant` | The key's tenant, and whether it is suspended |
| `POST /v1/tenant/erase` | Erase the tenant, when the server allows it |
| `POST /v1/maintenance` | Run [maintenance](#operations) for the key's tenant |

```sh
curl -X PUT "http://localhost:8080/v1/reservations/BK-42" \
  -H "Authorization: Bearer $SLOTLOCK_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"resource_id":"<id>","start":"2027-03-29T09:00:00Z","end":"2027-03-31T09:00:00Z",
       "buffer_after_minutes":60,"revision":1}'
```

- A taken window answers `409 overlap`. `buffer_after_minutes` keeps the time after a reservation
  busy for holds and other reservations alike.
- Every write is safe to retry: the same reservation at its current revision answers
  `replayed: true`, a confirmed hold confirms again, and a cancelled reference stays cancelled (a
  late booking for it answers `409`). A late copy of a booking or a move that has since been
  superseded answers `409 stale_revision`.
- A confirmed hold is the booking whose reference is the hold's id, at revision 1: cancel it with
  `DELETE /v1/reservations/{hold_id}?revision=2`.
- `POST /v1/holds` and `DELETE /v1/tenant/events/…` take a retry identity as the `Idempotency-Key`
  header or as `idempotency_key`. A retried hold answers the hold the first request made; the same
  key with another request is `422 idempotency_conflict`. Other routes are safe to retry as they
  are, and refuse the header (`400 idempotency_key_not_supported`).
- Lists page by `limit` (up to 100) and `cursor`, the `next_cursor` of the page before, and read a
  window of at most 367 days.
- The time a calendar event occupies is the event's: reservation calls never find, move or cancel
  it, whatever reference they name. Change the event instead, or cancel it as the tenant with
  `DELETE /v1/tenant/events/{event_id}`, which needs its revision and an idempotency key, and
  takes `expected_resource_id` to fence it to the resource you read it on.
- Erasing a tenant over the API is off unless the backend is created with `tenantErasure: true`
  (`slotlock serve` leaves it off: its operator runs `slotlock tenant erase`). It needs
  `confirm_tenant_ref` to be the tenant's reference (`GET /v1/tenant`), deletes every key the tenant
  has, the caller's included, and is refused while the tenant is suspended. Suspending a tenant is
  never an API call: only the schema owner may, and a tenant could not lift its own.
- The tenant is the key's. Another tenant's resource or hold is `404`, whatever the database role.
- With the library, pass `application` beside `rest: true`:
  `{ backend: createSlotlockStoreApplicationBackend(store, { maxTenantResources }), authorize }`.
  A principal with `scopes` needs `admin`; then `authorize` decides.

### Changes and webhooks

Every committed change to a tenant's holds, bookings, calendar events and configuration is recorded
in the same transaction (by a database trigger, so no write path skips it), and nothing is recorded
that did not commit. A change carries ids, times and states, never titles, descriptions, attendees,
webhook URLs or secrets.

- The types: `hold.created`, `.updated`, `.confirmed`, `.released`, `.expired`;
  `reservation.created`, `.updated`, `.cancelled`, `.checked_in`, `.no_show`; `event.created`,
  `.updated`, `.cancelled`, `.timezone_shifted`, `.timezone_conflict`; `waitlist.offered`,
  `.expired`; `coverage.stale`; and configuration: `resource.created`, `resource.updated` (booking
  and check-in rules, pool, bookable hours, time zone or reference, with `before` and `after` of
  only the fields that changed), `resource.archived`, `.restored`, `.deleted`; `coverage.recorded`
  (a source's first read; reading it again is not a change) and `coverage.deleted`. A `coverage.*`
  change names its source by `source_id` (also its `subject`), a digest of the tenant and the source
  that `slotlock_get_coverage` and `slotlockCoverageSourceId` give too, never the source itself,
  which can be an iCalendar URL with a token or an address;
  `webhook.created`, `.enabled`, `.disabled`, `.deleted` (the id and `event_types`, never the URL);
  `key.created`, `.rotated`, `.revoked` (the id, scopes and expiry, never the key, its digest,
  prefix or name). `SLOTLOCK_CHANGE_TYPES` lists them.
- Each change records who made it (`actor`: the API key or agent), the API key's id (`key_id`) when
  a key made it, and where it came from (`origin`): `mcp`, `a2a`, `rest` (the REST agent routes),
  `application` (the application API), `dashboard`, `dashboard-assistant`, `maintenance`, or
  `library`: code calling the store itself, inside `withTenant` with no `origin` or outside it, and
  any write that names none. Never an address or anything else about a person. A change an earlier
  release recorded has neither (`null`).
- `key_id` is pseudonymous: the key's id, never the key or its name. It stays on the changes the key
  made after the key is revoked or deleted, for as long as the feed keeps them (the retention below,
  and longer while an enabled webhook has still to receive them); erasing the tenant removes them.

- `GET /v1/changes?cursor=…` lists them oldest first as [CloudEvents 1.0](https://cloudevents.io)
  (`io.pylota.slotlock.hold.created`, `.reservation.cancelled`, `.event.updated`, …), with the
  extension attributes `slotlockorigin` and `slotlockkeyid` when the change records them. Follow
  `next_cursor`, which comes back even when nothing is new: it never skips a change, even one whose
  transaction commits after a later one's. Changes are kept 30 days (`SLOTLOCK_RETENTION_DAYS`,
  `retentionDays` in `createSlotlockStore`, 1-3,650, for `serve` and `maintain` alike); a cursor
  that a pruned change came after, whichever server pruned it, answers `410 cursor_expired`. A change keeps who made
  it (`actor`) and a booking's or waitlist entry's reference: keep references opaque, not emails,
  when the feed is kept long. A shorter retention never shortens how long a retried write is
  answered as the first was: that stays at least 30 days.
- `POST /v1/webhooks` with an https `url` (and `event_types`, optionally) sends each change from
  then on as a [Standard Webhooks](https://www.standardwebhooks.com) request: `webhook-id` (the
  change's id, the same on every retry), `webhook-timestamp` and `webhook-signature`, keyed by the
  `whsec_` secret the call returns once. `event_types` takes any of the types above. Verify it with any Standard Webhooks library, and use
  `webhook-id` to drop a repeat: delivery is at least once.
- Changes go to each webhook in order, one at a time, until one fails; that one is retried after
  5 seconds, 5 minutes, 30 minutes, 2, 5, then every 10 hours. After a day of failures, or a `410`,
  the webhook is disabled and the feed records `webhook.disabled`; `POST /v1/webhooks/{id}/enable`
  resumes it where it stopped, or answers `409 changes_pruned` when what it missed is older than the
  feed keeps (add it again and read what it missed from `/v1/changes`). The feed keeps every change
  an enabled webhook has still to receive, however old. At most 10 webhooks per tenant.
- Each request has 15 seconds in all, and a tenant's pass 30 seconds; tenants are delivered 8 at
  a time, so a slow endpoint holds up only its own tenant.
- History reads the same record backwards, with who made each change (`actor`, `key_id`), where
  from (`origin`) and, for a change of an existing booking, event or resource, what it was before:
  `GET /v1/resources/{id}/history` (its bookings, events and its own configuration),
  `GET /v1/reservations/{reference}/history`, `GET /v1/tenant/events/{id}/history`, newest first,
  paged by `before`. In the library, pass `actor`, `origin` and `keyId` to `withTenant` (`origin`
  defaults to the enclosing call's, else `library`; `createSlotlockApiKeyAuthenticator` gives the
  principal its `keyId`), and `actor` and `origin` to the API key store's `create`, `rotate` and
  `revoke`; read `listHistory`. It is kept as long as the feed and erased with
  the tenant.
- When time zone rules change (a new tzdata), a booking's instant and the wall time it was made for
  part: Winnipeg's 09:00 is no longer the instant stored. Slotlock keeps both, and maintenance finds
  future one-off events whose wall time moved: it reports each once (`event.timezone_shifted`, with
  the instant it has and the one its wall time now means). The library's `followZoneRules` option
  to `maintainSlotlockTenant` moves them instead, as a new revision, unless that overlaps another
  booking (`event.timezone_conflict`; it stays, for a person or an agent to decide). `/healthz`
  reports the `tzdata` the server runs.
- Feed health: `GET /v1/resources/{id}/coverage` shows each source (and its `source_id`, as the feed
  names it), its window, when it was last read,
  its last error (`POST /v1/resources/{id}/coverage/{source}/failure` records one) and whether it is
  stale (not read for a day, so the time it covers is unproven, never free). A source that goes stale
  is put on the feed once, as `coverage.stale`, until it is read again. Retire a sync you have
  disconnected or replaced with `DELETE /v1/resources/{id}/coverage/{source}` (`deleteCoverage`):
  nothing waits on it after that, `requireCertain` included.
- `slotlock serve` delivers (`SLOTLOCK_WEBHOOKS`): never to an address on a private network, which
  it checks when it connects, and following no redirect. `private` allows those, for testing.
- In the library: `listChanges`, `createWebhookEndpoint` and the rest are store methods, and
  `startSlotlockWebhookDelivery` with `deliverSlotlockWebhooks` runs delivery in your own process.

## Connect an agent

MCP and A2A are wire protocols, so an agent in any language connects with its own MCP or A2A client
to `/mcp` or `/a2a`, the API key as a bearer token. The examples below use TypeScript. Code that
calls Slotlock directly, without an agent, can use the [REST clients](clients/README.md) for
Python, Go, Rust, Java and .NET.

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
  --header "Authorization: Bearer $SLOTLOCK_API_KEY"
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

The card declares `streaming`. `SendStreamingMessage` with any skill streams its reply as one
message. With `slotlock_watch_resources` (`{"resource_ids": [...]}`, up to 20) it streams a watch:
a task in `TASK_STATE_WORKING` naming the resources it can see, then a status update
`{"resource_id", "uri"}` each time one's free/busy changes, from the same feed and under the same
caps as MCP subscriptions, until `TASK_STATE_COMPLETED` (its duration, shutdown) or
`TASK_STATE_FAILED` (access withdrawn). Closing the stream ends it; the task is not kept, so
`SubscribeToTask` and `GetTask` do not find it. Push notifications are not offered: a tenant's
changes reach a URL as signed webhooks.

### MCP Apps

Read-only tools link to `ui://slotlock/calendar`, a self-contained calendar view that hosts
supporting MCP Apps (`io.modelcontextprotocol/ui`) render in a sandbox. It makes no network requests
and never writes.

A person can pick a slot in it. After `slotlock_find_available_slots` or a certain
`slotlock_find_next_available`, the view shows a strip of days and each day's times by morning,
afternoon and evening, or the one next available time. Picking a time and pressing *Book this time*
sends one chat message naming the resource id and the slot's start and end. The agent books it with
`slotlock_create_event`, through confirmation if `SLOTLOCK_CONFIRM_WRITES` asks for it. The message
carries nothing else from the result. If the host refuses the message, the view shows the text to
send instead. Write tools are marked `visibility: ["model"]`, so a host never lets a view call them.

The view takes its look from the host: its light or dark theme and its standard MCP Apps style
variables (colours, fonts, sizes). It shows times in the person's locale, clock and time zone, with
a 12h/24h switch.

## Operations

Every tenant needs maintenance at least daily: it extends recurring events to the rolling horizon
and prunes what the retention window no longer needs, which is what returns agent quota.

- `slotlock serve` maintains `SLOTLOCK_TENANT` when it starts and every tenant whose key it serves,
  then each hourly, one tenant at a time. It logs a `maintenance` line with counts.
- `slotlock maintain` runs one tenant's maintenance now, for cron or after a bulk import. An admin
  key can call `POST /v1/maintenance`.
- Each pass holds a per-tenant PostgreSQL advisory lock, so servers and cron jobs never repeat each
  other's work; a pass that finds the lock taken does nothing.

In a process of your own:

<!-- example: examples/maintenance.ts#maintenance -->
```ts
import { type SlotlockStore, maintainSlotlockTenant } from 'slotlock';

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  // Extends recurring events to the rolling horizon, then prunes past the retention window, each in
  // at most ten batches. `capped: true` means work was left: run another pass.
  return maintainSlotlockTenant(store, tenantRef, { batches: 10 });
}
```

- **Every tenant.** Forced RLS hides other tenants from the application role, so iterate your own
  tenant list. `startSlotlockMaintenance({ store, sql, tenants, intervalMs })` is the scheduler
  `serve` uses, lock included; `withSlotlockMaintenanceLock` is the lock alone.
- **Capped passes.** A capped pass that extended and pruned nothing met only series it cannot extend
  (counted in `conflicts` and `refused`). The roll puts each behind every series it has not put
  back, for an hour, so with `rollPending: true` (it stopped before those) run another pass at once:
  it meets new ones, and a healthy series is reached however many are stuck. Otherwise another pass
  would meet the same ones, so wait for the next interval.
- **Paging the roll yourself.** `rollCalendarEventHorizon` returns `next`; pass it as `after` to the
  next batch of the same pass, so later batches go on from the last series examined. Series the
  roll has never put back come first, then those it has, longest waiting first.
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
- **Erasure.** `slotlock tenant erase --confirm <tenant>`, or the store's `eraseTenant({ tenantRef })`,
  deletes everything the tenant owns in one transaction, waiting for its transactions in flight:
  resources, holds, bookings, events with their attendees and reminders, cancellations,
  idempotency records, coverage, API keys, and a personal tenant's dashboard records. Call it from
  your own erasure workflow; nothing is deleted table by table. Only the API keys' SHA-256 digests
  stay, with nothing about the tenant, so an erased key is never accepted again. The dashboard's
  other records hold no tenant and expire within 12 hours; a form record carries a SHA-256 digest
  of the GitHub user id that sent it, and an accepted write confirmation a digest of its nonce.

### Production checklist

1. PostgreSQL with TLS, backups and point-in-time recovery.
2. Deploy as the owner; serve as a `NOBYPASSRLS` role granted by `grantApplicationRole`
   (`slotlock serve` refuses a superuser or `BYPASSRLS` role).
3. Run every call inside `withTenant`; test isolation with a `NOBYPASSRLS` role.
4. Verify provider webhooks before normalizing them; keep provider credentials out of Slotlock.
5. Bound retries on serialization failures; never blindly retry an unknown write.
6. Reconcile external calendars with durable cursors and coverage windows.
7. Monitor conflicts, refused rules, sync lag, capped maintenance runs, quota errors and confirmation outcomes.
8. Keep writes confirmation-gated wherever your policy needs a person (`slotlock serve`:
   `SLOTLOCK_CONFIRM_WRITES`, `none` by default).
9. Size live updates: one indexed feed query per second per tenant with an open subscription (four
   a second while its feed is busy), at most one backend read a second per subscription a change
   touches, and at most `maxTotal` backend reads per `pollIntervalMs`.
10. Give each agent its own API key with the narrowest scope and an expiry.
11. After each deployment, check it end to end with a short-lived admin key, then revoke the key:
    `SLOTLOCK_URL=https://… SLOTLOCK_ADMIN_KEY=… node scripts/smoke-deployment.mjs`, from a clone
    of the repository, checks health,
    discovery, MCP, A2A, holds and reservations (in a resource named `slotlock-smoke`, 400 days
    ahead, cancelled after) and the 401, 409, 413 and 415 refusals.
12. Rate-limit every public server. `slotlock serve` does it per client address, key, tenant and
    server (`SLOTLOCK_LIMITS`); behind a proxy, set `SLOTLOCK_TRUSTED_PROXY_HEADER` and firewall
    the server so nothing reaches it except through that proxy. Embedding the
    agent server, give it a `consumeRateLimit`. Watch serve's `refusals` log line for floods.
13. On an upgrade, migrate first, then, as a library user, run `grantApplicationRole` again right
    after `applySchema` and before serving traffic: a release that adds a table (the leading-buffer
    release adds `booking_rule_defaults`, which every booking reads) fails every booking with a
    permission error until the serving role is granted it. `slotlock migrate` does both. A migration
    that rebuilds a constraint holds its table's lock for the whole build (see the CHANGELOG's
    Upgrading notes).
14. Bound how long a transaction may run. A store over your own transaction (a savepoint per call)
    keeps its locks and its snapshot for as long as yours runs, and a hold you confirm inside it is
    judged by the statement's clock, not the transaction's. On PostgreSQL 17 and later, give the
    serving role a `transaction_timeout` above your longest legitimate transaction
    (`ALTER ROLE slotlock_app SET transaction_timeout = '60s'`): PostgreSQL ends one that runs
    longer, rolling back what it did, and closes its connection (the pool opens another). On 16, set `idle_in_transaction_session_timeout`
    and `statement_timeout`, which bound idle gaps and single statements but not the whole.

## Supported versions

| | Version |
| --- | --- |
| MCP | 2026-07-28 (stateless), 2025-11-25, 2025-06-18 |
| A2A | 1.0, JSON-RPC binding |
| MCP Apps | `io.modelcontextprotocol/ui` 2026-01-26 |
| Node.js | ≥ 22.12 (CI: 22 and 24; the image runs 24) |
| PostgreSQL | 16, 17 and 18 (CI runs the database suites on each; Compose ships 18) |
| postgres (peer) | ^3.4.5 |

## Project status and boundaries

Slotlock is availability maths, holds and reservations, events with recurrence, coverage-aware
free/busy, tenant isolation, iCalendar interchange, MCP and A2A with human confirmation and live
updates, an MCP Apps view, REST with the application API, scoped API keys, a GitHub sign-in
dashboard, maintenance, and clients for five languages. [Hosted Slotlock](docs/hosted/README.md),
not open yet, will run it for you. Provider sync (Google, Microsoft, CalDAV), notifications to people, and a human
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
