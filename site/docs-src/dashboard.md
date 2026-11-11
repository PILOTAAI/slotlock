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

- Its pages: an Overview that leads with what needs a person (bookings waiting for approval, a
  failed payment, a monthly quota nearly or fully used, a plan about to start), then the coming
  week's bookings, events and live holds across every resource (each in its resource's time zone)
  and the latest changes as sentences ("Booking agent booked room-3", repeats counted on one line),
  with Get started until an agent has used a key, the plan's use beside it, and the MCP and A2A
  endpoints;
  Resources, each with its own page for bookable hours, booking rules, profile, pool, location and
  groups, coming bookings and activity; Locations and groups, to add, move and delete them; Waitlist, to see who waits and remove an entry; API keys, with the MCP and A2A
  endpoints; Webhooks, to add, delete and re-enable endpoints and see which are failing; and
  Settings. Everything on them is read from the tenant's own data. `SLOTLOCK_DASHBOARD_NAME` sets
  what the dashboard calls the deployment (Slotlock by default).
- The sign-in page names the terms people accept when `SLOTLOCK_DASHBOARD_TERMS_URL` is an https
  URL, and links the privacy notice from `SLOTLOCK_DASHBOARD_PRIVACY_URL`. Without them it names
  no terms.
- Keys for their agents (read only, read and write, or Full), which they can rotate or revoke. Keys
  made with `slotlock key create` act in `SLOTLOCK_TENANT` instead.
- A person may add 500 resources, or as many as their plan allows on a hosted server. The
  database holds the cap, so adds racing on any number of servers stop at it; a resource they
  already have can still change time zone.
- Bookable hours: the person's own ("Your hours"), each location's (from the Locations page) and
  each resource's, two windows a day, overnight or all day, or closed. A resource without its own
  inherits its location's, then the person's, then the server's (`SLOTLOCK_AVAILABILITY`). The
  Closures page lists closures and special days and adds them. It imports a holiday calendar
  uploaded, pasted or (where the server fetches them) by its address, imported again every 30
  days if asked, and lists the calendars, each deleted with its closures; importing a calendar
  again removes the holidays it dropped.
- The Contacts page lists the people their bookings name to be told about them (kept by their own
  systems through the API), with the channels each agreed to, and forgets one for an erasure
  request.

## Roles

What each person may do in a workspace is their role, read from the database on every request
(`slotlock.workspace_memberships`): a role changed or a membership ended applies at the next
request, never at the next sign-in. Every page and form needs a capability, and one with none is
refused.

| Role | May |
|---|---|
| Owner | Everything: billing, and the workspace itself |
| Admin | All but billing and the workspace itself: Full-access keys, webhooks, anyone's keys, contacts, the assistant's model |
| Developer | Resources, booking rules, hours, the test environment, and read-only or read-write keys of their own |
| Member | Bookings, approvals, the waitlist, hours and closures, and the assistant |
| Viewer | Reads everything, changes nothing; their assistant only reads |
| Billing | The plan, usage and billing |

- A person is the Owner of their own workspace. In an organization's, GitHub's owners are its
  Owners and its other members Developers, recorded at each sign-in.
- Full-access keys, webhooks, billing and the assistant's model also need a sign-in in the last 15
  minutes: past it, the dashboard asks the person to sign in again and comes back to the page.
- A Developer rotates or limits only keys they created, and never a Full-access one.
- **Sign out everywhere** (Settings, Account) ends every session of the person on every device;
  erasing a person ends them too.
- A form needs every capability it touches: rotating someone else's Full-access key needs both
  changing anyone's keys and Full access, and so a recent sign-in.
