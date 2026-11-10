---
title: Dashboard on Cloudflare Workers
description: Run the dashboard as a Cloudflare Worker at an origin of its own, reaching the server's database through Hyperdrive, while agents keep using the server.
sidebar:
  label: Dashboard on Workers
---

The same [dashboard](/docs/dashboard/) can run as a Cloudflare Worker at an origin of its own
(`workers/dashboard`), while agents keep using the server. It shows the server's MCP and A2A URLs
(`SLOTLOCK_SERVICE_URL`), and reaches the server's database through Hyperdrive, as the role the
server serves as.

`workers/dashboard/wrangler.jsonc` is an example: copy it into your own deployment and replace what
it marks as yours. This repository's Dashboard workflow only checks that the Worker bundles. Deploy
from your own pipeline with your own Cloudflare token: a token that can deploy Workers can replace
this one and read its session secret, which signs in as any tenant.

## Deploy it

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
3. Create the GitHub OAuth app as [for the server](/docs/dashboard/#turn-it-on), with the callback
   URL `<SLOTLOCK_PUBLIC_URL>/dashboard/callback` on the Worker's origin.
4. Store the secrets on the Worker: `npx wrangler secret put` for `SLOTLOCK_GITHUB_CLIENT_ID`,
   `SLOTLOCK_GITHUB_CLIENT_SECRET` and `SLOTLOCK_SESSION_SECRET`, and `SLOTLOCK_ASSISTANT_SECRET`
   for the assistant.
5. Deploy: `npm ci --omit=dev` at the repository root (the Worker bundles Slotlock's sources), then
   `npx wrangler deploy --config <your configuration>` in `workers/dashboard`.

## How it runs

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
- Set `SLOTLOCK_DASHBOARD_USERS` on both the Worker and the server too: the server takes a person's
  keys only while its own list allows them, whether or not it serves the dashboard, so removing a
  person from both lists signs them out and stops their keys. A server without it takes every
  person's keys.
- A missing or weak secret makes the Worker answer 503 and log which variable, never its value.
