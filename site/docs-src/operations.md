---
title: Operations
seoTitle: 'Running Slotlock in production: operations guide'
description: Run Slotlock in production. Maintenance, quotas, retention, erasure and the production checklist.
---

Every tenant needs maintenance at least daily: it extends recurring events to the rolling horizon
and prunes what the retention window no longer needs, which is what returns agent quota.

- `slotlock serve` maintains `SLOTLOCK_TENANT` and every tenant with data when it starts (whether
  or not its keys call), then each hourly, one tenant at a time. It logs a `maintenance` line with
  counts. It finds the tenants through `slotlock.maintenance_tenants(text)`, which lists names
  only; each pass runs in its own tenant's context, under row-level security.
- `slotlock maintain` runs one tenant's maintenance now, for cron or after a bulk import. An admin
  key can call `POST /v1/maintenance`.
- Each pass holds a per-tenant PostgreSQL advisory lock, so servers and cron jobs never repeat each
  other's work; a pass that finds the lock taken does nothing.

In a process of your own:

<!-- code examples/maintenance.ts#maintenance -->

- **Every tenant.** Forced RLS hides other tenants from the application role, so iterate your own
  tenant list. `startSlotlockMaintenance({ store, sql, tenants, intervalMs })` is the scheduler
  `serve` uses, lock included; `withSlotlockMaintenanceLock` is the lock alone.
- **Capped passes.** A capped pass that extended and pruned nothing met only series it cannot extend
  (counted in `conflicts` and `refused`). The roll puts each behind every series it has not put
  back, for an hour, so with `rollPending: true` (it stopped before those) run another pass at once:
  it meets new ones, and a healthy series is reached however many are stuck. Otherwise another pass
  would meet the same ones, so wait for the next interval.
- **Paging the roll yourself.** `rollCalendarEventHorizon` returns `next`; pass it as `after` to the
  next batch of the same pass, so later batches go on from the last series examined. Series the
  roll has never put back come first, then those it has, longest waiting first.
- **Quotas.** Each agent principal may retain 1,000 event identities (active plus cancelled) and
  10,000 idempotency commands, of which 9,000 can be creates or updates, so a cancel always has
  room. Adjust with `agentOwnerEventQuota` and `agentOwnerCommandQuota` on `createSlotlockStore`.
  `pruneCalendarEventRetention` is what returns quota.
- **Retention.** Commands are exact-replay evidence for the replay window, by default
  `SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS` (30) days: pruning deletes older commands for every owner,
  then agent-owned tombstones older than the window with no command left. `internal` tombstones
  (provider and sync authority) are kept until you erase the tenant. After the window a retried
  command is evaluated afresh under its expected revision, and a pruned agent identity can be
  created again. `retentionDays` (1-3650) changes the window; keep it longer than any client retries.
- **Export.** `slotlock tenant export --out <dir>` writes everything the tenant keeps, read at one
  moment, as one `<table>.ndjson` file a table: owner-only files it makes itself, in a new directory
  (made owner-only) or an empty one that is yours and no one else can write. A link there, or a file
  that appears under a table's name, stops it; export again into a new directory. Without `--out`
  it prints `{"table": ..., "row": ...}` lines. Secrets stay out. Over the API,
  `POST /v1/tenant/exports` builds the same into parts kept 24 hours; maintenance deletes expired
  ones and builds any a stopped server left pending.
- **One person.** `slotlock subject export --email <address>` (or `--holder`, `--contact`,
  `--reference`) prints what the tenant keeps about one person, a JSON line per row;
  `slotlock subject erase` with the same option takes them out, leaving bookings as time taken, and
  records `subject.erased` in the audit log without them. The store's `exportSubject` and
  `eraseSubject`, and `POST /v1/subjects/export` and `/erase`, do the same.
- **Audit log.** `slotlock audit verify` checks the workspace audit log's hash chain (exit 1 at the
  first event changed outside Slotlock); `slotlock audit export` prints it, newest first. Events are
  kept 180 days, or 400 on the Team plan. The serving role can neither change nor delete an event
  or a change in the history: both are pruned only by definer functions.
