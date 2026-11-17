---
title: How Pylota checks every car rental booking with Slotlock
description: Pylota, the AI fleet manager for car rental operators, runs Slotlock in its own PostgreSQL: each vehicle a resource, quoted cars held, overlaps refused.
date: 2026-11-11
author: maintainers
tags:
  - case study
  - car rental
  - Pylota
image: blog-pylota
imageAlt: Case study: how Pylota checks every car rental booking with Slotlock.
eyebrow: Case study
status: published
related:
  - Car and van rental | /use-cases/car-rental/
  - TypeScript library | /docs/library/
  - About Slotlock | /about/
---
[Pylota](https://pylota.io) is the AI fleet manager for independent car rental operators. Its agents quote cars to renters and take bookings. Slotlock started as Pylota's booking engine, and Pylota still checks every booking with it.

## The problem: many channels, one car

An independent operator can sell the same car through its own site, by phone, on marketplaces and through AI agents. If each channel checks availability and then writes, two that check at the same moment both see the car free, and the operator finds out at the depot, with two renters and one car.

Agents made the window wider, not narrower: they answer at any hour, they retry when a call times out, and a renter they quote can take minutes to pay.

## How Pylota uses Slotlock

- Slotlock runs as a library inside Pylota's own service and PostgreSQL, not as a separate server.
- Each vehicle is a resource.
- Every booking Pylota records also writes a Slotlock reservation in the same transaction. The exclusion constraint is the database's check against double bookings: if the reservation is refused, the booking is not recorded.
- A car an agent has quoted is held, with an expiry, while the renter pays. If they walk away, the hold lapses and the car is back on offer.

## Why a library and a transaction

Writing the reservation in the same transaction as Pylota's own booking means there is no moment where one exists without the other. If the database refuses the reservation, the whole transaction rolls back and the caller gets `overlap` instead of a second booking.

Operators who are not Pylota can do the same with the [TypeScript library](/docs/library/), or call Slotlock over MCP, A2A or REST from any stack ([Booking API](/booking-api/)).

## What it means for an operator

- A car is promised to one renter at a time, whichever channel sold it.
- Turnaround for cleaning and inspection is kept between hires by the same constraint.
- A renter halfway through paying keeps their car for as long as the hold says, and no longer.

Running a fleet of your own? [Car and van rental with Slotlock](/use-cases/car-rental/) shows how to model it, and you can try it in a sandbox seeded with cars and vans in pools at two branches.
