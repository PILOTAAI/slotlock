# Hosted Slotlock

Hosted Slotlock (Slotlock Cloud) is `slotlock serve` run for you by TREFT LTD (Pylota): sign in with
GitHub, create a key, and point an agent at it. Nothing to install and no database to run. Any GitHub
account can sign in. Self-hosting stays fully supported: see
[Self-host with Docker](/README.md#self-host-with-docker).

| | |
| --- | --- |
| API (MCP, A2A, REST) | `https://slotlock-api.pylota.io` |
| MCP | `https://slotlock-api.pylota.io/mcp` |
| A2A | `https://slotlock-api.pylota.io/a2a`, agent card at `/.well-known/agent-card.json` |
| REST | `https://slotlock-api.pylota.io/v1`, described at `/openapi.json` |
| Dashboard | `https://app.slotlock.pylota.io/dashboard` |
| Status | [Open `status` issues](https://github.com/PILOTAAI/slotlock/issues?q=is%3Aissue%20label%3Astatus%20is%3Aopen), and [how they are raised](/docs/hosted/status.md) |
| Price | Free while it is a preview, best effort, with no service level agreement |

## Start

1. Sign in at `https://app.slotlock.pylota.io/dashboard` with your GitHub account. Slotlock asks
   GitHub for no permissions and keeps only your user id and login. By signing in you agree to the
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

## How it differs from running it yourself

- Your account is a tenant of its own, `github:<your user id>`: only your keys reach its data.
- **Writes take effect at once.** Hosted Slotlock does not ask a person to confirm a write; if your
  agent should ask someone first, it asks before it calls the tool. Self-hosters can turn
  confirmation on with `SLOTLOCK_CONFIRM_WRITES`.
- It runs one released version: `https://slotlock-api.pylota.io/healthz` and the agent card
  (`/.well-known/agent-card.json`) say which. Changes to the API follow
  [VERSIONING.md](/VERSIONING.md), with 90 days' notice before anything under `/v1` changes.
- Your data is stored in the United Kingdom, on OVHcloud's London servers, behind Cloudflare.

## Limits

| What | Limit |
| --- | --- |
| Active API keys per account | 100 (1,000 kept in all, revoked and expired ones included) |
| Resources added in the dashboard | 100 |
| Resources per account through the application API | 10,000 |
| Events one key can hold, active and cancelled | 1,000 |
| Event writes one key can have on record | 10,000, each kept 30 days |
| A free/busy or search window | 367 days |
| A hold | 7 days |
| A request body | 256 KiB |
| Live-update streams | 4 at once per key, each watching up to 20 resources for up to 15 minutes |

Requests are also rate limited, per client address, per key and per account: a request over a limit
gets `429 rate_limited` with a `Retry-After` header. A write that would pass a limit is refused with
an error code that names it.

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