- **Erasure.** `slotlock tenant erase --confirm <tenant>`, or the store's `eraseTenant({ tenantRef })`,
  deletes everything the tenant owns in one transaction, waiting for its transactions in flight:
  resources, holds, bookings, events with their attendees and reminders, cancellations,
  idempotency records, coverage, API keys, and a personal tenant's dashboard records. Call it from
  your own erasure workflow; nothing is deleted table by table. Only the API keys' SHA-256 digests
  stay, with nothing about the tenant, so an erased key is never accepted again. The dashboard's
  other records hold no tenant and expire within 12 hours; a form record carries a SHA-256 digest
  of the person who sent it, and an accepted write confirmation a digest of its nonce. The form
  records of a session a team's single sign-on began alone, and of signing out past the form limit,
  count apart from the person's and stay until they expire.

## Production checklist

1. PostgreSQL with TLS, backups and point-in-time recovery.
2. Deploy as the owner; serve as a `NOBYPASSRLS` role granted by `grantApplicationRole`
   (`slotlock serve` refuses a superuser or `BYPASSRLS` role).
3. Run every call inside `withTenant`; test isolation with a `NOBYPASSRLS` role.
4. Verify provider webhooks before normalizing them; keep provider credentials out of Slotlock.
5. Bound retries on serialization failures; never blindly retry an unknown write.
6. Reconcile external calendars with durable cursors and coverage windows.
7. Monitor conflicts, refused rules, sync lag, capped maintenance runs, quota errors and confirmation outcomes.
8. Keep writes confirmation-gated wherever your policy needs a person (`slotlock serve`:
   `SLOTLOCK_CONFIRM_WRITES`, `none` by default).
9. Size live updates: one indexed feed query per second per tenant with an open subscription (four
   a second while its feed is busy), at most one backend read a second per subscription a change
   touches, and at most `maxTotal` backend reads per `pollIntervalMs`.
10. Give each agent its own API key with the narrowest scope and an expiry.
11. After each deployment, check it end to end with a short-lived admin key, then revoke the key:
    `SLOTLOCK_URL=https://… SLOTLOCK_ADMIN_KEY=… node scripts/smoke-deployment.mjs`, from a clone
    of the repository, checks health,
    discovery, MCP, A2A, holds and reservations (in a resource named `slotlock-smoke`, 400 days
    ahead, cancelled after) and the 401, 409, 413 and 415 refusals.
12. Rate-limit every public server. `slotlock serve` does it per client address, key, tenant and
    server (`SLOTLOCK_LIMITS`); behind a proxy, set `SLOTLOCK_TRUSTED_PROXY_HEADER` and firewall
    the server so nothing reaches it except through that proxy. Embedding the
    agent server, give it a `consumeRateLimit`. Watch serve's `refusals` log line for floods.
13. On an upgrade, migrate first, then, as a library user, run `grantApplicationRole` again right
    after `applySchema` and before serving traffic: a release that adds a table (the leading-buffer
    release adds `booking_rule_defaults`, which every booking reads) fails every booking with a
    permission error until the serving role is granted it. `slotlock migrate` does both. A migration
    that rebuilds a constraint holds its table's lock for the whole build (see the CHANGELOG's
    Upgrading notes).
14. Bound how long a transaction may run. A store over your own transaction (a savepoint per call)
    keeps its locks and its snapshot for as long as yours runs, and a hold you confirm inside it is
    judged by the statement's clock, not the transaction's. On PostgreSQL 17 and later, give the
    serving role a `transaction_timeout` above your longest legitimate transaction
    (`ALTER ROLE slotlock_app SET transaction_timeout = '60s'`): PostgreSQL ends one that runs
    longer, rolling back what it did, and closes its connection (the pool opens another). On 16, set `idle_in_transaction_session_timeout`
    and `statement_timeout`, which bound idle gaps and single statements but not the whole.
