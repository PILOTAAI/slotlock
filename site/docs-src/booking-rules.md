---
title: Hours and booking rules
seoTitle: 'Booking rules: notice, buffers, turnaround and hours'
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

`SLOTLOCK_AVAILABILITY` sets the default bookable hours. The tenant, each location and each
resource can store their own (`slotlock hours set`, or the [dashboard](/docs/dashboard/)): a
resource without its own uses its location's, then the tenant's, then this. With none, no slot is
offered. Closures and special days (`slotlock closures`) change single days.

```sh
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]' --all
slotlock hours set '[{"rrule":"FREQ=WEEKLY;BYDAY=SA","startMinutes":600,"durationMinutes":240}]' --location london-depot
slotlock hours set '[]' --resource vehicle-42      # this one is never bookable
slotlock hours clear --all    # the tenant's hours go: back to SLOTLOCK_AVAILABILITY
slotlock closures add 2026-12-25 2026-12-26 --label Christmas
slotlock closures add 2026-12-24 --label "Christmas Eve" --open 09:00-13:00 --location london-depot
slotlock closures import holidays.ics --location london-depot
```

Hours inherit (RFC 0004 B2): a resource without its own uses its location's, the nearest up the
chain, then the tenant's, then `SLOTLOCK_AVAILABILITY`. Resources added later inherit too.
Nothing is copied, so `hours set --all` leaves a resource's own hours alone unless `--override`
clears them, or `--matching` clears those that are the same as the tenant's were or as the new
ones: the copies 0.8.0 and earlier made, while hours set apart on purpose stay. The dashboard's
"Your hours" names the resources that keep their own, with the same three choices, and
`/resources?hours=own` lists them.

Closures and special days (RFC 0004 B1) replace whole days, read in each resource's time zone: a
closure empties them, `--open` gives them hours of their own. Each is the tenant's, one location's
(and every location inside it) or one resource's. Where several fall on a day, the nearest wins.
Search leaves those days as they say. Writes are refused `booking_rule_outside_hours` only under
the `enforceHours` rule, as for weekly hours. `closures import` reads an iCalendar file of days
off: each all-day event closes its days for the next two years. The calendar is kept by name
(`--label`, else its own): importing it again updates its closures and removes the holidays it
dropped. Through the API or the dashboard, a calendar's address can be subscribed to, and is
imported again every 30 days.

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
| `turnaroundMinutes` | keeps this long free after it (up to a week): its trailing buffer, which the database enforces |
| `minDurationMinutes`, `maxDurationMinutes` | lasts at least, and at most, this long |
| `allowedDurations` | lasts exactly one of these lengths, in minutes |
| `defaultDurationMinutes` | (a search) is this long when the search names no length |
| `cancelCutoffMinutes`, `rescheduleCutoffMinutes` | (a cancel or move of it) comes at least this long before its start, unless an admin gives a reason |
| `cancellationFee` | (a cancellation of it) records this fee, within `withinMinutes` of its start when given |
| `holdPrice` | (an agent's hold of it) waits for this payment, your price, whatever the agent asks; an agent books it only from such a hold, once paid |
| `pickupTimes`, `returnTimes` | from one local day to another (a hire), starts in one of these windows of the day and ends in one of those |
| `hoursApply` | how the hours hold a hire: `whole` (all of it inside them) or `ends` (only its start and end, the resource being out between); by default `ends` with `pickupTimes` or `returnTimes`, else `whole`. Writes follow it under `enforceHours`, and every search follows it: with `ends`, `slotlock_find_available_slots` and `slotlock_find_next_available` offer slots that run from one day to another, as `slotlock_find_available_ranges` does |
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
- A series is held to the cutoffs and fee by its next occurrence not yet started, or, with none
  left, the one under way. Changing its times, zone or exceptions is a move.
- An agent cannot get round the cutoffs and fee another way. Inside the reschedule cutoff, making a
  one-off a series counts as a move. Making a booked event transparent, which lets its time go,
  counts as a cancellation: it is refused inside the cancel cutoff, or once a cancellation fee is
  due, since cancelling it records the fee (`booking_rule_cancel_cutoff`).
- Nor by moving it. A booking or event moved, or made a series, when cancelling it would already be
  late (inside the cancel cutoff, or once its fee is due) keeps the start it had then: a later
  cancellation is judged from it, however far the move took it. An agent's event that late cannot
  move to another resource, which would leave the rules that make it late
  (`booking_rule_cancel_cutoff`).
- An agent never sets a price. On a resource with `holdPrice`, an agent's hold waits for that
  payment whether or not it asked to (`payment_required` and `payment_amount` say so), a `payment`
  it names that is not the price is refused (`409 payment_price_mismatch`, as any `payment` is where
  the resource has no price), and booking the resource without a paid hold of it is refused
  (`409 payment_required`). That is any time an agent's write adds there: a new event, one moved
  onto the resource, one made opaque, or occurrences the event did not already hold (a longer or
  moved time, a series grown). Its details, or less of its time, change freely. Your own systems,
  through the application API, set their own price.
- A key's caps on what its agent holds (`max_holds`, `max_held_hours`) count the time its
  approvals hold while a person decides, as its own holds.
- Searches (`slotlock_find_next_available`, `slotlock_find_available_slots`, `findNextAvailableFor`)
  offer only slots the rules allow, so an offered slot is one the write accepts. A length the
  duration rules refuse finds nothing; a search that names no length takes
  `defaultDurationMinutes` (`400 duration_required` when the resources give none, or differ).
- Hires across days (a car from Friday to Monday) are found with `slotlock_find_available_ranges`:
  each resource's or pool member's earliest range that starts in a pick-up window and lasts N days,
  or ends in a return window, inside its pick-up and return times and its hours at both ends.
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
