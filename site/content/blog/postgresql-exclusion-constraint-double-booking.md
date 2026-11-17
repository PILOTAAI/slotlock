---
title: Preventing double bookings with a PostgreSQL exclusion constraint
seoTitle: Prevent double bookings with a PostgreSQL exclusion constraint
description: Why a check-then-insert booking races, and how an exclusion constraint on a tstzrange makes PostgreSQL refuse the overlap: the SQL, the error, the edge cases.
date: 2026-11-11
author: maintainers
tags:
  - PostgreSQL
  - double booking
  - concurrency
image: blog-postgresql-exclusion-constraint
imageAlt: Preventing double bookings with a PostgreSQL exclusion constraint.
status: published
related:
  - Concepts: the exclusion constraint | /docs/concepts/#the-exclusion-constraint
  - Open source | /open-source/
  - Why AI agents double-book | /blog/why-ai-agents-double-book/
---
Most booking code checks that a slot is free and then inserts the booking. Under load, and above all when AI agents book on their own, that check is the bug. This post shows why, and the one constraint that fixes it: the one Slotlock's schema is built on.

## The race in check-then-insert

The usual code reads, then writes:

```
SELECT 1 FROM bookings
 WHERE resource_id = $1
   AND starts_at < $3 AND ends_at > $2;   -- any overlap?
-- none found, so:
INSERT INTO bookings (resource_id, starts_at, ends_at) VALUES ($1, $2, $3);
```

Two requests that run this at the same moment both see no overlap, because neither has inserted yet, and both insert. Under the default isolation level, PostgreSQL does nothing to stop it: each statement saw a consistent snapshot, and the two rows do not conflict on any unique key.

The usual patches each cost something. `SELECT … FOR UPDATE` locks rows that exist, but the conflicting row does not exist yet. An advisory lock per resource works until a code path forgets to take it. Serializable isolation catches the anomaly, at the price of retries on every write path. A unique index cannot help, because two overlapping ranges are not equal.

## An exclusion constraint says what you mean

An exclusion constraint generalises a unique constraint: instead of "no two rows are equal", it says "no two rows satisfy these operators together". For bookings: no two rows have the same resource and overlapping time.

```
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE bookings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id uuid        NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  CHECK (starts_at < ends_at),
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);
```

`btree_gist` lets a GiST index compare the plain `uuid` with `=` beside the range overlap operator `&&`. The index the constraint builds is the one that checks every insert and update, inside the transaction, against every committed and in-flight row. Two concurrent inserts for overlapping times cannot both commit: one waits for the other, then fails.

## What the losing writer sees

The loser gets SQLSTATE `23P01`, `exclusion_violation`. Match on the code, never the message, which changes between versions and locales. In Slotlock the store turns `23P01` into a result, `{ ok: false, code: "overlap" }`, and every interface passes that on as data: a tool result over MCP, a `409` problem over REST. An agent can then search again and offer the next free time.

One more case belongs in the handler. Concurrent inserts into the same exclusion index can deadlock inside the constraint check itself (`40P01`). PostgreSQL rolls the victim back completely, so retrying it once either wins or fails cleanly with `23P01`. Slotlock's store does exactly that.

## Half-open ranges

Write ranges as `[start, end)`: the start is in, the end is out. A booking from 10:00 to 12:00 and another from 12:00 to 14:00 then do not overlap, which is what everyone expects. With closed ranges, `[]`, they would share the instant 12:00 and the second would be refused.

## Cleaning time, holds and cancellations

Real bookings occupy more than their own time. A rental car needs cleaning after the hire; a room needs setting up before the meeting. Slotlock stores an occupied range beside the booked one and constrains that instead, so turnaround and buffers are protected by the same rule:

``` caption="The constraint in Slotlock's schema"
{{facts.excludeConstraint}}
```

- Holds sit under the same constraint, so a hold blocks a booking, and a booking a hold, with no second check. A hold carries an expiry on the database clock, and the next writer that wants its time removes it; nothing waits for a cron job.
- Cancelled rows must not block the time. Delete them, move them to another table, or add a `WHERE (status <> 'cancelled')` predicate to the constraint, which PostgreSQL supports for exclusion constraints.
- Several resources at once, such as a van and its driver, are several rows written in one transaction: if any one fails the constraint, the whole booking rolls back.

## Test the race, not the happy path

Slotlock's integration suite runs two overlapping inserts in parallel against a real PostgreSQL and asserts that exactly one wins and the other is refused with `overlap`. [Read the race test](https://github.com/PILOTAAI/slotlock/blob/main/src/__tests__/core.integration.test.ts). If your own booking code has no such test, the race is still there, waiting for traffic.

## When to use the product instead of the pattern

The constraint is a few lines, and you can add it to your own schema today. What takes longer is everything around it: each resource's hours in its own time zone, holds that lapse, imported busy time you cannot yet trust, retries that must not book twice, and the tools an agent calls. That is what Slotlock adds, on the same PostgreSQL. [How it compares with building it yourself](/compare/diy/).