- An audit log (`slotlock.audit_events`, kept 180 days, 400 on the Team plan) records who created,
  rotated or revoked a key, changed a webhook, the plan, billing or the assistant's model, forgot a
  contact, erased a person, signed in or
  out, changed a team's people, and every refusal, with the address and browser it came from. The
  serving role can only add to it and read it. Owners and Admins read it on Settings, Audit log, 50
  events a page, filtered by action, and export it as CSV or JSON (on the Team plan where plans
  apply; up to 10,000 events, the filter kept); an admin key reads it with `GET /v1/audit` on the
  same terms, and `slotlock audit export` prints it. Each tenant's events are chained: each holds the
  SHA-256 of the one before it with its own content, and the database stamps its time. An event
  changed, removed or taken off the chain in the middle shows where (**Check the log**,
  `slotlock.verify_audit_chain`); someone who rewrites every later hash, or the newest events,
  as the database's owner is not caught by the chain alone, so an export (which carries each
  hash) kept elsewhere is the proof. Retention removes only the start of the chain.
- **Settings, Account** lists where the person is signed in (browser, address, when signed in and
  last seen, to five minutes), and signs any other device out at its next request. Only a digest of
  each session's id is kept (`slotlock.dashboard_sessions`), deleted a day after the session ends.

## Team workspaces

Set `SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on` (on the server, and on the Worker when the dashboard
runs there) for workspaces people make and share, apart from GitHub: each is a tenant of its own,
`team:<id>`. It needs the database the dashboard's roles come from, and does not go with a list of
`SLOTLOCK_DASHBOARD_ORGS`.

- **Create one** on the Teams page: a name is all it asks, and its handle follows from it. Its
  creator is its Owner and lands on Settings, Members. The workspace menu lists each team a person
  is in beside their own workspace.
- **Invite by email**, with a role, on Members. An Owner gives any role; an Admin any up to Admin;
  nobody else invites. Making an Owner or a Billing manager also needs the inviter's own sign-in
  in the last 15 minutes.
- **The link** is shown once to the person who invited, and sent by email where a sender is set:
  `SLOTLOCK_INVITATION_EMAIL` (`resend` or `postmark`), `SLOTLOCK_INVITATION_EMAIL_KEY` (Resend's
  API key or Postmark's server token) and `SLOTLOCK_INVITATION_EMAIL_FROM` (the sender the provider
  verified). The email says who invited whom to what, until when, and nothing else.
  It works once, for seven days, and only for that address: a Google account with it verified, or
  a GitHub account that verifies it (the dashboard asks GitHub for the account's verified
  addresses, `user:email`, only then, and keeps only the invited one, in the session, until the
  person joins). Opening the link consumes nothing, so a mail scanner's visit is harmless; only the
  token's SHA-256 digest is stored. Sending one again makes a new link and ends the old one.
- **Invitations open to a person** also appear on their Teams page to join, without the link.
- **Change a role, remove someone, or leave** on Members. A team always keeps an Owner: the last
  one makes another Owner first, then may step down or leave. Removing someone revokes the keys
  they created, Live and Test, unless the form keeps them. Their next request is refused.
- **Limits**: a team sends at most 50 invitations a day, and so does each person across their
  teams. Where plans apply, each person may create one team on the Free plan, which has up to 3
  people, open invitations included; a team's Owners and Billing managers buy Team for it on Usage.
- **Delete a team** on Settings, Team (its Owners, typing its handle): its keys stop (on every
  server within 30 seconds), every member sees when it goes, and seven days later maintenance
  erases it, live and test, with everything in it. Until then any Owner keeps it, and it takes no
  plan. A team with a subscription is refused until its Team plan is cancelled, and is never
  erased while it has one.
- The server takes a team's keys only with the setting on, and only while the team exists and is
  not being deleted (checked in the database, kept 30 seconds).
- Each person's GitHub login, or the email Google verified, is kept (`slotlock.dashboard_people`)
  to show them to the others in their teams. Invitations keep the address they were sent to until
  30 days after they are accepted, revoked or expire. Erasing a person refuses while they are a
  team's only Owner; erasing a team takes its members and invitations with it.

## Organizations

For organizations instead of people, set `SLOTLOCK_DASHBOARD_ORGS` to the GitHub organization ids
the dashboard serves (`gh api orgs/<login> --jq .id`). Each is then one tenant, `github-org:<id>`,
that its members share: keys, resources and hours.

