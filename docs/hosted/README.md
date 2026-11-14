# Hosted Slotlock

Hosted Slotlock (Slotlock Cloud) is `slotlock serve` run for you by TREFT LTD (Pylota): sign in with
GitHub or Google, create a key, and point an agent at it. Nothing to install and no database to run.
Any GitHub or Google account can sign in. Self-hosting stays fully supported: see
[Self-host with Docker](/README.md#self-host-with-docker).

| | |
| --- | --- |
| API (MCP, A2A, REST) | `https://slotlock-api.pylota.io` |
| MCP | `https://slotlock-api.pylota.io/mcp` |
| A2A | `https://slotlock-api.pylota.io/a2a`, agent card at `/.well-known/agent-card.json` |
| REST | `https://slotlock-api.pylota.io/v1`, described at `/openapi.json` |
| Dashboard | `https://app.slotlock.pylota.io/dashboard` |
| Status | [The status page](https://stats.uptimerobot.com/F7RQohQzXM), [open `status` issues](https://github.com/PILOTAAI/slotlock/issues?q=is%3Aissue%20label%3Astatus%20is%3Aopen), and [how they are raised](/docs/hosted/status.md) |
| Price | Free, Developer at £5 a month or £50 a year, or, for a team workspace, Team at £15 a month or £150 a year: see [Plans](#plans). Best effort, with no service level agreement |

## Start

1. Sign in at `https://app.slotlock.pylota.io/dashboard` with your GitHub or Google account. With
   GitHub, Slotlock reads your public profile and keeps only your user id, login and profile name;
   it asks for your verified email addresses only when you accept an invitation sent to one. With
   Google, it reads your account's id, email address and name, and keeps only those. By signing in you agree to the
   [Terms of Service](/TERMS.md) and the [Acceptable Use Policy](/ACCEPTABLE-USE.md).
2. Add your resources and their weekly hours, then create an API key: **Read only** for an agent
   that only looks, **Read and write** for an agent that books, **Full** for an application that
   also manages resources, holds and reservations. A key can have an expiry.
3. Connect an agent. Claude Code:

   ```sh
   claude mcp add --transport http slotlock https://slotlock-api.pylota.io/mcp \
     --header "Authorization: Bearer $SLOTLOCK_API_KEY"
   ```

   Over REST: `curl https://slotlock-api.pylota.io/v1/resources -H "Authorization: Bearer $SLOTLOCK_API_KEY"`.
   The [language clients](/clients/README.md) work the same way.

## Plans

| | Free | Developer | Team | Custom |
| --- | --- | --- | --- | --- |
| Price | Free | £5 a month, or £50 a year | £15 a month, or £150 a year, for the whole team | [Talk to the founder](mailto:clever.eziogor@pylota.io) |
| Resources | 10 | 100 | 500 | On your own servers |
| Active API keys | 10 | 100 | 100 | |
| Webhook endpoints | 2 | 10 | 25 | |
| Operations a month | 25,000 | 500,000 | 2,000,000, shared | |
| Bookings a month | 1,000 | 25,000 | 100,000, shared | |
| People in a team workspace | Up to 3, open invitations included | Up to 3, as on Free | No limit | |

**Team** is for a shared workspace: a team workspace you create on the dashboard's **Teams** page,
or a GitHub organization an owner has turned Slotlock on for (the dashboard's Teams
page). Everyone in it shares its resources, keys and history, and its price does not change with how
many people use it. On Free, each person may create one team workspace (one being deleted counts
until it goes), with up to 3 people, open invitations included; Developer, a person's plan, does not change that, and Team lifts the limit. Only the workspace's Owners and Billing managers buy or
manage it.

Every account starts on Free. Upgrade on the dashboard's **Plan** page: Stripe takes the payment as
merchant of record, in your currency, with any sales tax or VAT added. **Manage billing** on the same
page shows invoices, changes the payment method, switches between monthly and yearly, and cancels.
A cancelled plan runs to the end of the period it was paid for. When a plan ends or a payment is not
made, the account returns to Free: nothing is deleted, but nothing more can be added while it holds
more than Free allows. Archived resources count until they are deleted. The limits hold however you
add things: in the dashboard, over the API or from the language clients. Accounts created before
9 November 2026 move to the Free limits on 16 November 2026. An account on Developer is erased only
once its plan is cancelled, so it is never charged again. Custom is Slotlock on your own
infrastructure, under its own agreement.

### Monthly allowances

From 16 November 2026, each plan allows so many operations and bookings a calendar month, in UTC:

- **An operation** is a call that runs: an MCP tool call, an A2A task or a REST request, the
  assistant's included. A request refused before it runs (bad arguments, a rate limit) is not one.
- **A booking** is a reservation, a calendar event (a whole recurring series is one) or a confirmed
  hold.
- At 80% and 100% of either, your account's change feed records `usage.threshold_reached`, which
  your webhooks receive, and the dashboard's Overview and Usage pages say so.
- **On Free**, past an allowance, calls are refused with `429 quota_exceeded` and a `Retry-After`
  header until the month ends: every call once the operations are used up, except reading your
  usage (`GET /v1/usage`) and erasing your account, and only new bookings and holds (an approval
  granted among them) once the bookings are, so you can still read, cancel and decline.
  **On Developer and Team** the same happens at 110% of an allowance. Nothing is charged for use
  past one.
- Every answer to an operation lists what is left this month in its `RateLimit` and
  `RateLimit-Policy` headers (`"operations_month"` and `"bookings_month"`), and `GET /v1/usage`
  and the dashboard's Usage page show the month so far.

## Assistant

The dashboard's **Assistant** page lets you operate Slotlock by chat ("what's free tomorrow on
room-3?", "book it for Ana") with a model you bring:

- **Connect your own model** in Settings, Assistant: the Anthropic Messages API, or any
  OpenAI-compatible API (OpenAI, OpenRouter, and others that answer tool calls), with its base
  URL, the model name and your API key. Choosing a provider (Anthropic, OpenAI, OpenRouter, Google,
  Mistral, Groq, Together) brings its URL and API format; Custom takes both. **Load models** asks
  your provider which models it offers. **Test** makes one real request. You pay your provider for what the model uses;
  Slotlock does not charge for it.
- **Your key** is stored encrypted (AES-256-GCM) and never shown again: only that it is set, and its
  last four characters.
- **What goes to your provider:** your messages, and the resources and bookings the assistant reads
  to answer them, under your own agreement with that provider.
- **Reads run, writes wait.** The assistant looks things up at once, up to 8 model calls a message.
  A booking, hold, change or cancellation appears as a card to **Approve** or **Dismiss**, and runs
  once, when approved, under the same booking rules and limits as an agent, recorded as "Assistant
  for @login". It cannot touch API keys, webhooks, booking rules, pools or erasure.
- **Bounds:** 10 messages a minute per person.
- **Chats:** each conversation is kept as a chat, titled by its first message, until you delete it
  (or the account is erased), up to 100 per person; past that, the least recently used goes.
  Rename or delete one from its menu in the Chats list.
- **The model must be reachable from the internet.** Slotlock Cloud refuses model addresses on
  loopback, private and metadata networks, so a model on your own machine (Ollama, LM Studio) needs
  a public HTTPS address, or a hosted provider.

## How it differs from running it yourself

- Your account is a tenant of its own, `github:<your user id>`: only your keys reach its data.
- **Writes take effect at once.** Hosted Slotlock does not ask a person to confirm a write; if your
  agent should ask someone first, it asks before it calls the tool. Self-hosters can turn
  confirmation on with `SLOTLOCK_CONFIRM_WRITES`.
- It runs one released version: `https://slotlock-api.pylota.io/healthz` and the agent card
  (`/.well-known/agent-card.json`) say which. Changes to the API follow
  [VERSIONING.md](/VERSIONING.md), with 90 days' notice before anything under `/v1` changes.
- Your data is stored in the United Kingdom, on OVHcloud's London servers, behind Cloudflare, with
  encrypted backups in Cloudflare R2's European Union jurisdiction. The
  [privacy notice](/PRIVACY.md) says what is kept and for how long.

## Limits

| What | Limit |
| --- | --- |
| Active API keys per account | As the [plan](#plans) allows (1,000 kept in all, revoked and expired ones included) |
| Resources and webhook endpoints per account | As the plan allows |
| Events one key can hold, active and cancelled | 1,000 |
| Event writes one key can have on record | 10,000, each kept 30 days |
| A free/busy or search window | 367 days |
| A hold | 7 days |
| A request body | 256 KiB |
| Live-update streams | 4 at once per key, each watching up to 20 resources for up to 15 minutes |

Requests are also rate limited, per client address, per key and per account: a request over a limit
gets `429 rate_limited` with a `Retry-After` header. A write that would pass a limit is refused with
an error code that names it. Each plan's [monthly allowances](#monthly-allowances) are refused with
`429 quota_exceeded`.

## Rules and data

- [Terms of Service](/TERMS.md) and [Acceptable Use Policy](/ACCEPTABLE-USE.md).
- [Privacy notice](/PRIVACY.md): what is stored, for how long, and how to have it erased.

## Help

| For | Contact |
| --- | --- |
| Questions and account help | [support@pylota.io](mailto:support@pylota.io) |
| Bugs and feature requests | [GitHub issues](https://github.com/PILOTAAI/slotlock/issues) (public: never paste a key) |
| Abuse of the service | [abuse@pylota.io](mailto:abuse@pylota.io) |
| Privacy and erasure | [privacy@pylota.io](mailto:privacy@pylota.io) |
| Security vulnerabilities | Privately, as [SECURITY.md](/SECURITY.md) describes, never in an issue |
