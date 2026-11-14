---
title: Holds: keep a slot while a person decides
description: How Slotlock holds booking options while a person chooses: groups of candidates, expiry on the database clock, payment-required holds and long holds over REST.
date: 2026-11-11
author: maintainers
tags:
  - holds
  - booking
  - MCP
image: blog-holds
imageAlt: Holds: keep a slot while a person decides.
status: published
related:
  - Concepts: holds | /docs/concepts/#holds
  - Hold time over REST | /docs/api/acquire-hold/
  - Booking API | /booking-api/
---
A booking is rarely one step. An agent finds a few times, a person picks one, sometimes they pay, and only then is it booked. Between the first step and the last, the options have to be kept for that person, and released if they leave. That is what a hold is for.

## Why not book, then cancel?

Booking the candidates and cancelling the unchosen ones looks simpler, but it lies to everyone else: for those minutes the times show as booked, webhooks fire for bookings that never were, and if the agent crashes before cancelling, the times stay taken. A hold is a different state, visible as occupied but not booked, and it ends on its own.

## Holds in Slotlock

- Over MCP, `slotlock_hold_slots` holds up to {{facts.holdSlotsMax}} candidate slots as one group, for {{facts.holdTtlMin}} to {{facts.holdTtlMax}} seconds. Each free one is held; the others are listed with why not.
- Booking one, with `slotlock_confirm_slot` or `slotlock_create_event` and its `hold_id`, books exactly that time and releases the rest of the group.
- A hold nobody books expires on the database clock, and the next writer that wants its time removes it. No scheduled job has to run first.
- `slotlock_hold_together` holds one time on several resources, such as a car and its driver, all or none. Through the REST API, a hold can last up to {{facts.maxHoldDays}} days, for a venue date that waits on a contract.

Holds sit under the same exclusion constraint as bookings, so a hold refuses a booking and a booking refuses a hold, with no second check that could race ([the constraint](/blog/postgresql-exclusion-constraint-double-booking/)).

## A person picks in the chat

Hosts that support MCP Apps render Slotlock's calendar view beside the conversation: days and times to choose from, and a Book this time button. Pressing it sends one chat message naming the slot, and the agent books the hold. The view makes no network requests and never writes; write tools are marked so a host never lets a view call them ([MCP Apps](/docs/connect/#mcp-apps)).

## Holds that wait for payment

A hold made with `payment_required` is booked only once the system you book for records the payment. Booking it earlier answers `payment_required`, so the agent sends the person to pay and tries again. The car stays theirs while the checkout runs, and goes back on offer if the payment never comes.

## Limits that keep holds honest

- One agent may have {{facts.holderHolds}} live holds at once, so a runaway loop cannot freeze a fleet.
- A hold belongs to whoever made it; another key cannot book or release it.
- A retried hold with the same idempotency key answers the same holds instead of making new ones.

## Waitlists turn freed time into holds

When a booking is cancelled or a hold lapses, a waitlist can offer the time to the next person in line, as a hold of their own to book or decline. Freed time goes in join order, so a cancellation at short notice is sold instead of wasted ([waitlists](/docs/api/join-waitlist/)).
