# RFC 0001: Deploy Slotlock to a VPS or to Cloudflare with one command

| | |
| --- | --- |
| Status | Proposed |
| Target | 0.4.0 |
| Decision | GOVERNANCE.md: changes deployment, maintenance locking and the dashboard's sign-in; needs the maintainer's approval and an independent security review of each implementing PR |

## Summary

Anyone can take a Slotlock release and run the API (MCP, A2A, REST) and the dashboard on their own
domain, in one of two places, with one command each:

```sh
npx slotlock deploy vps --ssh root@203.0.113.10 --domain calendar.example.com
npx slotlock deploy cloudflare --domain calendar.example.com --database <postgres url>
```

## Where 0.3.0 stands

| | VPS | Cloudflare |
| --- | --- | --- |
| API | `docker compose up` (CI's Compose quickstart) | Does not run on Workers |
| Dashboard | Built into `slotlock serve` at `/dashboard` | `workers/dashboard`, deployed by hand from a copied wrangler file |
| Your domain and HTTPS | Bring your own TLS proxy (one README line) | Custom Domain on the dashboard Worker only |
| Sign-in app | GitHub OAuth app created by hand | Same |
| Setup | Copy `.env`, fill in values, run Compose | Nine manual steps (README, Dashboard on Cloudflare Workers) |

## Goals

1. **VPS:** one command from a laptop, to a fresh machine with Docker and SSH, serves the API and
   dashboard over HTTPS on the given domain, with Postgres on the same machine.
2. **Cloudflare:** one command from a laptop deploys the API, dashboard and maintenance as one
   Worker, using the deployer's own Cloudflare account and a Postgres database they choose.
3. Both run the same released code, pass the same suites, and keep every guarantee 0.3.0 makes:
   no overlapping reservations, and row-level security per tenant.
4. Running the command again upgrades in place, and changes nothing that is already right.

## Non-goals

- A database other than PostgreSQL (see [Database](#database)).
- Moving Hosted Slotlock (Pylota) onto Workers. It may follow once this ships.
- Kubernetes, Fly, Render and other platforms. The Docker image already runs there.

## Database

Cloudflare has no PostgreSQL of its own. Workers reach PostgreSQL through **Hyperdrive**, which
pools connections to any PostgreSQL 9–18 it can reach over TLS (Supabase, Neon, PlanetScale
Postgres, AWS, GCP and Azure among those it lists), or to a private one through Workers VPC and a
Cloudflare Tunnel. So "on Cloudflare" means the compute is on Cloudflare and the database is one of:

| Database | When |
| --- | --- |
| A managed PostgreSQL (Neon, Supabase, PlanetScale Postgres, RDS…) | No machine to run at all |
| PostgreSQL on your own VPS, reached through a Cloudflare Tunnel | You already run a VPS and want the API at the edge |

**D1 (SQLite) is rejected.** The no-double-booking guarantee is a PostgreSQL exclusion constraint
(`slotlock_reservations_no_overlap`, `EXCLUDE USING gist`). Tenant isolation is 33 `ROW LEVEL SECURITY`
statements, and API keys sit behind 16 `SECURITY DEFINER` functions. D1 has none of these. Porting
would mean re-proving the core guarantees in application code, for a second schema that every
release would then have to keep in step.

## Cloudflare: what has to change in the server

`slotlock serve` already answers through a Fetch handler (`agent-server.ts` `fetch(request)`), and
the dashboard already runs on Workers through Hyperdrive (`workers/dashboard/worker.ts`). These are
the remaining blockers:

| Today | On Workers | Change |
| --- | --- | --- |
| One `postgres` pool per process (`self-host.ts`) | A Worker may not reuse a client from another request | A client per request through Hyperdrive, at most 5 connections, as `workers/dashboard` does |
| Maintenance takes a **session** advisory lock per tenant (`maintenance.ts`, `pg_try_advisory_lock`) on a reserved connection | Hyperdrive lists advisory locks and per-session state as unsupported | Replace it with a lease row, checked by every batch ([Maintenance lease](#maintenance-lease)). This also works behind PgBouncer in transaction mode |
| Maintenance runs on `setInterval` | No timers outside a request | A Cron Trigger calls the same `maintainSlotlockTenant` pass, with a lease, for the tenants due |
| Every tenant transaction takes **transaction** advisory locks (`store.ts`, `ddl.ts`) | Also on Hyperdrive's unsupported list, but released at commit, which is all a transaction pooler needs | **Gate:** prove on real Hyperdrive before anything else is built (see [Spike](#spike-gates-the-rest)) |
| Rate limits in process memory (`rate-limit.ts`) | Many isolates, each with its own memory | Workers rate limiting bindings bound floods across isolates, as the dashboard's three do. The per-isolate caps stay as a second line. The README says these counts are per location and approximate |
| Refusal log flushed on `setInterval` | No timers outside a request | Flush from `ctx.waitUntil` after a refused request |
| Live updates (`subscriptions/listen`) poll on timers inside an SSE stream | Allowed: an HTTP Worker has no wall-clock limit while the client stays connected | None expected; covered by the spike |
| `node:crypto`, `node:async_hooks`, `node:net` | Available with `nodejs_compat` (on by default from 2026-08-04, as the dashboard relies on) | None |
| `slotlock migrate` | DDL and its lock must not go through a pooler | The deploy command runs `migrate` directly against the database, as its owner, before it deploys the Worker |

CPU: the Workers Free plan allows 10 ms per request, too little for validation and recurrence
expansion. The Cloudflare target requires Workers Paid, where the default limit is 30 s.

### Maintenance lease

A pass (`maintainSlotlockTenant`) runs up to `batches` transactions, so a lease claimed once at the
start could expire while the pass is still writing. Instead, every batch fences itself:

- `slotlock.maintenance_leases (tenant_ref primary key, holder uuid, expires_at)`. A pass claims
  the row with `INSERT … ON CONFLICT (tenant_ref) DO UPDATE … WHERE maintenance_leases.expires_at
  < now()`, under a fresh `holder`. No row returned means another holder has it: skip the tenant.
- Each batch's first statement is `UPDATE maintenance_leases SET expires_at = now() + interval
  '5 minutes' WHERE tenant_ref = $1 AND holder = $2 AND expires_at > now()`, in the batch's own
  transaction. No row updated means the lease was lost: the batch rolls back and the pass stops.
  The updated row stays locked until the batch commits. A competing claim waits for that commit,
  then re-reads the renewed `expires_at` and fails, however long the batch took. Correctness never
  rests on a batch finishing within the lease; the lease only decides when a silent holder is
  presumed gone.
- At the end of the pass, the holder releases the lease by setting `expires_at = now()`. A pass
  that crashes leaves a lease that expires on its own.

Test: holder A claims and runs a batch, then pauses past expiry. B claims the lease and runs. When
A resumes, its next batch updates no lease row, writes nothing, and A's pass stops with a
lease-lost result. A second test has B's claim race A's renewal in flight: B waits, then finds the
lease renewed and skips the tenant.

## The Worker

- A new `workers/server` holds the API, the dashboard (at its own hostname) and the maintenance Cron
  Trigger. The npm package publishes it prebuilt as `slotlock/worker`, so deploying needs no clone
  of this repository.
- `workers/dashboard` stays for anyone who runs the API elsewhere.
- The server connects as `slotlock_app` (no ownership, no `BYPASSRLS`) through a Hyperdrive
  configuration with **caching disabled**: a revoked key or a sign-out must take effect at once.

## The deploy command

`slotlock deploy` is a CLI subcommand of the published package. Each step checks what is already
there and leaves it alone, so a second run upgrades, and a failed run resumes.

**Cloudflare**, using an API token the deployer pastes or exports. The token is never written to
disk or sent anywhere but Cloudflare's API:
1. Check the token's scopes and that the account has Workers Paid.
2. Connect to the given database as its owner. Create `slotlock_app` with a generated password,
   then run `migrate`.
3. Create the Hyperdrive configuration (caching off) for `slotlock_app`. With `--tunnel`, create the
   Workers VPC service on that tunnel first.
4. Register the sign-in app: open GitHub's **app manifest** flow in the browser. The deployer only
   names the app; GitHub returns its client id and secret to a one-time local callback.
5. Upload the Worker with its Custom Domains, rate limiting bindings, Cron Trigger and secrets
   (session, confirmation, GitHub). Generated secrets come from the operating system's random
   source and never appear in arguments or output.
6. Wait for `https://<domain>/healthz` and print the MCP URL and the dashboard URL.

**VPS**, run from the deployer's laptop as `slotlock deploy vps --ssh user@host --domain …`. It
drives a machine that has Docker over SSH, so the GitHub step runs in the laptop's browser exactly
as it does for Cloudflare. No repository checkout is needed on either machine:
1. Register the sign-in app on the laptop, as in step 4 above. The manifest's callback is the
   laptop's one-time `127.0.0.1` listener. The app's own sign-in callback is a different URL,
   `https://<domain>/dashboard/callback`, which the dashboard serves once deployed.
2. Over SSH, write `/opt/slotlock/` (or `--dir`):
   - a `compose.yaml` the command ships for its own release. It runs
     `ghcr.io/pilotaai/slotlock:<version>@sha256:<digest>`, pinned by the digest the release
     published, never `build: .`;
   - a `Caddyfile` for the domain;
   - an `.env` (mode 600) with the generated secrets and the GitHub app's, sent on SSH's stdin,
     never in arguments.
3. Run `docker compose up -d` there. The `caddy` service gets the domain's certificate from Let's
   Encrypt or ZeroSSL over ports 80 and 443, and proxies to the server. The server keeps listening
   on the machine only.
4. Wait for `https://<domain>/healthz` and print the same URLs.

Run on the VPS itself without `--ssh`, the command prints one `ssh -L` line to forward the
manifest's callback port from the laptop, and waits for it.

This needs the image at `ghcr.io/pilotaai/slotlock` to be public.

## Security

- **The deploy token can take over the deployment.** A token that can deploy Workers can read
  their secrets and replace their code. The command asks for the narrowest scopes it needs, prints
  them, and tells the deployer to revoke the token afterwards. Nothing is stored.
- **Isolation stays in the database.** RLS is enforced in Postgres for the `slotlock_app` role, the
  same on both targets. The Worker never holds the owner's password: the command uses it once, from
  the deployer's machine.
- **No cached reads.** Hyperdrive caching stays off, so authentication and sign-out are never
  served from a cache. The deploy command refuses a configuration with caching on.
- **The manifest flow is CSRF-protected.** Its `state` is random and checked, its callback listens
  only on `127.0.0.1` on the deployer's laptop (forwarded by SSH when run on the VPS), and it stops
  after one use. The manifest's callback is never a route on the deployed domain.
- **Rate limits are approximate on Workers**, per location and eventually consistent. The README
  says so, and the per-key and per-tenant caps in the database still bound writes.

## Spike (gates the rest)

Run against a real Hyperdrive and PostgreSQL 18 before any implementing PR. Record the results in
this RFC:

1. Transaction advisory locks, shared and exclusive, across two concurrent Worker requests: the
   second waits, and nothing leaks after commit or rollback.
2. `set_config(…, true)` tenant scoping and the RLS suites, run through Hyperdrive.
3. An overlapping reservation is refused with the same error code and message as on a direct
   connection.
4. A `subscriptions/listen` stream stays open for 10 minutes, and still delivers updates.
5. Eight clients at once in one request. A Worker lets six connections wait for their first
   response at a time, and queues a seventh rather than refusing it.
6. Sign-in through a GitHub App's user authorization, created from a manifest, with the dashboard
   unchanged.

If 1 fails, the API stays off Workers. The Cloudflare target is then only the dashboard Worker
plus a VPS-hosted API, and this RFC is revised before any other work starts.

The harness is [`spikes/hyperdrive`](../../spikes/hyperdrive/README.md): a Worker that runs
Slotlock's store through its Hyperdrive binding, and a driver that judges checks 1–5. Check 4's
stream polls free/busy, as a live-updates subscription does, rather than running the full MCP
server, which arrives in delivery PR 3.

### Spike results

**Real Hyperdrive: not run yet.** It needs a Workers Paid account and a throwaway PostgreSQL that
Hyperdrive can reach. The README says how to run it. Its table replaces the local one below, and
gates delivery PR 2 onwards.

**Local, 2026-10-27:** workerd (Wrangler 4.151.2) and PostgreSQL 16. Run once with the binding
connected directly, and once through PgBouncer 1.22 in transaction mode with a pool of 3 server
connections, which reuses connections across requests harder than Hyperdrive's pool does. This
shows that Slotlock's store, its row-level security and its locks run on the Workers runtime and
survive a transaction pooler. It does not show Hyperdrive's own behaviour.

| Check | Direct | Transaction pooler |
| --- | --- | --- |
| 1a exclusive locks wait for each other | pass | pass: second acquired 1 ms after the first released, on another backend |
| 1b shared locks are held together | pass | pass: together for 3,005 ms |
| 1e exclusive waits for shared, and shared for exclusive (`withTenant` against suspension and erasure) | pass | pass: each acquired 1 ms after the other's release |
| 1c a rollback gives its lock up | pass | pass: next request waited 1 ms |
| 1d no advisory lock outlives its transaction | pass | pass: 0 held |
| 2a each tenant sees only its own rows, read with no filter but RLS | pass | pass: each read only its own |
| 2b nothing of a tenant reaches the next request | pass | pass: 20 bare requests as `slotlock_app` saw no setting and no rows |
| 3a overlap refused as on a direct connection | pass | pass: `overlap` both ways |
| 3b ten racing bookings, one wins | pass | pass: 1 booked, 9 `overlap` |
| 4 stream keeps its client and sees a write | pass (8 s) | pass (60 s): busy 0, 0, 1, 1 |
| 5 eight clients at once | pass | pass: the pool of 3 queued them, slowest at 6 s |
| Control: a session lock never released | released when the request ended | **still held** after the request ended |

The control is why the RFC replaces maintenance's session lock with a lease: behind a pooler, a
session lock stays with a server connection after its request ends, and the next client that
connection serves inherits it.

The checks can fail. With row-level security switched off on `slotlock.resources`, 2a fails
(each tenant's unfiltered read returns both tenants' rows) and so does 2b. The store's own reads
filter by tenant, so they alone would have passed. A first version of check 1d counted every
advisory lock in the database, so the control's deliberate leak from an earlier run turned the next
run red. The check now counts only its own run's lock keys.

## Delivery

| PR | Contents | Proof |
| --- | --- | --- |
| 1 | The spike's results added to this RFC | Script and output in the PR |
| 2 | Maintenance lease row in place of the session lock | DB suites: the two lease tests above, a crashed holder's lease reclaimed after expiry, and the same through PgBouncer in transaction mode |
| 3 | `workers/server`: API, dashboard and cron on Workers | A CI job runs the agent, REST and dashboard suites against `wrangler dev` (workerd), with a local Hyperdrive string pointing at CI's Postgres |
| 4 | `slotlock deploy cloudflare` | A stand-in Cloudflare API: one create per resource; a re-run changes nothing; a failed run resumes |
| 5 | `slotlock deploy vps`, its shipped `compose.yaml` and `Caddyfile` | A CI job runs the command from an empty directory outside any checkout, over SSH to a Docker host, with Caddy on an internal CA, and checks HTTPS reaches `/healthz` and `/dashboard`; a re-run changes nothing |
| 6 | README and site: one page, Deploy, with both targets; CHANGELOG | Link check; quickstart steps run in CI |

## Open questions

- Should `slotlock deploy cloudflare` also offer to create a Neon or Supabase database, using that
  provider's API? It would be convenient, but adds one more credential and one more dependency.
- Worker naming and the hostnames: one Worker with two Custom Domains (API and dashboard), or two
  Workers? This RFC assumes one, because one deploy is simpler and both share the same code.

## Sources (read 2026-10-27)

- Workers limits: developers.cloudflare.com/workers/platform/limits (CPU 10 ms Free, 30 s default up
  to 5 min Paid; 128 MB per isolate; no wall-clock limit for HTTP while connected; Cron 15 min).
- Hyperdrive limits and features: developers.cloudflare.com/hyperdrive/platform/limits and
  …/reference/supported-databases-and-features (PostgreSQL 9–18; ~100 origin connections on Paid;
  60 s statements; advisory locks, LISTEN/NOTIFY, PREPARE and per-session state unsupported).
- Cron Triggers: developers.cloudflare.com/workers/configuration/cron-triggers.
- Caddy automatic HTTPS: caddyserver.com/docs/automatic-https.
- GitHub App manifests: docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest.
