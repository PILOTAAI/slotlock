---
title: Hours and booking rules
description: Set when each resource can be booked, and what a booking on it must satisfy, from notice and step to buffers, check-in and certainty.
sidebar:
  label: Hours and booking rules
---

Bookable hours say when a resource is open. Booking rules say what a booking on it must satisfy.
Both are opt-in, and searches offer only the slots they allow.

Commands here are written `slotlock …`. With Compose, run them as
`docker compose exec slotlock slotlock …`; with npm, `npx slotlock …`; from a built clone,
`node dist/cli.js …`.

## Bookable hours

`SLOTLOCK_AVAILABILITY` sets the default bookable hours. A resource can have its own
(`slotlock hours set`, or the [dashboard](/docs/dashboard/)); with neither, no slot is offered.

```sh
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=SA","startMinutes":600,"durationMinutes":240}]' --resource vehicle-42
slotlock hours clear --all    # back to SLOTLOCK_AVAILABILITY
```

A rule is `rrule`, `startMinutes` and `durationMinutes` here and in `SLOTLOCK_AVAILABILITY`. The
REST application API spells every field in snake_case, so there it is `rrule`, `start_minutes` and
`duration_minutes`. `slotlock --help` lists every setting.

## Booking rules

A resource can also say what a booking on it must satisfy:

```sh
slotlock rules set '{"minNoticeMinutes":120,"slotStepMinutes":30,"turnaroundMinutes":30,"enforceHours":true}' --resource vehicle-42
slotlock rules clear --resource vehicle-42
```

| Rule | A booking made now |
| --- | --- |
| `minNoticeMinutes` | starts at least this far ahead |
| `maxAdvanceDays` | starts at most this far ahead |
| `slotStepMinutes` | starts on a step from local midnight in the resource's time zone |
| `stepOffsetMinutes` | starts this far past each step (0 to the step less one): with a 30-minute step, 15 starts bookings on :15 and :45 |
| `bufferBeforeMinutes` | keeps this long free before it: its leading buffer, which the database enforces |
| `turnaroundMinutes` | keeps this long free after it: its trailing buffer, which the database enforces |
| `enforceHours` | lies inside the resource's bookable hours |
| `checkInMinutes` | is claimed (`checkInReservation`) this long after its start, or maintenance releases it |
| `requireCertain` | lies in time every calendar sync recording coverage for the resource has read within a day |

- Holds, reservations, moves and agents' events are checked when they are made, by the database's
  clock; a refusal names the rule (`booking_rule_violated` with `rule` in the store,
  `booking_rule_min_notice`, `_max_advance`, `_slot_step`, `_outside_hours` or `_uncertain` to an
  agent). Under `requireCertain`, a search (the store's and the tools') needs those syncs' coverage
  too, read within a day, of the slot and its turnaround, so it offers no slot they leave unproven.
- A series is judged on its first occurrence for notice and advance, and on every occurrence for
  step and hours. Imported calendar events are not checked: they happened elsewhere.
- Searches (`slotlock_find_next_available`, `slotlock_find_available_slots`, `findNextAvailableFor`)
  offer only slots the rules allow, so an offered slot is one the write accepts.
- Two bookings stay at least the earlier one's trailing buffer plus the later one's leading buffer
  apart: each occupies from its start less its leading buffer to its end plus its trailing one, and
  the exclusion constraint keeps those apart. Free/busy reports that time as busy.
- The REST application API sets them with `PUT /v1/resources/{resource_id}/booking-rules`, in
  snake_case; the store with `setResourceBookingRules`.
- With no rule set anywhere, nothing changes: every rule is opt-in.

## Defaults for a tenant or a pool

Set rules for every resource of the tenant with `PUT /v1/booking-rules`, and for every member of a
pool with `PUT /v1/pools/{pool}/booking-rules`; read them back with `GET /v1/booking-rules`. The
store's are `setBookingRuleDefaults` and `getBookingRuleDefaults`. A resource's rules as they apply
(`effective_booking_rules`, `effectiveBookingRules`) are the tenant's defaults, overlaid by its
pool's, overlaid by its own: a rule set at a narrower level wins. `checkInMinutes` is a resource's
own only. The dashboard's resource page shows which rules a resource inherits, and from where.

A tenant has default rules for at most 1,000 pools (`pool_rules_limit_reached`, 409, for one more).
Merged rules are read leniently: a pool's `stepOffsetMinutes` under a resource's shorter step
applies modulo that step, and a field that is invalid on its own is ignored (and logged), never
read as refusing every booking.
