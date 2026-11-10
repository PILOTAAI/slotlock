---
title: Tools reference
description: The slotlock_* tools an agent calls over MCP or as A2A skills, with what each one takes, returns and refuses.
sidebar:
  label: Tools
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

The same {{toolCount}} operations are MCP tools and A2A skills. Every table here is read from the
server's registry, and `tools/list`, the agent card and `GET {base}/manifest.json` publish the same
JSON Schemas.

<!-- tools-overview -->

## Conventions

- **Times** are RFC 3339 with an offset (`2027-03-01T09:00:00Z`). Intervals are `[start, end)`, so
  back-to-back bookings do not overlap.
- **Windows** are at most {{horizonDays}} days; one event may last {{maxEventDaysText}} days.
- **Certainty.** Time is free only when `coverage.certainty` is `certain`. Treat `uncertain` as
  unknown, never as free.
- **Writes** take an `idempotency_key`: retry with the same key and get the first result
  (`replayed: true`). Updates and deletes also take the `expected_revision` you last read.
- **Failures are results** (`{"error":{"code":"…"}}`): read the code before retrying.
- **Scope.** The tenant comes from the credentials. Event tools see only the caller's own events;
  every booking counts as busy time.
- **Older names.** `calendar.<verb>` and `calendar_<verb>` still work and are no longer advertised.

## Holds, bundles and pools

An agent offering a person several times holds them first, so none is taken while the person
decides: `slotlock_hold_slots` holds each free candidate in one group (and lists the taken ones in
`refused`), and `slotlock_create_event` with one `hold_id` books that time and releases the rest in
the same transaction. A hold belongs to the agent that took it: another agent can neither book nor
release it. One agent may have 20 live holds at once, holding at most 2,160 hours together in
`slotlock serve` (`SLOTLOCK_LIMITS`: `holder_holds`, `holder_held_hours`; `maxHoldsPerHolder` and
`maxHeldHoursPerHolder` in `createSlotlockStore`); past either it is refused, `hold_limit_reached` or
`held_time_limit_reached`. Unbooked holds expire by the database clock. Notice was judged when the
time was held, so booking the hold does not judge it again.

A booking that needs several resources at once (a van and its driver, a room and its projector)
uses `slotlock_find_available_slots` with `require_free` (every resource, or any n of them, free
together, each judged by its own hours and rules) and books with `slotlock_book_together`: one event
per resource in one transaction, all or none. A refusal names the `resource_id` that refused, on
MCP and A2A in the error beside its `code`, on REST in the problem. Bundles take their resources
in one order, so two racing over the same ones end with one booked, never a deadlock.

Rentals sell a class, not a plate. Put interchangeable resources in a pool
(`PUT /v1/resources/{id}/pool`, `setResourcePool`); agents see each resource's `pool`, list a pool's
members with `slotlock_list_resources` and `pool`, and book the class with `slotlock_book_pool`,
which takes the first member that is free and allows the booking, in one transaction: a class of
five sells exactly five for a time, however many race (`pool_full` after that). To see how many are
free, `slotlock_get_pool_availability` splits a window where that number changes (counting each
member busy over its bookings' occupied time, buffers included, but not the buffers a new booking
would keep, so a member it counts free may still refuse a booking that abuts another); to see which,
search the members with `slotlock_find_available_slots` and `require_free: 1`: each slot names the
members free in `resource_ids`. `GET /v1/pools` lists the pools with their capacity.

## What Slotlock tells the model

MCP {{mcpModern}} clients receive these instructions from `server/discover`:

> {{mcpInstructions}}

<!-- tools-details -->

## Objects

What the tools return, then what the write tools accept.

<!-- tools-objects -->

## Error codes

Any tool can return {{commonErrors}}; each tool's section above lists the codes it adds.

A refusal is a result the model can act on:

- **MCP**: `isError: true` with text `{"error":{"code":"…"}}`.
- **A2A**: the reply's data part is `{"error":{"code":"…"}}`.

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | Input failed the schema, or a window is inverted or longer than 367 days. A schema failure adds `issues`, up to 20 `{"path":[…],"message":"…"}`, each naming a field by its path in the arguments (`["rules",0,"start_minutes"]`; `[]` is the arguments as a whole): in `error` on MCP and A2A, beside `code` in REST's problem details |
| `forbidden` | `authorize` refused the call |
| `rate_limited` | `consumeRateLimit` refused the call |
| `not_found`, `resource_not_found`, `event_not_found` | Not visible to this caller, or no such id: a resource id is the `id` `slotlock_list_resources` returns, not its `external_ref` |
| `overlap` | The time is taken |
| `revision_conflict`, `idempotency_conflict`, `event_cancelled` | Re-read, then retry with the current revision or a new key |
| `owner_event_quota_exceeded`, `owner_command_quota_exceeded` | Per-caller quota reached (see [Operations](/docs/operations/)) |
| `confirmation_required` | The write needs a person, and this client cannot ask one |
| `confirmation_declined`, `confirmation_cancelled` | The person said no, or dismissed the question |
| `invalid_cursor`, `invalid_event`, `invalid_window`, … | The store rejected a bounded input |
| `request_aborted`, `server_busy`, `store_inconsistent` | Transient; retry |
