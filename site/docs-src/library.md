---
title: TypeScript library
description: Call Slotlock's engine and PostgreSQL store from your own Node.js code, with no server in between.
sidebar:
  label: TypeScript library
---

The library is what the server runs on. Use it when your Node.js application books time itself.
From another language, use the [REST API](/docs/api/) or a [client](/docs/clients/).

## Install

```sh
npm install slotlock@{{version}} postgres
```

Node.js 22.12+, PostgreSQL 16+ with `btree_gist` (which Slotlock creates if it is missing; CI runs
16, 17 and 18), and `postgres` ^3.4.5 as a peer dependency. TypeScript declarations are included.

## Find a free slot, with no database

The availability maths needs no database:

<!-- code examples/availability.ts#next-slot -->

A rule `expandRules` cannot evaluate adds no availability; it never invents a slot. A search window
may be 367 days at most (`invalid_window`), here and in `findNextAvailableFor`.

## Set up the database

| Role | Owns | Used for |
| --- | --- | --- |
| Deployment | the `slotlock` schema | `applySchema`, `applyTenantRls`, `grantApplicationRole`, once per release |
| Application | nothing (`NOSUPERUSER NOBYPASSRLS`) | all traffic, confined to one tenant by forced row-level security |

Create the application role once, then deploy as the owner:

```sql
CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
```

<!-- code examples/deploy.ts#deploy -->

- `applySchema` is idempotent and safe to run from several instances at once.
- `grantApplicationRole` grants schema usage and DML on Slotlock's tables, and refuses
  (`unsafe_application_role`) a role that could get around row-level security. Run it after every
  `applySchema`. [SECURITY.md](https://github.com/PILOTAAI/slotlock/blob/main/SECURITY.md#security-model)
  lists what it checks.
- `applySchema` refuses a `slotlock` schema another role controls (`unsafe_slotlock_schema`).
- Already have a tenant setting such as `app.tenant_id`? Pass `{ tenantContextSetting:
  'app.tenant_id' }` to `createSlotlockStore`.

## Book time

<!-- code examples/store.ts#connect -->

<!-- code examples/store.ts#book -->

Run every store method inside `withTenant`. A call outside it is not refused: it runs with no tenant
context, so as the application role forced row-level security shows it no rows.

`withTenant` validates the tenant, sets the context transaction-locally on the one connection every
callback call uses, supports nested savepoints, and restores the previous context. Do not issue a
standalone `set_config(..., true)` through a pool: its transaction ends before the next call.
`withTenant(tenantRef, callback, { isolation: 'read committed' })` runs the callback in a READ
COMMITTED transaction whatever the role's default, and refuses inside a caller's transaction of
another level. A store sharing one pool among tenants can bound each tenant's share:
`createSlotlockStore(sql, { maxTenantTransactions, tenantLockTimeoutMs })` runs at most that many
of a tenant's `withTenant` transactions at once (the rest wait in the process, and leave the line
when `withTenant`'s `signal` aborts), and refuses one that waits longer than that for a lock with
`lock_timeout`, safe to retry. `slotlock serve` sets `tenant_transactions` (2) and 5,000.

`createResource({ ..., maxTenantResources })` refuses a new resource (`resource_limit_reached`) once
the tenant has that many (1-100,000); an existing `externalRef` is still updated. Capped creates for
one tenant take a database lock and count under READ COMMITTED, so racing ones stop at the cap on
any number of servers; inside a REPEATABLE READ or SERIALIZABLE transaction they refuse
(`invalid_transaction_isolation`). Uncapped creates take no lock.

`setResourceAvailability({ tenantRef, id, rules })` gives a resource its own bookable hours (`null`
uses the default, `[]` closes it); `setTenantAvailability({ tenantRef, rules })` sets every resource
of a tenant. `createSlotlockStoreAgentBackend` answers from a resource's own hours and calls
`availabilityRules` only for resources without them. [Booking rules](/docs/booking-rules/) say what
a booking on a resource must satisfy.

### Writing rules

- Create with `expectedRevision: 0`; update with the revision you last read and a new idempotency
  key. Replaying the same command and key returns the original result (`idempotent: true`); reusing
  a key with a different payload returns `idempotency_conflict`.
- A conflicting opaque occurrence returns `{ ok: false, code: 'overlap' }`, never a thrown error.
  Transparent events never block.
- Cancelling leaves a tombstone, so a delayed create cannot resurrect the event; use a new external
  reference for a genuinely new event.
- `listCalendarEvents` and `listResources` return at most 1,000 rows and page with keyset cursors.

## Holds, external bookings and the feed

<!-- code examples/store.ts#holds -->

## Waitlists

`joinWaitlist({ tenantRef, resourceId | pool, start, end, holderRef, offerTtlMs })` waits for a
window that is taken now. When it comes free (a cancel, a released or expired hold, a no-show),
`offerWaitlist` gives it to the entries in the order they joined: the first whose window is free, on
its resource or the first free member of its pool, gets a hold for its holder, and the feed says so
(`waitlist.offered`, with `hold_id`). Confirm the hold to book it; let it go and the next is
offered.

Cancels, releases and moves, whether an agent (MCP, A2A) or the application API makes them, offer
at once; maintenance offers what lapses on its own (an expired hold, a no-show) and expires entries
whose window has started (`waitlist.expired`). With `checkInMinutes` in a resource's booking rules,
maintenance releases a booking made since the rule was set that nobody checked in that long after
its start, or after it was made for a walk-in (`reservation.no_show`), and the waitlist is offered
its time. Check-in opens an hour before the start; moving a booking to another start clears it.
Leaving the waitlist lets an offer not yet confirmed go with it.

## Calendar standards

`emitVAvailability({ rules, timezone, uid })` writes rules as an iCalendar VAVAILABILITY (RFC 7953)
and `parseVAvailability(text)` reads one back as `{ timezone, rules }`; `toJSCalendarEvent(event)`
answers a calendar event as a JSCalendar Event (RFC 8984). The API serves them at
`/v1/resources/{resource_id}/availability/ical` and `/v1/tenant/events/{event_id}/jscalendar`.

## Next

- [Concepts](/docs/concepts/): resources, events, holds, coverage and tenants.
- [Recurring events](/docs/recurring-events/): series, their budgets and the rules Slotlock stores.
- [External calendars](/docs/external-calendars/): iCalendar in and out, feeds and coverage.
- [Protocol reference](/docs/reference/): serving your own MCP and A2A endpoint.
- [Operations](/docs/operations/): maintenance, retention and upgrades.
