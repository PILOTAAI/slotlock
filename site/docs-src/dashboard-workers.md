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
   For plans and billing (hosted Slotlock), also `STRIPE_SECRET_KEY` (a restricted key: write on
   Checkout Sessions and Customer portal, read on Subscriptions) and `STRIPE_WEBHOOK_SECRET`; see
   [Plans and billing](#plans-and-billing).
#### Plans and billing

Hosted Slotlock sells plans; self-hosted Slotlock writes no plan and keeps the server's limits.

| Plan | Resources | Active API keys | Webhook endpoints | Price |
| --- | --- | --- | --- | --- |
| Free | 10 | 10 | 2 | Free |
| Developer | 100 | 100 | 10 | $10 a month or $100 a year |
| Team (an organization's) | 500 | 100 | 25 | $40 a month or $400 a year, for the organization |
| Custom | Your servers | | | Talk to the founder |

With `STRIPE_SECRET_KEY`, `SLOTLOCK_STRIPE_PRICE_MONTHLY` and `SLOTLOCK_STRIPE_PRICE_YEARLY` (the
Developer prices' ids), the dashboard gains a **Plan** page: the tenant's plan and use, **Upgrade**
(a Stripe Checkout with Managed Payments, Stripe as merchant of record) and **Manage billing** (the
Stripe customer portal). Point a Stripe webhook endpoint at `<SLOTLOCK_PUBLIC_URL>/stripe/webhook`
with the `checkout.session.completed` and `customer.subscription.*` events and store its signing
secret as `STRIPE_WEBHOOK_SECRET`. Each signed event makes the Worker read the subscription from
Stripe and set the tenant's plan: `active` or `trialing` gives Developer, `past_due` keeps it while
Stripe retries, anything else returns the tenant to Free. Nothing is deleted when a plan ends; the
tenant cannot add more until it is under the Free limits.

**Metered overage for Developer** is off. Stripe's test mode takes it: a Managed Payments Checkout
Session with the Developer price and a metered price on a Billing Meter is created, with Managed
Payments on and its own parameter checks passed, and a meter event in Slotlock's form is taken
(checked 2026-11-10). It stays off until the owner pays one test checkout (card 4242 4242 4242
4242), sends a meter event and sees it on the subscription's upcoming invoice, and the Terms say
what overage costs. With `SLOTLOCK_OVERAGE=on` (or a percent,
111-1000; `on` is 300) on the server and the Worker, beside `SLOTLOCK_QUOTAS=on`, a paying Developer
tenant is refused only past that share of its monthly operations; the Worker adds the metered price
`SLOTLOCK_STRIPE_PRICE_OVERAGE` (on a Stripe Billing Meter) to a Developer checkout and shows
`SLOTLOCK_PLAN_PRICE_OVERAGE` on the Plan page. The schema owner then runs, daily and on the 1st for
the month before:

```sh
STRIPE_SECRET_KEY=sk_live_… slotlock overage report                 # this month so far
STRIPE_SECRET_KEY=sk_live_… slotlock overage report --month 2026-10 --event slotlock_operations
```

It sends Stripe a meter event for each paying Developer tenant's operations above its quota that
have not been sent, and records the total in `slotlock.overage_reports` first, so an operation is
never billed twice (a run that stops halfway bills too little, and the next run does not catch up
on it). An event Stripe already took, whose answer was lost, counts as sent when it is sent again.
It exits 1 while an event was not taken; run it again.

The Team plan is an organization's (Teams on Cloud, `SLOTLOCK_DASHBOARD_ORGS=enabled`): 500
resources, 100 keys and 25 webhook endpoints, and monthly quotas its members share (2,000,000
operations and 100,000 bookings, stopping at 110%), for $40 a month or $400 a year whatever the
number of members. It is offered once `SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY` and
`SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY` (its price ids) are set; `SLOTLOCK_PLAN_PRICE_TEAM_MONTHLY` and
`SLOTLOCK_PLAN_PRICE_TEAM_YEARLY` change the prices shown ($40 and $400 by default); an
organization's owner then sees Upgrade to Team instead of Developer, and a subscription at a Team
price gives Team, including one changed to it in the customer portal.

Optional variables: `SLOTLOCK_PLAN_CONTACT` (where Custom enquiries go, an https or mailto URL),
`SLOTLOCK_PLAN_PRICE_MONTHLY` and `SLOTLOCK_PLAN_PRICE_YEARLY` (the prices as shown, `$10` and `$100`
by default) and `STRIPE_API_VERSION` (default `2026-04-22.dahlia`, a version that has Managed
Payments).

The plan a tenant without one of its own is on is kept in the database, so `slotlock serve` and the
Worker enforce the same limits whichever one a write comes through. Set it once, as the schema owner:

```sh
slotlock plan default free --from 2026-12-09   # every tenant without a plan is on Free from then
slotlock plan status                           # the default, and SLOTLOCK_TENANT's own plan
```

Until `--from`, tenants that already have a key, a resource or a webhook keep the server's limits; a
new tenant is put on the default plan before it adds its first one. `slotlock plan default none`
removes the default. A tenant on a paid plan cannot be erased until the subscription is cancelled
(`billing_active`).

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
  takes an organization's keys only while its own list names it (or, with `enabled`, while an
  owner has it turned on), whether or not it serves the dashboard.
- Set `SLOTLOCK_DASHBOARD_USERS` on both the Worker and the server too: the server takes a person's
  keys only while its own list allows them, whether or not it serves the dashboard, so removing a
  person from both lists signs them out and stops their keys. A server without it takes every
  person's keys.
- A missing or weak secret makes the Worker answer 503 and log which variable, never its value.
