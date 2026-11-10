---
title: Dashboard
description: Let people sign in with GitHub and manage their own resources, bookable hours and API keys, alone or as an organization, with an optional assistant.
sidebar:
  label: Dashboard
---

The server can serve a dashboard at `/dashboard`. Each person signs in with GitHub and gets a tenant
of their own (`github:<user id>`): their resources, hours, keys and bookings are theirs alone, so
you can give each person API keys without running `slotlock key create` for them.
[Slotlock Cloud](/docs/hosted/) serves it at `https://app.slotlock.pylota.io/dashboard`; this page
is for turning it on in your own server.

## Turn it on

1. **Create a GitHub OAuth app.** On GitHub: Settings → Developer settings → OAuth Apps → New OAuth
   App. Set the callback URL to `<SLOTLOCK_PUBLIC_URL>/dashboard/callback`, then generate a client
   secret.
2. **Set four variables** in `.env` (or the server's environment):

   | Variable | Value |
   | --- | --- |
   | `SLOTLOCK_GITHUB_CLIENT_ID` | The OAuth app's client id |
   | `SLOTLOCK_GITHUB_CLIENT_SECRET` | Its client secret |
   | `SLOTLOCK_SESSION_SECRET` | 32+ random characters: `openssl rand -hex 32` |
   | `SLOTLOCK_DASHBOARD_USERS` | GitHub user ids that may sign in, comma-separated (`gh api users/<login> --jq .id`), or `*` for anyone |

3. **Restart** with `docker compose up --detach` (or run `slotlock serve`), then open
   `<SLOTLOCK_PUBLIC_URL>/dashboard`.

With all four empty, the default, the dashboard is off. To run it as a Cloudflare Worker apart from
the server, see [Dashboard on Cloudflare Workers](/docs/dashboard-workers/).

## What people can do

- Its pages: an Overview with the coming week's bookings, events and live holds across every
  resource (each in its resource's time zone) and the latest changes agents made, named by key;
  Resources, each with its own page for bookable hours, booking rules, pool, coming bookings and
  activity; Waitlist, to see who waits and remove an entry; API keys, with the MCP and A2A
  endpoints; Webhooks, to add, delete and re-enable endpoints and see which are failing; and
  Settings. Everything on them is read from the tenant's own data. `SLOTLOCK_DASHBOARD_NAME` sets
  what the dashboard calls the deployment (Slotlock by default).
- Keys for their agents (read only, read and write, or Full), which they can rotate or revoke. Keys
  made with `slotlock key create` act in `SLOTLOCK_TENANT` instead.
- A person may add 100 resources. The database holds the cap, so adds racing on any number of
  servers stop at 100; a resource they already have can still change time zone.
- Each resource uses the server's bookable hours (`SLOTLOCK_AVAILABILITY`) until its owner sets its
  own on the hours page: two windows a day, overnight or all day, or closed. One form sets them for
  every resource at once.

## Organizations

For organizations instead of people, set `SLOTLOCK_DASHBOARD_ORGS` to the GitHub organization ids
the dashboard serves (`gh api orgs/<login> --jq .id`). Each is then one tenant, `github-org:<id>`,
that its members share: keys, resources and hours.

- A person signs in to the served organizations they are an active owner or member of (a billing
  manager is neither), switching between them when there are several; someone in none of them is
  refused.
- Every member has the same power: each can create, rotate and revoke the organization's keys, and
  the key list says who created each one.
- Membership is read at each sign-in, so a person who leaves keeps the dashboard until their
  session ends (12 hours at most), and keys they made work until revoked. Removing an id from the
  list signs its sessions out and stops its keys at once.
- An organization that restricts OAuth apps must approve the dashboard's app (its Settings,
  Third-party access), or GitHub hides the membership.
- `SLOTLOCK_DASHBOARD_USERS` still says who may sign in at all, and a key records the person who
  created it (`github:<user id>`): erasing that person's own tenant leaves it on keys they made in
  an organization, which go with the organization's erasure.
- Only the first 100 memberships GitHub lists, and the first 20 served organizations by login, are
  read.

## Assistant

With `SLOTLOCK_ASSISTANT_SECRET` set (32+ random characters, `openssl rand -hex 32`), the dashboard
gains an **Assistant** page where every member chats with a model their organization connects
("what's free tomorrow on van-7?", "book it for Ana") instead of clicking. Each organization brings
its own model.

- **Connect it** in Settings, Assistant (owners only; with personal tenants, each person): the
  provider (`Anthropic Messages API`, or `OpenAI-compatible`, which covers OpenAI, OpenRouter,
  vLLM, Ollama and LM Studio), the base URL (`https://api.anthropic.com`, or the one ending in
  `/v1`: `https://api.openai.com/v1`, `http://localhost:11434/v1`; https, or http only on
  `localhost` or `127.0.0.1`), the model name (`your-model`) and the API key, which a local model
  may not need.
- **Private addresses are refused.** As with webhooks, a URL whose host is, or resolves to, a
  loopback, private, link-local, shared (CGNAT), unique-local or metadata address
  (`169.254.169.254`) is refused, when it is saved and at each connection (the address the socket
  connects to is checked, so a name rebound to one is refused too), and the page says why. For a
  self-hosted model on the server's own machine or network (Ollama, vLLM), the operator sets
  `SLOTLOCK_ASSISTANT_PRIVATE_URLS=on`. On Cloudflare Workers the literal check applies and names
  are not resolved: a Worker's fetch reaches no private network.
- **The key goes only where it was entered for.** Changing the provider or the base URL takes the
  key again (decided in the database write, so racing saves cannot get past it), even on an origin
  that serves several accounts. **Test connection** makes one real request and checks the model
  answers with one correct tool call.
- **The organization's data is sent to the provider it configures**: its messages, and the bookings
  and resources the assistant reads.
- **The key** is stored sealed with AES-256-GCM under a key derived from
  `SLOTLOCK_ASSISTANT_SECRET`, bound to the organization, in `slotlock.assistant_settings` (forced
  row-level security, erased with the tenant). The dashboard shows only that it is set and its last
  four characters. Changing the secret makes stored keys unreadable: owners enter them again.
- **Reads run, writes wait.** The server runs the tool loop, up to 8 model calls a message, with a
  fixed list of the agent tools (the reads: resources, free-busy, next free time, slots, pool
  availability, events; the writes: holds, bookings, pool and bundle bookings, changes and
  cancellations). A read runs at once through the same operation boundary as an agent's. A write
  never runs when the model asks: it appears as a proposed change the member approves (or
  dismisses) with a form, and only then runs, once (its idempotency key is the dashboard's), with
  the same booking rules, tenant limits and rate limits as an agent, recorded as
  `dashboard-assistant:github:<user id>` (shown as "Assistant for @login").
- **The card** leads with the sentence a confirmation would ask (the resource by name, the times in
  its zone, and for a change or cancellation the event's title, resource and time as it stands)
  and then shows every argument in full; a change too large to show (16 KB of arguments) is not
  proposed, and a conversation has at most 4 waiting. A proposal is only checked: the series-write
  slot and the write's rate token are taken when the approved change runs.
- **Bounds.** A message's reads share a budget of 16 calls and 400 resource-days. API keys,
  webhooks, booking rules, pools, erasure and coverage are never offered; a tool the model names
  outside the list is refused. Tool results and booking data are data to the model, never
  instructions, and the system prompt says so; the tool list does not change with what the model
  says. A member may send 10 messages a minute; each model call has 30 seconds and a message 90.
- **Conversations** are kept per member in `slotlock.assistant_conversations` for 2 hours after the
  last message, then deleted: by `serve`'s maintenance, which sweeps every tenant's expired
  conversations every quarter hour (a tenant only the dashboard serves included), by
  `slotlock maintain`, and whenever the tenant's conversations are read (so on Workers too). They
  are bounded in UTF-8 bytes; **New conversation** forgets one.
- On Workers, the assistant's agent calls are capped at 24 a request and by `tenant_read` and
  `tenant_write` of `SLOTLOCK_LIMITS` in each isolate.
- A provider's failure is shown as a plain message, never with the key or the provider's answer.
- It works as plain forms: no script is needed.

## Before you go live

- Give the dashboard an origin of its own (`https://slotlock.example.com`, not a path beside other
  apps): its cookies are host-wide, so any other app on the same origin could read them.
- Removing someone from `SLOTLOCK_DASHBOARD_USERS` and restarting signs them out and stops every key
  in their tenant at once.
- Sessions last 12 hours. The database's clock decides when they expire, but keep the server's
  clock in sync with it all the same: a server more than 12 hours ahead of the database cannot sign
  anyone in.
- A person may have 1,000 forms recorded at once (12 hours' worth); past that the dashboard answers
  429 until the oldest expire. Signing out always works.

[Security model](/docs/security/#dashboard-sign-in) says how sign-in, sessions and forms are
protected.
