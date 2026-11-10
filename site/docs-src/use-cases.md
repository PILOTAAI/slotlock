---
title: Use cases
description: The businesses Slotlock fits, and how to model each one with resources, pools, booking rules and holds, and what its agents do.
sidebar:
  label: Use cases
---

Slotlock books things and staff hours that one booking at a time can have: a van, a court, a
treatment room, a technician's afternoon. Each section below says what to make a resource, which
[booking rules](/docs/booking-rules/) matter, and what an agent does with the
[tools](/docs/tools/).

## Car and van rental

Slotlock started as the booking engine inside [Pylota](https://pylota.io), the AI fleet manager
for independent car rental operators. Pylota runs it as a library in its own PostgreSQL: each
vehicle is a resource, every booking also writes a Slotlock reservation in the same transaction, so
the exclusion constraint is the database's check against double bookings, and a car an agent has
quoted is held, with an expiry, while the renter pays.

To model a rental fleet:

- **Resources:** each vehicle, in its depot's time zone, and a pool per vehicle class, so a class
  sells out at its size.
- **Rules:** `turnaroundMinutes` for cleaning and inspection between hires, `minNoticeMinutes` and
  `maxAdvanceDays` for how soon and how far ahead, `checkInMinutes` to release a car nobody
  collects.
- **Other channels:** your adapter imports each marketplace's iCalendar feed as busy time
  ([External calendars](/docs/external-calendars/)). Slotlock cannot see a booking a marketplace
  has not published yet. It marks time no sync has read as unproven, and `requireCertain` refuses
  bookings there.
- **The agent:** for "any SUV, Friday to Sunday", it asks `slotlock_get_pool_availability`, holds
  two candidates with `slotlock_hold_slots` while the renter picks, and books the chosen one with
  `slotlock_create_event` and its `hold_id`, which releases the other. `slotlock_book_pool` takes
  the first free member instead.

## Equipment hire

- **Resources:** each machine or tool, and a pool per class, such as any 3-tonne digger.
- **Rules:** `turnaroundMinutes` for inspection and refuelling, `bufferBeforeMinutes` for
  preparation.
- **The agent:** for two diggers and a trailer, it searches with `slotlock_find_available_slots`
  and `require_free`, then books them with `slotlock_book_together`: all of them, or none.

## Clinics

- **Resources:** treatment rooms, each clinician's hours, and shared equipment such as an
  ultrasound.
- **Rules:** `slotStepMinutes` for appointment starts, `turnaroundMinutes` for cleaning,
  `checkInMinutes` to release a no-show.
- **Courses:** a weekly series of sessions is a [recurring event](/docs/recurring-events/).
- **The agent:** it finds the first time a clinician, a room and the equipment are all free, holds
  a few options while the patient chooses, and books all three in one transaction with
  `slotlock_book_together`.

Where a practice management system owns the diary, Slotlock suits the people building that
software.

## Courts

- **Resources:** each padel or tennis court, a pool such as any indoor court, and coaches' hours.
- **Rules:** `slotStepMinutes` of 60 or 90 with `stepOffsetMinutes`, and `checkInMinutes`.
- **Cancellations:** freed time goes to the waitlist in join order, as a hold for the next player.
  The waitlist and check-in are on the [REST application API](/docs/api/join-waitlist/), with a
  Full key.
- **Leagues:** a weekly slot is a recurring event.

## Garage service bays

- **Resources:** each bay or lift, technicians' and testers' hours, and courtesy cars as a pool.
- **The agent:** during the call, it books the bay and the technician together and a courtesy car
  from its pool, and holds the options while the driver decides.

## Salons and spas

- **Resources:** treatment rooms and chairs, therapists' and stylists' hours, machines.
- **Rules:** `turnaroundMinutes` for cleaning, `slotStepMinutes` for starts.
- **The agent:** a couples' booking is two therapists and the double room, booked together.

## Meeting rooms and desks

- **Resources:** each room, desk or phone booth, with pools by type or floor.
- **Rules:** `enforceHours`, and `checkInMinutes` to release a room nobody claims; the waitlist
  offers it on.
- **Calendars:** room calendars from Outlook or Google come in through your adapter as iCalendar.

## Field service

- **Resources:** technicians' hours by skill, vans, specialist kit.
- **Travel:** Slotlock does no routing. Model travel as a fixed `bufferBeforeMinutes` and
  `turnaroundMinutes`.
- **The agent:** it holds three windows where a qualified technician and the right van are free,
  the customer picks one, and [webhooks](/docs/api/list-changes/) tell your dispatch system.

## Also a fit

- **Loading docks:** doors by type as pools, turnaround for unloading, check-in at the gate. Over
  A2A, a carrier's agent can book with the warehouse's agent.
- **Golf tee times:** `slotStepMinutes` of a few minutes and `maxAdvanceDays` for the booking
  window, with waitlists for cancellations.
- **Event venues and studios:** holds made through the REST application API last days, not minutes
  ([Limits](/docs/limits/)), so a date can wait while a client decides. `bufferBeforeMinutes` and
  `turnaroundMinutes` keep set-up and clear-down free.

## Where it does not fit

- **Restaurant tables:** tables are combined and turned by covers, and reservation networks own the
  demand.
- **Hotels and holiday lets:** nights are sold by rate through channel managers.
- **Meetings between two people:** a scheduling link does that already.
- **Classes and group places:** Slotlock books a resource once at a time. Selling several places in
  one slot needs a resource for each place.
