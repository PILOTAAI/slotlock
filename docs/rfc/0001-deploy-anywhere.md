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
npx slotlock deploy vps --domain calendar.example.com
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

1. **VPS:** one command on a fresh machine with Docker serves the API and dashboard over HTTPS on the
   given domain, with Postgres on the same machine.
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
| Maintenance takes a **session** advisory lock per tenant (`maintenance.ts`, `pg_try_advisory_lock`) on a reserved connection | Hyperdrive lists advisory locks and per-session state as unsupported | Replace it with a lease row (`tenant_ref`, `holder`, `expires_at`), claimed with `UPDATE … WHERE expires_at < now()`. This also works behind PgBouncer in transaction mode |
| Maintenance runs on `setInterval` | No timers outside a request | A Cron Trigger calls the same `maintainSlotlockTenant` pass, with a lease, for the tenants due |
| Every tenant transaction takes **transaction** advisory locks (`store.ts`, `ddl.ts`) | Also on Hyperdrive's unsupported list, but released at commit, which is all a transaction pooler needs | **Gate:** prove on real Hyperdrive before anything else is built (see [Spike](#spike-gates-the-rest)) |
| Rate limits in process memory (`rate-limit.ts`) | Many isolates, each with its own memory | Workers rate limiting bindings bound floods across isolates, as the dashboard's three do. The per-isolate caps stay as a second line. The README says these counts are per location and approximate |
| Refusal log flushed on `setInterval` | No timers outside a request | Flush from `ctx.waitUntil` after a refused request |
| Live updates (`subscriptions/listen`) poll on timers inside an SSE stream | Allowed: an HTTP Worker has no wall-clock limit while the client stays connected | None expected; covered by the spike |
| `node:crypto`, `node:async_hooks`, `node:net` | Available with `nodejs_compat` (on by default from 2026-08-04, as the dashboard relies on) | None |
| `slotlock migrate` | DDL and its lock must not go through a pooler | The deploy command runs `migrate` directly against the database, as its owner, before it deploys the Worker |

CPU: the Workers Free plan allows 10 ms per request, too little for validation and recurrence
expansion. The Cloudflare target requires Workers Paid, where the default limit is 30 s.

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

**VPS**, run on the machine itself:
1. Write `.env` with generated secrets (as `scripts/quickstart-env.sh` does today).
2. Run `docker compose --profile https up -d`. A new `caddy` service in that profile takes the
   domain, gets a certificate from Let's Encrypt or ZeroSSL over ports 80 and 443, and proxies to
   the server. The server keeps listening on the machine only.
3. Register the sign-in app as above, with a callback on the domain.
4. Wait for `https://<domain>/healthz` and print the same URLs.

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
  only on `127.0.0.1`, and it stops after one use.
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
5. A request's 5 connections under load; the error a 6th gets.
6. Sign-in through a GitHub App's user authorization, created from a manifest, with the dashboard
   unchanged.

If 1 fails, the API stays off Workers. The Cloudflare target is then only the dashboard Worker
plus a VPS-hosted API, and this RFC is revised before any other work starts.

## Delivery

| PR | Contents | Proof |
| --- | --- | --- |
| 1 | The spike's results added to this RFC | Script and output in the PR |
| 2 | Maintenance lease row in place of the session lock | DB suites: two maintainers race, one wins, the lease expires and is reclaimed; PgBouncer in transaction mode |
| 3 | `workers/server`: API, dashboard and cron on Workers | A CI job runs the agent, REST and dashboard suites against `wrangler dev` (workerd), with a local Hyperdrive string pointing at CI's Postgres |
| 4 | `slotlock deploy cloudflare` | A stand-in Cloudflare API: one create per resource; a re-run changes nothing; a failed run resumes |
| 5 | `--profile https` and `slotlock deploy vps` | A CI job brings Compose up with Caddy on an internal CA and checks HTTPS reaches `/healthz` and `/dashboard` |
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
