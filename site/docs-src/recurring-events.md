---
title: Recurring events
seoTitle: 'Recurring events with RRULE and time zones | Slotlock'
description: Store a repeating event, and know what Slotlock expands, within which budget, and which RFC 5545 rules it refuses.
sidebar:
  label: Recurring events
---

A recurring event is one write: Slotlock stores its occurrences for a window and maintenance rolls
that window forward. Agents create them with `slotlock_create_event` and a `recurrence_rule`
([Tools](/docs/tools/)); your code, with the [library](/docs/library/):

<!-- code examples/store.ts#recurring -->

## The stored window

Occurrences are stored for a window of at most 367 days and 2,000 occurrences; maintenance rolls
the window forward, never moving its end back. Outside it, before or after, free/busy reports the
time as unproven.

## The expansion budget

A rule is expanded within a budget of steps, a count of work that reads no clock, so the same input
is accepted or refused however loaded the machine: 500,000 for a feed (the whole read, from its
text) or for a stored series as maintenance rolls it, about half a second, and 50,000 for one event
as it is written, refused within a tenth of a second whatever its rule or time zone (on a laptop; a
4-vCPU Linux server takes up to twice as long).

A step is about a microsecond: a step of ical.js's search costs three, a weekday compared one, five
days walked one, a year scanned three (and one for each eight days it lists), and two weekdays of a
year listed one. Each occurrence passed costs one more, each conversion of a time in an IANA zone
half (one and a half in a zone only the feed defines), and each instant Intl is asked for to read a
zone's offsets five, the first time an expansion reads that day of the zone, whatever the process
has read before. A feed's own time zones (VTIMEZONE) count against the same budget, each change
listed when one is expanded costing four tenths: one written the way Outlook writes them, from
1601, costs about 6,000.

A feed may carry 100 time zones and name 100 it does not define, 1,000 observances and 2,000 RDATE
values in the zones it carries, and 20,000 RDATE and EXDATE values in its events, and an event 8
RRULEs, each further one costing a step at every occurrence its expansion passes; a property's name
and parameters may take 8 KB and list 100. A MINUTELY to WEEKLY step, a `DURATION`, or an event's
length may be a century at most. A calendar that needs more, such as a rule that never occurs
(`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`), is refused: `invalid_event` on a write, `invalid_icalendar`
from a feed.

A holiday calendar ([closures import](/docs/booking-rules/)) is read within the same 500,000 steps,
building each rule's expansion included, under the same limits on its time zones, dates, lengths and
property heads, and with at most 1,000 recurring events. Past them it is refused
`invalid_holiday_calendar`.

## Where an expansion starts

A feed's rules are expanded from their start, and each series may pass 4,000 occurrences on the way
(a daily one, about 11 years) whatever the feed's other series take. A feed series with one DAILY or
WEEKLY rule and no COUNT, RDATE or `RANGE=THISANDFUTURE` override is searched from just before the
window instead, so a daily standup since 2014 reads like one that began this year.

A stored series keeps where its last expansion stopped, and the next one resumes there, so a daily
series keeps rolling for as long as it runs: its budget goes on the window, not on the years before
it. A write that changes a series searches from its start, and resumes from where it stopped only
if that search is over the budget. A place serves only the rule, start and time zone it was kept
for, read by the same version of ical.js, and never lies past an occurrence that could still reach
the window (one within the event's length and a day of it, or one an exception moves into it).
Otherwise the series is searched from its start, within the same budget.

During maintenance, a stored series that outgrows the budget, that an earlier release stored and
this one refuses, or whose roll fails for any other reason (a row no release could have written,
such as a rule ical.js cannot read), is counted as `refused` (its ids in `refusedEventIds`), keeps
its old coverage and waits an hour behind the others. A pass whose roll fails still prunes, then
reports the failure. `storedCalendarEventProblem(event)` says why this release would refuse a stored
event (a rule shape it no longer expands, `COUNT` with a yearly day some years lack, or an exception
that names no occurrence), or `null`; run it over your stored events before upgrading.

## Rules Slotlock stores

A stored rule is daily or less frequent and follows RFC 5545's grammar: `COUNT=0`, an unknown or
repeated part, or `COUNT` with `UNTIL` is refused. Shapes ical.js 2.2.1 expands differently from
RFC 5545 are refused everywhere, a feed included, and `recurrenceRuleProblem(rule)` says why:
`BYWEEKNO`; a two-digit `BYDAY` ordinal; `BYSETPOS` other than with `FREQ=MONTHLY` and `BYDAY`
alone; `BYMONTH` with `FREQ=MONTHLY`; a negative `BYMONTHDAY` other than with `FREQ=MONTHLY` and
no `BYDAY`; `FREQ=YEARLY` with `BYMONTHDAY` but no `BYMONTH`, with a day none of its months has,
with `COUNT` or `BYDAY` and a day one of its months can lack, with `BYYEARDAY` and `BYMONTH` or
`BYMONTHDAY`, or with a numbered `BYDAY` and `BYMONTHDAY`; `BYHOUR` with `FREQ=HOURLY`,
`BYMINUTE` or `BYSECOND` with `FREQ=MINUTELY`, and any of them with `FREQ=MONTHLY` or `YEARLY`;
and `FREQ=SECONDLY`.

A yearly day some years lack (29 February, or a 31st with April) occurs only in the years that have
it, as RFC 5545 says, so its series may not add an RDATE or a second RRULE. A DATE `UNTIL` on a
timed series includes its whole day on the series' clock. An event's time zone is an IANA name,
stored in its canonical spelling (`europe/london` becomes `Europe/London`); a UTC offset such as
`+05:00` is refused.

## Exceptions and overlaps

A recurrence exception names the occurrence it cancels or moves by that occurrence's instant, as
`expandCalendarEventOccurrences` reports it, and is exported as a UTC `RECURRENCE-ID`; one that
names no occurrence is refused, so a mistyped instant is an error rather than a cancellation that
frees nothing. A series' occurrences never overlap each other: one that reaches past the next one's
start (a day-long occurrence the night the clocks go forward) ends there, and the next ends at the
later of the two ends, so the series holds the same time as separate reservations.
