---
title: Security model
seoTitle: 'Security model: tenants, API keys and row-level security'
description: How Slotlock keeps agent writes safe. An MCP client can ask its person to confirm each one, PostgreSQL decides every overlap, and forced row-level security keeps tenants apart.
---

Three rules hold everywhere: the database decides overlaps, the tenant comes from the authenticated
caller, and an agent's write can be made to wait for a person.

## Confirmation before writes

With `confirmation`, a listed write first asks the person a yes/no question that says exactly what
will change, such as `Book vehicle-42 for 2027-03-29 10:00–11:00 (Europe/London): "Vehicle
handover".` Only an explicit yes runs the write.

- A booking that leaves the time free (`transparency: 'transparent'`) says so, and a write names
  the other fields it sets (`also description, attendees`) without quoting them.
- Facts come first: the resource by its own reference, times in its own zone, and an event as it
  stands now, read through your backend's `describeResource` and `getEvent` when the caller may
  read them (within 2 seconds in all). Otherwise things are named by id, and each time carries its
  UTC offset. The agent's own text comes last, quoted.
- A repeating booking says how many times it books, the first and the last, and each moved
  occurrence, from the same expansion the store books with; a change to one says it covers every
  repeat. Agents may send RFC 5545 rules that repeat daily or less often and can occur.
- The pending question is sealed (HMAC-SHA256) to the caller, the tool and the exact arguments, and
  expires after `ttlSeconds` (600).
- Clients that cannot ask (MCP 2025 revisions, A2A) get `confirmation_required`; nothing is written.
- The yes comes from the client: Slotlock relies on the MCP client to ask its person, and a key
  holder's own client can answer for itself. Confirmation keeps an agent from writing unasked; it is
  not an authorization boundary. Scopes and `authorize` decide who may write.
- `secrets` holds 1 to 8 keys of 32+ bytes: list the new one first to rotate. `onEvent` reports each
  outcome for audit.

## Tenant isolation

<!-- include SPEC.md#tenant-isolation body -->

- `grantApplicationRole` refuses a serving role that could leave row-level security: superuser,
  `BYPASSRLS`, ownership of anything, `CREATE` anywhere, or `TRUNCATE`, `REFERENCES` or `TRIGGER` on
  a Slotlock table.
- Deployment functions pin `search_path`, and refuse a `slotlock` schema another role controls.
- External calendar content is untrusted: parsing is bounded, and agents get busy time, not
  content.
- Your application still owns authentication, authorization, rate limiting, TLS, provider secrets
  and erasure.

[SECURITY.md](https://github.com/PILOTAAI/slotlock/blob/main/SECURITY.md#security-model) has the full
threat model, including what the role check does not read.

## Dashboard sign-in

- Sign-in asks GitHub for no scope (`read:org` with [organizations](/docs/dashboard/#organizations)),
  uses `state` and PKCE, and keeps only the GitHub user id and login (and, with organizations, the
  served ones the person belongs to, or with `enabled` up to 20 of theirs). The GitHub token is
  used once and dropped.
- A session is a signed, HttpOnly cookie that lasts 12 hours. The allowlist
  (`SLOTLOCK_DASHBOARD_USERS`) is checked on every request, dashboard and API alike.
- Every form carries a token bound to the session and must come from the server's own origin. The
  pages run no inline script, under a Content-Security-Policy that allows only their own files.
- A callback works once, a signed-out cookie stays out, and a reloaded form does not create or
  rotate a key twice. Each is recorded in PostgreSQL as a SHA-256 digest, kept until its cookie or
  form expires (12 hours at most), so this holds on every server sharing the database, behind any
  load balancer; a form record also carries a digest of the GitHub user id that sent it. The server
  role reaches them only through two SECURITY DEFINER functions, and `serve` refuses to start the
  dashboard until `migrate` has granted them.
- The database's clock decides when a sign-in or session has expired, so servers whose clocks drift
  from it or from each other cannot let a replay or a signed-out session through.

## Live updates

At most {{subscriptionsPerPrincipal}} open streams per caller and {{subscriptionsTotal}} per server.
Each re-read checks the caller's credentials again, so a revoked token ends its stream.

## Quotas and retention

Each agent may keep {{eventQuota}} events and {{commandQuota}} idempotency records, so one agent cannot fill the
database. Pruning frees quota; it is not erasure. See
[Operations](/docs/operations/).

## Report a vulnerability

<!-- include SECURITY.md#report-a-vulnerability body -->
