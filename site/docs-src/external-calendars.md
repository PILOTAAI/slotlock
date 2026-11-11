---
title: External calendars
seoTitle: 'Import external calendars as busy time (iCalendar)'
description: Bring Google, Microsoft and CalDAV calendars in through neutral iCalendar boundaries, read untrusted feeds off the main thread, and record how much is proven.
sidebar:
  label: External calendars
---

Provider adapters (Google, Microsoft, CalDAV) stay in your application, with their credentials.
Slotlock gives them neutral boundaries, and [Concepts](/docs/concepts/#external-calendars) explains
how their coverage decides what is proven free.

## The boundaries

- `normalizeExternalCalendarChange` for webhook changes; `parseICalendarChanges` and `emitICalendar`
  for bounded iCalendar in and out; `emitITipCalendar` for invitations.
- `parseICalendarFeed` reads a feed series by series: a series it cannot read (a refused rule
  shape, an end the clocks move onto its start, DTEND with DURATION, more than 4,000 occurrences
  from its start, or more work than the feed's budget has left) is named in `refused` by UID, with
  `limit: true` for the last two, and the rest is read. Treat a refused series' time as busy, or the
  feed's coverage as incomplete. `parseICalendarChanges` refuses the whole feed instead.
- `recordCalendarCoverage` marks how much of a feed is read. Pass the sources a resource depends on as
  `requiredSources`, and any coverage short of `complete` means the time is not proven free.

## How a feed is read

- All-day events become whole local days in the calendar's time zone; a feed without one is refused.
- A TZID Intl knows is read as that IANA zone, whether or not the feed defines it (a VTIMEZONE's
  own rules for such a name are not used); one only the feed defines, such as a Windows name, is
  read from its VTIMEZONE. A floating time is read in the calendar's zone. So an UNTIL, EXDATE,
  RDATE or RECURRENCE-ID written in UTC or another zone names the occurrence it means, a floating
  UNTIL is read on the series' own clock, and a `RANGE=THISANDFUTURE` exception moves every later
  occurrence by its own shift.
- An event with no length (a DATE-TIME DTSTART without DTEND or DURATION) occupies no time and is
  left out. A PERIOD RDATE ends where its period does. A document whose root is not a VCALENDAR, or
  an event that ends before it starts, is refused as `invalid_icalendar`.
- A series' DTSTART is its first occurrence, with or without an RRULE; every RRULE is expanded; an
  instant two of them, or an RRULE and an RDATE, name is one occurrence; every EXDATE excludes the
  occurrence it names (RFC 5545 §3.8.5). A DATE EXDATE of a timed series names the occurrence at the
  series' start time that day.
- An occurrence of a series occupies both readings of it when the clocks change inside it: its
  exact length from its start (RFC 5545 §3.8.5.3) and its written end on the wall clock (the later
  instant of a repeated hour). 00:00-06:00 holds six hours the night the clocks go forward and
  seven the night they go back. A start in a skipped hour moves forward by the gap; one in a
  repeated hour is its first instant. One-off events, overrides and PERIOD RDATEs occupy exactly
  the times they give. A series' occurrences never overlap each other, as for
  [stored series](/docs/recurring-events/#exceptions-and-overlaps). The
  [specification](/docs/specification/), "Daylight-saving time", lists the cases.
- An override without DTEND or DURATION lasts its series' length. One whose RECURRENCE-ID names no
  occurrence, or whose occurrence the series also EXDATEs, occupies its own time, as the provider
  shows it. The instances of a CalDAV-expanded series are each read, the first with or without a
  RECURRENCE-ID. An event with both DTEND and DURATION is refused.

Feeds are expanded within the budget [Recurring events](/docs/recurring-events/#the-expansion-budget)
describes.

## Storing a feed's events

`parseTrustedICalendarEvents` reads times as `parseICalendarChanges` does, so a series stored from
it occupies what the feed reports; an all-day series, stored from local midnight to local midnight,
may also hold the hour after a midnight the clocks go forward on, never less. It drops an EXDATE
that names no occurrence, and refuses what a stored series cannot hold: a zone only the feed defines
(a Windows name such as `GMT Standard Time`; map it to an IANA zone first), a DTSTART or DTEND the
clocks skip (an all-day series' first midnight included), a `DURATION` that counts days or weeks
outside UTC, an instance whose transparency differs from its series', or a moved instance that names
no occurrence.

## Writing iCalendar

`emitICalendar` and `emitITipCalendar` write a VTIMEZONE for the zone their times name (RFC 5545
§3.6.5), from the IANA rules: every change over the years the event covers, and, where a zone
changes on the same numbered or last weekday of a month every year, yearly rules that carry a
series on past them. A zone that does not, such as Casablanca, Gaza, Jerusalem or Santiago, is
exact over those years only.

## Reading untrusted feeds

Read a feed someone else controls with `createICalendarWorkerPool`, which runs the same parsers on
worker threads. However costly the feed, the thread that serves requests never runs ical.js on it: a
worker past its deadline (3 seconds by default) or its heap (128 MB) is stopped, and the feed is
refused with `CalendarExpansionLimitError`. The pool offers `parseICalendarFeed` too. When every
worker is busy and the queue is full, the pool answers `ICalendarWorkerBusyError` at once. A worker
starts in about 40 ms and is reused; idle workers do not keep the process alive. The pool runs from
the built package (the worker is `ical-worker-thread.js`), not from Slotlock's TypeScript sources.

<!-- code examples/feeds.ts#feeds -->

## What integrations build on

Sending messages, syncing calendars and taking payments are left to packages outside the core,
each its own process with its own credentials (RFC 0004 P3). The core gives them:

- **Busy time without events.** A calendar that reports only busy time (Google freeBusy, Microsoft
  getSchedule) records it with `replaceSourceBusy` (`PUT
  /v1/resources/{resource_id}/coverage/{source}/busy`): the source's coverage of a window, and the
  busy intervals in it, which replace what it said of that window before. Every read counts them
  (free/busy, searches and waitlist offers) and every booking Slotlock makes is refused over
  them. A booking already confirmed that the source newly reports busy time over is left as it is
  and put on the feed once as `coverage.conflict`, for someone to decide: a change at the provider
  is never applied silently. A sync that writes bookings to a calendar reports one moved or removed
  there with `reportCoverageConflict` (`POST /v1/resources/{resource_id}/coverage/{source}/conflicts`),
  which the feed says the same way.
- **Whom to tell, and whether.** A booking may name a contact (`contact_ref`), kept with
  `putContact` (`PUT /v1/contacts/{contact_ref}`): email, phone and WhatsApp numbers, locale, and
  consent per channel. `notify: false` on a booking or event says to tell no one. Deleting a contact
  takes its reference off every booking too. The feed carries the reference, never the person.
  `listContacts` (`GET /v1/contacts`) pages through them, each with when each channel's consent was
  given (`consent_at`).
- **Reminders.** Maintenance puts each event reminder, and each of a reservation's
  `reminder_minutes`, on the feed as `reminder.due` once, when it comes due. A sender keys each message by the change's `id` (with its channel and recipient) and
  records the key before sending, so a retry never sends twice.
- **Payments.** A hold made with `paymentRequired` (at most 30 minutes) is confirmed only after
  `markHoldPaid` (`POST /v1/holds/{hold_id}/paid`) records the payment's reference at your
  processor, once you or an adapter verified it. A hold that names its `payment` (amount and
  currency) needs at least that `received`. The feed says `hold.paid`. A paid hold that ends without
  a booking (it expired, or was let go) was never applied. Its `hold.expired` or `hold.released`
  carries `payment_unapplied` (the payment's reference and amount), and `markHoldPaid` with that
  reference answers `hold_ended`: refund it. Slotlock records payment state and never moves money.

Three packages in `packages/` build on these: `@slotlock/sync` (Google, Microsoft and iCalendar
busy time in, bookings written back), `@slotlock/notify` (email, SMS and WhatsApp, each message
sent once) and `@slotlock/payments-stripe` (a verified PaymentIntent marks its hold paid). Each
has its own README in the repository.
