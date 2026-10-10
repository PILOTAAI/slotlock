---
title: Concepts
description: Resources, availability rules, half-open intervals, holds, reservations, free/busy certainty and tenancy.
---

Seven ideas carry the whole model. The [specification](/docs/specification/) states each one
normatively; this page explains them with the API names you will meet.

## Resources

A resource is anything that can be booked: a vehicle, a room, a machine, a clinician. Calendars
belong to resources, not to users. Each resource has a stable id, an IANA time zone, and, when a
tenant owns it, a tenant reference plus your own stable `externalRef` (for example `vehicle-42`).
Nothing in the semantics assumes an industry.

```ts
const vehicle = await tenant.createResource({
  tenantRef,
  externalRef: 'vehicle-42',
  timezone: 'Europe/London',
});
```

## Availability rules

Bookable hours are weekly rules (`WeeklyAvailabilityRule`): an RRULE with `FREQ=WEEKLY` and an
explicit `BYDAY`, a start minute after local midnight, and a duration. They are evaluated in the
resource's own time zone, so 09:00 stays 09:00 across daylight-saving changes. A wall time that
does not exist moves forward by the gap; an ambiguous one resolves to its first occurrence.

- No rule means no availability, not open all week.
- A rule Slotlock cannot evaluate (`COUNT`, an interval above 1) contributes nothing. It never
  manufactures a slot.

`expandRules(rules, window, timeZone)` turns rules into windows, and `findNextAvailable` finds the
earliest slot of a given length that fits inside them without touching busy time. Both are pure
functions; see the [Quickstart](/docs/quickstart/#quick-start-the-next-free-slot).

## Half-open intervals

Every interval is `[start, end)`: it contains its start and not its end. A booking that ends at
12:00 and one that starts at 12:00 do not overlap, so back-to-back bookings need no spare minute.
PostgreSQL uses the same boundary, `tstzrange(starts_at, ends_at, '[)')`.

## Reservations and the exclusion constraint

The database, not a check in your application, decides whether two bookings overlap. The
reservations table carries this constraint:

```sql
{{excludeConstraint}}
```

When two writers race for overlapping time, PostgreSQL lets exactly one insert through. The loser
gets a structured result, not an exception:

```ts
{ ok: false, code: 'overlap', conflictingReservationId: '…' }
```

The repository's integration suite runs that race against PostgreSQL ("two parallel overlapping
inserts: exactly one wins", and the same for holds). A booking can carry a trailing buffer
(`bufferAfterMs`) that keeps the resource occupied after the customer-visible end.

## Holds

A hold occupies time without committing to it, under the same constraint as a reservation:

```ts
const result = await store.withTenant(tenantRef, async (tenant) => {
  const held = await tenant.acquireHold({ resourceId, start, end, ttlMs: 10 * 60_000 });
  if (!held.ok) return held; // 'overlap', 'invalid_window' or 'invalid_ttl'
  // … ask the customer, take a deposit, wait for a person …
  return tenant.confirmHold(held.hold.id); // a reservation, or 'hold_expired' / 'hold_not_found'
});
```

- The expiry is `now() + ttl` on the database clock, never the application's. A hold may last up
  to {{maxHoldDays}} days.
- `confirmHold` turns a live hold into a confirmed reservation and is safe to retry.
  `releaseHold` frees the time at once.
- An expired hold is removed by the next writer that wants its time, in the same transaction, so
  no cron job is needed.

Holds are part of the TypeScript store. Over MCP and A2A, agents create events instead, and you can
require a person to [confirm each write](/docs/security/#confirmation-before-writes).

## Events

Events (`putCalendarEvent`) carry the calendar content people see: title, organizer, attendees and
their replies, reminders, and recurrence with exceptions. Each opaque occurrence becomes a
reservation under the same constraint; a transparent event stays visible but occupies nothing.

- Writes take an expected revision (`0` creates) and an idempotency key. Replaying the same command
  returns the original result; reusing a key with a different payload is `idempotency_conflict`.
- Cancelling leaves a tombstone, so a delayed create cannot bring the event back.
- A recurring event is materialized into a window of at most {{horizonDays}} days and 2,000
  occurrences. A one-off event may last up to {{maxEventDays}} days.
- Events created over MCP or A2A belong to the principal that created them; everyone else's still
  counts as busy time.

## Free/busy certainty

Free time is only free if every calendar that could block it has been read. `getFreeBusy` returns
busy intervals and a `coverage` assessment: `complete`, `partial` or `unknown`, with the names of
the sources that are missing.

- A provider adapter records how much of a feed it has fully read with `recordCalendarCoverage`.
- A query passes the sources a resource depends on as `requiredSources`. The window is `complete`
  only when each of them has a fresh coverage interval that contains it.
- An opaque recurring event adds its own source, `SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE`, so
  time past its materialized horizon is unproven until maintenance rolls it forward.

Over MCP the same answer is `coverage.certainty`: `certain` or `uncertain` (reason
`coverage_incomplete`). `slotlock_find_next_available` returns no slot unless every resource it
was asked about is certain.

## Tenancy and row-level security

Every tenant-owned row carries a tenant reference. Forced PostgreSQL row-level security compares it
with the transaction-local setting `slotlock.tenant_ref` and returns nothing when the setting is
missing or empty.

- `store.withTenant(tenantRef, callback)` pins one connection and sets the tenant for everything
  inside the callback. A standalone `set_config` through a pool is not enough.
- Over MCP and A2A the tenant comes from your `authenticate` callback. A tool argument can never
  choose it.
- Application traffic uses a role that is not a superuser and cannot bypass RLS;
  `grantApplicationRole` grants it exactly what it needs and refuses a role that could get around
  the policies.

## External calendars

Provider adapters for Google, Microsoft, CalDAV or a marketplace live in your application, with
their credentials. Slotlock gives them provider-neutral boundaries: `normalizeExternalCalendarChange`
for webhook changes, `parseICalendarChanges` for bounded iCalendar input, and `emitICalendar` /
`emitITipCalendar` for output. External events are busy time, never scheduling authority.