- A person signs in to the served organizations they are an active owner or member of (a billing
  manager is neither), switching between them when there are several; someone in none of them is
  refused.
- GitHub's owners of the organization are its Owners, and its members Developers (see Roles): a
  member creates read-only or read-write keys and changes only their own; the key list says who
  created each one.
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
- **People and their organizations (Teams on Cloud)**: set `SLOTLOCK_DASHBOARD_ORGS=enabled`.
  Every person signs in to their own tenant, `github:<user id>`, and the dashboard reads which
  GitHub organizations they belong to (`read:org`, up to 20, kept in the session). On its Teams
  page an owner of one turns Slotlock on for it (within 15 minutes of signing in, since who owns
  it is read from GitHub as one signs in); then each owner and member picks it from the
  workspace menu and shares its tenant, `github-org:<id>`, as above. Turning it off (the owner types
  its name) ends every session's use of it at once and stops its keys within 30 seconds on every
  server; what it holds stays, for an owner to turn it on again and erase it. The organizations
  turned on are in `slotlock.dashboard_organizations` (who turned each on or off, and when),
  erased with the organization's tenant. Set it on the server too, which checks the database
  before taking an organization's key.
- **Sign-in with Google too**, for people without a GitHub account: set `SLOTLOCK_GOOGLE_CLIENT_ID`
  and `SLOTLOCK_GOOGLE_CLIENT_SECRET` (an OAuth client of a Google Cloud project, of type Web
  application, with the same redirect URI, `<SLOTLOCK_PUBLIC_URL>/dashboard/callback`). The sign-in
  page then offers Continue with Google. Each such person is their own tenant,
  `google:<subject>` (Google's stable account id); `SLOTLOCK_DASHBOARD_USERS` names them as
  `google:<subject>` beside GitHub ids, or `*` lets every account in. Sign-in asks for `openid
  email`, uses `state`, PKCE and a nonce, and checks the ID token Google's token endpoint returns:
  its RS256 signature against Google's published keys (kept as long as Google's answer says, and
  read again for a key id it does not know), then its issuer, audience, expiry and nonce. It keeps the subject, and the email only once Google has
  verified it, to show who is signed in. Google sign-in does not go with a list of
  `SLOTLOCK_DASHBOARD_ORGS` (GitHub's organizations); with `enabled`, a Google person has their own
  tenant only.

## Assistant

With `SLOTLOCK_ASSISTANT_SECRET` set (32+ random characters, `openssl rand -hex 32`), the dashboard
gains an **Assistant** page where every member chats with a model their organization connects
("what's free tomorrow on van-7?", "book it for Ana") instead of clicking. Each organization brings
its own model.

- **Connect it** in Settings, Assistant (owners only; with personal tenants, each person): a
  provider (Anthropic, OpenAI, OpenRouter, Google, Mistral, Groq or Together, each bringing its own
  URL and API format), or Custom with its API format (`Anthropic Messages`, or
  `OpenAI-compatible`, which covers OpenAI, OpenRouter, vLLM, Ollama and LM Studio), and its base
  URL (the one ending in `/v1`, like `http://localhost:11434/v1`; https, or http only on `localhost`
  or `127.0.0.1`); then the model
  name (`your-model`, or one from **Load models**) and the API key, which a local model may not
  need. **Test** makes one real request and shows the result in place.
- **Private addresses are refused.** As with webhooks, a URL whose host is, or resolves to, a
  loopback, private, link-local, shared (CGNAT), unique-local or metadata address
  (`169.254.169.254`) is refused, when it is saved and at each connection (the address the socket
  connects to is checked, so a name rebound to one is refused too), and the page says why. For a
  self-hosted model on the server's own machine or network (Ollama, vLLM), the operator sets
  `SLOTLOCK_ASSISTANT_PRIVATE_URLS=on`. On Cloudflare Workers the literal check applies and names
  are not resolved: a Worker's fetch reaches no private network.
- **The key goes only where it was entered for.** Changing the provider or the base URL takes the
  key again (decided in the database write, so racing saves cannot get past it), even on an origin
  that serves several accounts. **Test** makes one real request and checks the model answers with
  one correct tool call; the result shows beside it.
- **The organization's data is sent to the provider it configures**: its messages, and the bookings
  and resources the assistant reads.
- **The key** is stored sealed with AES-256-GCM under a key derived from
  `SLOTLOCK_ASSISTANT_SECRET`, bound to the organization, in `slotlock.assistant_settings` (forced
  row-level security, erased with the tenant). The dashboard shows only that it is set and its last
  four characters.
- **Changing the secret** without losing the keys: set the new value as `SLOTLOCK_ASSISTANT_SECRET`
  and the old one in `SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS` (up to three, comma-separated, newest
  first). A key sealed under an old secret still opens, and is sealed again under the new one the
  next time its organization uses the assistant, only if no owner has saved another key since.
  Remove an old secret once every organization has used the assistant since; a key still sealed
  under a secret no longer listed cannot be opened, and its owners enter it again.
- **Reads run, writes wait.** The server runs the tool loop, up to 8 model calls a message, with a
  fixed list of the agent tools (the reads: resources, free-busy, next free time, slots, pool
  availability, events; the writes: holds, bookings, pool and bundle bookings, changes and
  cancellations). A read runs at once through the same operation boundary as an agent's. A write
  never runs when the model asks: it appears as a proposed change the member approves (or
  declines) with a form, and only then runs, once (its idempotency key is the dashboard's), with
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
- **Replies stream.** The dashboard's script reads the turn from `POST <root>/assistant/stream`, one
  JSON object a line (the reply's text as it comes, each tool step as it starts and ends, then the
  turn as the page renders it), and Stop ends it. Without script, the form posts and the page
  shows the reply. Replies are Markdown, rendered escaped (links http(s) only).
- **Chats.** Each conversation is a chat a member keeps (`slotlock.assistant_chats`), titled by its
  first message, at its own address (`<root>/assistant?c=<id>`), and listed beside the conversation
  shown: most recent first, grouped by day, with a search box, and **Rename** and **Delete** behind
  each one's menu. **New chat** starts another. The page opens on the chat used in the past two
  hours, else on a new one. Chats are kept until the member deletes one, at most 100 per member
  (past that, the least recently used goes), and are bounded in UTF-8 bytes. With
  `conversationTtlMs`, a deployment gives them a lifetime instead: then they are deleted that long
  after their last message, by `serve`'s maintenance (every quarter hour, every tenant), by
  `slotlock maintain`, and whenever a member's chats are read (so on Workers too). Upgrading from
  0.8 makes each member's conversation their first chat.
- **What the model is told.** The workspace's resources agents can see (up to 50, by id, name,
  reference, kind, location and time zone) come with every message, so the model matches a resource
  the member names to its id without a lookup; it finds others with `slotlock_list_resources` and
  `query`.
- On Workers, the assistant's agent calls are capped at 24 a request and by `tenant_read` and
  `tenant_write` of `SLOTLOCK_LIMITS` in each isolate.
- A provider's failure is shown as a plain message, never with the key or the provider's answer.
- It works as plain forms: no script is needed.

## Usage

On hosted Slotlock, **Usage** shows the workspace's plan (or the plan it moves to, and when) against
its limits, this month's operations, bookings and holds against its quotas, and which key used what.
It says what needs doing first: a failed payment, a quota at 80%, at 100% or used up, or as many
resources, keys or webhooks as the plan (or the coming plan) allows, or more (nothing is removed;
adding another is refused). Each of these, and an add refused at a limit, offers an owner the
upgrade; the Overview says the same. An owner can move up: **Upgrade** where Stripe sells plans (paid through Stripe, in your currency, with tax
added where it applies; **Manage billing** for invoices, the payment method and cancelling), else
**Talk to us**. Free allows 10 resources, 10 API keys and 2 webhook endpoints; Developer 100, 100
and 10. In Test, it shows Test's own use. A self-hosted dashboard has no Usage page.

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
