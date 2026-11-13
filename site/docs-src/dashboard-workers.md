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
| Developer | 100 | 100 | 10 | £5 a month or £50 a year |
| Team (a shared workspace's) | 500 | 100 | 25 | £15 a month or £150 a year, for the workspace |
| Custom | Your servers | | | Talk to the founder |

`scripts/configure-stripe.mjs` sets up the Stripe account, the same way in the sandbox and in live
mode, and changes only what differs when run again: the Developer and Team products (with the tax
code Managed Payments needs), their four prices in pounds by lookup key, the webhook endpoint, and a
customer portal configuration for each plan, with the cancellation survey. It prints the Worker's
`SLOTLOCK_STRIPE_PRICE_*` and `SLOTLOCK_STRIPE_PORTAL_*` values.

With `--dashboard-worker <name>` it stores them on the Worker as secrets, which a deploy keeps, in
one `wrangler secret bulk`, so billing never runs half set up. The new webhook endpoint's signing
secret goes with them. So does the dashboard's own key, given as `SLOTLOCK_WORKER_STRIPE_KEY`, once
it has passed its checks: it reads subscriptions and the portal, and opens and expires a Checkout
Session with Managed Payments (nothing is charged, and it shows Managed Payments is on). That key is
stored only if the Worker has, or is given, `STRIPE_WEBHOOK_SECRET`. The script then asks the
dashboard whether it sells. `SLOTLOCK_CHECK_STRIPE_KEY`, once it reads what the launch check reads,
goes to GitHub with `gh secret set`. Run in a terminal, the script asks for any key not set, without
showing it, and no key is printed. Make three restricted keys in Stripe (Developers > API keys >
Create restricted key):

| Key | Permissions | Where it goes |
| --- | --- | --- |
| Setup (`STRIPE_SECRET_KEY` for the script) | Write: Products, Prices, Webhook Endpoints, Customer portal. Read: Balance | Your terminal only; delete it after |
| Dashboard (`SLOTLOCK_WORKER_STRIPE_KEY`) | Write: Checkout Sessions, Customer portal. Read: Subscriptions | The Worker's `STRIPE_SECRET_KEY` |
| Launch check (`SLOTLOCK_CHECK_STRIPE_KEY`) | Read: Products, Prices, Webhook Endpoints, Events | The repository's Actions secret |

```sh
node scripts/configure-stripe.mjs --dry-run                                  # what it would change
node scripts/configure-stripe.mjs --dashboard-worker slotlock-dashboard      # asks for the three keys
```

With `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SLOTLOCK_STRIPE_PRICE_MONTHLY` and
`SLOTLOCK_STRIPE_PRICE_YEARLY` (the Developer prices' ids), the dashboard's **Usage** page sells
plans: **Upgrade** (a Stripe Checkout with Managed Payments, Stripe as merchant of record) and
**Manage billing** (the Stripe customer portal). The Worker refuses to start with the key and prices
but without `STRIPE_WEBHOOK_SECRET`, since a buyer would then be charged and stay on Free. The
webhook endpoint is `<SLOTLOCK_PUBLIC_URL>/stripe/webhook`, with the events
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`. Each signed event
makes the Worker read the subscription from Stripe and set the tenant's plan: `active` or
`trialing` gives the plan, `past_due` keeps it while Stripe retries (a failed payment is shown to
the people who run the service, and closed when it is paid), anything else returns the tenant to
Free. A customer with a subscription that is live or `unpaid` cannot start a second one. Nothing is
deleted when a plan ends; the tenant cannot add more until it is under the Free limits.

`SLOTLOCK_STRIPE_PORTAL_DEVELOPER` and `SLOTLOCK_STRIPE_PORTAL_TEAM` (portal configuration ids,
`bpc_…`) open **Manage billing** in the plan's own configuration. It switches between that plan's
monthly and yearly prices only, never to the other plan: to yearly at once, less what is left of the
month; to monthly at the end of the year paid for. It cancels at the end of the period. Without
them, the account's default configuration applies, which the script leaves without switching.

**Metered overage for Developer** is off. Stripe's test mode takes it: a Managed Payments Checkout
Session with the Developer price and a metered price on a Billing Meter is created, with Managed
Payments on and its own parameter checks passed, and a meter event in Slotlock's form is taken
(checked 2026-11-10). It stays off until the owner pays one test checkout (card 4242 4242 4242
4242), sends a meter event and sees it on the subscription's upcoming invoice, and the Terms say
what overage costs. With `SLOTLOCK_OVERAGE=on` (or a percent,
111-1000; `on` is 300) on the server and the Worker, beside `SLOTLOCK_QUOTAS=on`, a paying Developer
tenant is refused only past that share of its monthly operations; the Worker adds the metered price
`SLOTLOCK_STRIPE_PRICE_OVERAGE` (on a Stripe Billing Meter) to a Developer checkout and shows
`SLOTLOCK_PLAN_PRICE_OVERAGE` on the Usage page. The schema owner then runs, daily and on the 1st for
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

The Team plan is a shared workspace's: a team workspace (`SLOTLOCK_DASHBOARD_TEAM_WORKSPACES`) or
an organization (Teams on Cloud, `SLOTLOCK_DASHBOARD_ORGS=enabled`). It has 500 resources, 100 keys
and 25 webhook endpoints, and monthly quotas its members share (2,000,000 operations and 100,000
bookings, stopping at 110%), for £15 a month or £150 a year whatever the number of members. It is
sold once `SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY` and `SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY` (its price
ids) are set; `SLOTLOCK_PLAN_PRICE_TEAM_MONTHLY` and `SLOTLOCK_PLAN_PRICE_TEAM_YEARLY` change the
prices shown (£15 and £150 by default). A shared workspace is offered Team only, never Developer,
whose limits are a person's: without the Team prices its owners are asked to get in touch, and a
checkout is refused. A subscription gives Team when its price is one of those ids, or says it is
Team's (a lookup key starting `slotlock_team_`, or `slotlock_plan: team` in its or its product's
metadata, as the script sets), so a Team price made later still gives Team. Only Team lifts a team
workspace's limit of 3 people, and a person's limit of one team workspace.

Without Stripe, **Usage** still shows each tenant's plan, limits and use (with `SLOTLOCK_USAGE` and
`SLOTLOCK_QUOTAS`, as on the server), and an owner asks for another plan at `SLOTLOCK_PLAN_CONTACT`.

Optional variables: `SLOTLOCK_PLAN_CONTACT` (where plan and Custom enquiries go, an https or mailto URL),
`SLOTLOCK_PLAN_PRICE_MONTHLY` and `SLOTLOCK_PLAN_PRICE_YEARLY` (the prices as shown, `£5` and `£50`
by default) and `STRIPE_API_VERSION` (default `2026-04-22.dahlia`, a version that has Managed
Payments).

The plan a tenant without one of its own is on is kept in the database, so `slotlock serve` and the
Worker enforce the same limits whichever one a write comes through. Set it once, as the schema owner:

```sh
slotlock plan default free --from 2026-11-16   # every tenant without a plan is on Free from then
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
  isolates, so rate limiting bindings bound them all:
  - `SLOTLOCK_CLIENT_RATE_LIMIT` counts every dashboard request per client address (an IPv6
    client's /64, as `slotlock serve` counts it);
  - `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts sign-ins and callbacks per client network (an IPv6
    client's /48, a site's allocation, as `slotlock serve` counts its sign-ins), so a site rotating
    through its /64s cannot use up the ceiling;
  - `SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT` counts them from every client together, set far above one
    client's limit so a few clients cannot use it up for everyone;
  - `SLOTLOCK_SCIM_RATE_LIMIT`, with SCIM, counts teams' SCIM calls per client address instead of
    `SLOTLOCK_CLIENT_RATE_LIMIT`: an identity provider calls from addresses its other customers
    share, so in the dashboard's budget one team's sync would use up another's. Without it, SCIM
    is counted in `SLOTLOCK_CLIENT_RATE_LIMIT`, and the Worker logs a warning.

  Their counts are per Cloudflare location. Without either of the first two the Worker answers 503.
  Without the ceiling, as in a configuration from before it, `SLOTLOCK_SIGN_IN_RATE_LIMIT` counts
  every client together, and the Worker logs a warning: add the ceiling before lowering that
  binding's limit to one client's. The example configuration also removes query strings (a
  callback's OAuth code) from the URLs Workers Logs keep.
- With organizations, set `SLOTLOCK_DASHBOARD_ORGS` on both the Worker and the server: the server
  takes an organization's keys only while its own list names it (or, with `enabled`, while an
  owner has it turned on), whether or not it serves the dashboard.
- With team workspaces, set `SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on` on both too: the server takes
  a team's keys only with it on, and only while the team exists. To send invitations by email, set
  `SLOTLOCK_INVITATION_EMAIL` and `SLOTLOCK_INVITATION_EMAIL_FROM` as variables and
  `SLOTLOCK_INVITATION_EMAIL_KEY` as a secret (`wrangler secret put`) on the Worker. With verified
  domains, set `SLOTLOCK_VERIFIED_DOMAINS=on` on both: the Worker looks a record up when an Owner
  asks, over DNS-over-HTTPS, and the server's maintenance checks every domain daily. With single
  sign-on, set `SLOTLOCK_TEAM_SSO=on` and `SLOTLOCK_SSO_SECRET` (a secret) on the Worker: signing
  in is the dashboard's, so a server that does not serve the dashboard never reads them. With SCIM,
  set `SLOTLOCK_TEAM_SCIM=on` on the Worker, with the `SLOTLOCK_SCIM_RATE_LIMIT` binding: the
  identity provider calls the dashboard's `/scim/v2`.
- Set `SLOTLOCK_DASHBOARD_USERS` on both the Worker and the server too: the server takes a person's
  keys only while its own list allows them, whether or not it serves the dashboard, so removing a
  person from both lists signs them out and stops their keys. A server without it takes every
  person's keys.
- A missing or weak secret makes the Worker answer 503 and log which variable, never its value.
