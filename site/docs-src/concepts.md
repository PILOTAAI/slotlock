---
title: Concepts
description: The ideas Slotlock is built on, from resources and availability rules to holds, free/busy certainty and tenancy.
---

The [specification](/docs/specification/) states each rule exactly; this page explains them.

## Resources

Anything bookable: a vehicle, a room, a machine, a person. Calendars belong to resources, not users.
Each has an id, an IANA time zone and, for a tenant, your own `externalRef`.

```ts
const vehicle = await tenant.createResource({
  tenantRef,
  externalRef: 'vehicle-42',
  timezone: 'Europe/London',
});
```

## Availability rules

Bookable hours are weekly rules: `FREQ=WEEKLY` with an explicit `BYDAY`, a start minute and a
length, evaluated in the resource's time zone (09:00 stays 09:00 across daylight saving).

- A resource can have rules of its own (`slotlock hours set`, the dashboard, or
  `setResourceAvailability`); otherwise it uses the server's (`SLOTLOCK_AVAILABILITY`).
- No rule means never bookable, not open all week.
- A rule Slotlock cannot evaluate adds nothing, and the CLI and store refuse it: anything but
  `FREQ=WEEKLY`, `BYDAY`, `INTERVAL=1` and a UTC `UNTIL` (so no `COUNT`, `BYHOUR` or `DTSTART`).

`expandRules` turns rules into windows and `findNextAvailable` finds the first slot that fits. Both
are pure functions ([example](/docs/library/#quick-start-the-next-free-slot)).

## Half-open intervals

Every interval is `[start, end)`. A booking ending at 12:00 and one starting at 12:00 do not
overlap.

## The exclusion constraint

PostgreSQL, not your application, decides whether two bookings overlap:

```sql
{{excludeConstraint}}
```

When two writers race, exactly one wins. The other gets data, not an exception:

```ts
{ ok: false, code: 'overlap', conflictingReservationId: '…' }
```

A booking can keep a resource busy after it ends with `bufferAfterMs`, for cleaning or turnaround.

## Holds

A hold occupies time without committing to it, under the same constraint:

```ts
const held = await tenant.acquireHold({ resourceId, start, end, ttlMs: 10 * 60_000 });
if (held.ok) await tenant.confirmHold(held.hold.id);
```

- It expires on the database clock, after at most {{maxHoldDays}} days, and the next writer that
  wants its time removes it. No cron job.
- `confirmHold` turns it into a reservation and is safe to retry; `releaseHold` frees it at once.

Holds are in the TypeScript store. Over MCP and A2A, agents create events, and you can make each
write [wait for a person](/docs/security/#confirmation-before-writes).

## Events

Events carry what people see: title, organizer, attendees, reminders and recurrence. Each opaque
occurrence is a reservation under the same constraint; a transparent event occupies nothing.

- Writes take an expected revision (`0` creates) and an idempotency key, so retries are safe.
- Cancelling leaves a tombstone, so a late create cannot bring the event back.
- Recurrence is stored for at most {{horizonDays}} days ahead; one event may last
  {{maxEventDaysText}} days.
- Over MCP and A2A, a caller sees only its own events, but everyone's count as busy time.

## Free/busy certainty

Time is free only if every calendar that could block it has been read. `getFreeBusy` returns busy
intervals and a coverage state, `complete`, `partial` or `unknown`, naming any missing sources.

- An adapter records what it has fully read with `recordCalendarCoverage`; a query names the sources
  a resource depends on in `requiredSources`.
- Over MCP the answer is `coverage.certainty`: `certain` or `uncertain`.
  `slotlock_find_next_available` offers no slot unless it is certain.

## Tenancy

Every tenant row is guarded by forced row-level security against the transaction setting
`slotlock.tenant_ref`. Without it, a query sees nothing.

- `store.withTenant(tenantRef, callback)` sets the tenant for everything in the callback.
- Over MCP and A2A the tenant comes from your `authenticate`, never from a tool argument.
- Traffic runs as a role that cannot bypass row-level security; `grantApplicationRole` refuses one
  that could.

## External calendars

Adapters for Google, Microsoft, CalDAV or a marketplace live in your application. Slotlock gives
them neutral boundaries (`normalizeExternalCalendarChange`, `parseICalendarChanges`, `emitICalendar`)
and treats external events as busy time, never as authority.
