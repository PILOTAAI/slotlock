# Hyperdrive spike (RFC 0001)

This spike asks whether Slotlock's API can run on Workers. It runs Slotlock's real store through a
Worker's Hyperdrive binding and checks what the API relies on, as listed in
[RFC 0001](../../docs/rfc/0001-deploy-anywhere.md#spike-gates-the-rest):

| Check | What it proves |
| --- | --- |
| 1a–1d | Transaction advisory locks: exclusive ones queue, shared ones overlap, a rollback releases its lock, and no lock outlives its transaction |
| 2a–2b | Row-level security: each tenant sees only its own rows, and no tenant setting or row reaches a later request on a reused connection |
| 3a–3b | The exclusion constraint: an overlap is refused with the same code as on a direct connection, and of ten racing bookings exactly one wins |
| 4 | A server-sent event stream keeps its client for `SPIKE_STREAM_SECONDS` (600) and sees a write made halfway through |
| 5 | Eight database clients at once in one request |
| Control | A session advisory lock that is never released, as `maintenance.ts` takes today. The run reports whether it outlives its request; the RFC's maintenance lease exists because a pooler keeps it |

`worker.ts` only reports what happened. `run.mjs` judges each result, prints a Markdown table, and
writes the raw answers to `results.json`.

## On your Cloudflare account

You need a Workers Paid account, Node.js 22.12+ and `psql`. You also need a PostgreSQL 16+ that
Hyperdrive can reach over TLS and that holds nothing you need, for example a new Neon or Supabase
project. The run creates the `slotlock` schema in it.

1. Build Slotlock and install Wrangler:
   ```sh
   npm ci && npm run build               # at the repository root
   cd spikes/hyperdrive && npm ci && npx wrangler login
   ```
2. As the database's owner, create the application role, plus `btree_gist` if the provider doesn't
   create it for you:
   ```sh
   read -rs APP_PASSWORD                 # not on the command line, so not in your shell history
   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v pw="$APP_PASSWORD" <<'SQL'
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   CREATE ROLE slotlock_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'pw';
   SQL
   ```
3. Create the Hyperdrive configuration for that role with caching off, then put the id it prints
   in `wrangler.jsonc`:
   ```sh
   npx wrangler hyperdrive create slotlock-spike --caching-disabled \
     --connection-string "postgres://slotlock_app:$APP_PASSWORD@<host>:5432/<database>?sslmode=require"
   ```
4. Deploy with a token of your own:
   ```sh
   printf 'SPIKE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars && chmod 600 .dev.vars
   npx wrangler deploy --secrets-file .dev.vars
   ```
5. Run the checks. Check 4 takes 10 minutes.
   ```sh
   set -a; . ./.dev.vars; set +a
   SPIKE_URL=https://slotlock-hyperdrive-spike.<subdomain>.workers.dev \
   SPIKE_OWNER_URL="$OWNER_URL" \
   SPIKE_APP_URL="postgres://slotlock_app:$APP_PASSWORD@<host>:5432/<database>?sslmode=require" \
     node run.mjs
   ```
6. Paste the table into the RFC's Spike results section.
7. Check 6 has no script. Create a GitHub App from a manifest, sign in to the dashboard with its
   client id and secret, and record what happened.
8. Delete it all:
   ```sh
   npx wrangler delete
   npx wrangler hyperdrive delete <id>
   ```
   Then drop the database.

## Locally

With no Cloudflare account, `wrangler dev` runs the same Worker in workerd, the Workers runtime.
Its Hyperdrive binding then connects straight to the database. Put PgBouncer in transaction mode in
between and the pooler half is close to what Hyperdrive does:

```sh
printf 'SPIKE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$APP_URL" npx wrangler dev --port 8789
set -a; . ./.dev.vars; set +a
SPIKE_URL=http://127.0.0.1:8789 SPIKE_OWNER_URL="$OWNER_URL" SPIKE_APP_URL="$APP_URL" \
  SPIKE_STREAM_SECONDS=60 node run.mjs
```
