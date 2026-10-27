# Hosted Slotlock

Hosted Slotlock is `slotlock serve` run for you by TREFT LTD (Pylota): sign in with GitHub, create a
key, and point an agent at it. Nothing to install and no database to run.

| | |
| --- | --- |
| API (MCP, A2A, REST) | `https://slotlock-api.pylota.io` |
| Dashboard | `https://app.slotlock.pylota.io` |
| Status | [Open `status` issues](https://github.com/PILOTAAI/slotlock/issues?q=is%3Aissue%20label%3Astatus%20is%3Aopen), and [how they are raised](/docs/hosted/status.md) |
| Price | Free while it is a preview, best effort, with no service level agreement |

**Not open yet.** 0.3.0, which fixes the [0.2.0 known issues](/README.md#known-issues-in-020), is
released; the service opens once it is deployed here, and this page will say so. Until then the
addresses above do not answer.

## Start

1. Sign in at `https://app.slotlock.pylota.io` with your GitHub account. Slotlock asks GitHub for no
   permissions and keeps only your user id and login.
2. Add your resources and their weekly hours, then create an API key: **Read and write** for an
   agent, **Full** for an application that also manages resources, holds and reservations.
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
