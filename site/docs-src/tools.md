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

## Alternatives, dry runs and approvals

A refused write another time can answer (`overlap`, `pool_full`, or a booking rule other than
`booking_rule_uncertain`) carries `alternatives`: up to three free times of the same length from the
time asked for, within seven days, found as `slotlock_find_available_slots` finds them (on a
bundle, times when every resource is free; on a pool, when any member is). They are suggestions,
not holds. An `overlap` also says when the booking in the way makes the time busy (`busy_start`,
`busy_end`), and names it when it is the agent's own (`conflicting_hold_id`,
`conflicting_event_id`).

Every write takes `dry_run: true` to check it without making it: it runs in its transaction with
every check, the database's constraints included, and is then rolled back, so nothing is stored,
recorded on the feed or sent. The answer is what it would have been, with `dry_run: true` (ids in
it are never stored), or the refusal it would have met, with its alternatives. A dry run is never
put to a person to confirm, and is charged as a read (on REST, when `dry_run=true` is in the query
string). Tenant erasure, maintenance and the partner API refuse one (`dry_run_not_supported`); a
read takes no `dry_run`.

An approval policy puts a person in front of the bookings it names (`slotlock_put_approval_policy`,
an admin operation): by resource, pool, location or group, narrowed by length
(`longer_than_minutes`), time outside the resource's bookable hours (`outside_hours`) and kind
(`single`, `pool`, `bundle`, `move`). A covered `slotlock_create_event`, `slotlock_confirm_slot`,
`slotlock_book_pool`, `slotlock_book_together`, or move by `slotlock_update_event` or
`slotlock_reschedule`, is first tried as a dry run, so it meets every check it would. Under
`require_approval` its exact time is then held for the approval (a move holds only the time its
event does not already take), and the agent is answered `409 approval_pending` with the
`approval_id` and `expires_at`; under `refuse` it is `403 approval_policy_refused`. A person decides
in the dashboard's Approvals page or with `slotlock_decide_approval`: granting makes the booking as
the agent asked for it, as that agent, in the transaction that lets the hold go; declining frees the
time. The agent learns the outcome by retrying with the same `idempotency_key`: the booking with
`replayed: true` once granted, `403 approval_declined` (with the person's `reason`) or
`409 approval_expired`. The wait is each policy's own (`approval_ttl_minutes`, a day by default, up
to 30 days, and the backend's `maxApprovalMinutes`), ending `lead_minutes` before the booking
starts; a booking too close to its start for that is `approval_too_late`. Where several policies
apply, `refuse` wins, then the one that must be decided soonest. A dry run of a covered write
answers `approval_required`; a recurring series cannot be held whole and is
`approval_series_unsupported`; one agent may have 50 approvals waiting and a tenant 500
(`approval_limit_reached`). Policies hold agents' bookings; the tenant's own bundles and pool
bookings through the application API (`/v1/tenant/bundles`, `/v1/tenant/pool-bookings`), which are
the tenant's events rather than the key's, only when a policy says `include_application: true`. Maintenance expires what no one decided. The feed records
`approval.requested`, `approval.granted`, `approval.declined` and `approval.expired`.

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

A resource says what it is through its profile, each part optional: a `name` agents and people see
instead of the reference, a `description`, its `kind` (`person`, `room`, `desk`, `space`, `vehicle`,
`machine`, `equipment`, `service` or `other`), its `capacity` (people or seats), up to 20 `labels`
(`ev`, `wheelchair`, `projector`) and `attributes` you want back (a staff number, a plate, a floor
plan link: text, numbers and booleans, 4 KiB at most). Set it when you create the resource, or with
`PATCH /v1/resources/{id}` (`updateResourceProfile`); `slotlock_list_resources` shows agents the
name, description, kind, capacity and labels, and narrows by `kind` and `labels`. None of it changes
how a resource is booked: a kind is a hint and a capacity is said, never enforced. The feed's
`resource.updated` names the profile fields that changed (`profile_changed`), never what they say.

Where a resource is, and the sets it is in, are kept apart from its pool, which is how it is booked:

- A **location** is a place in a tree of the tenant's own, at most 5 levels (a region, a site, a
  building, a floor, a zone) and 1,000 locations (`POST /v1/locations`). A resource is at one at
  most (`location` when created, or `PATCH`), and created without a time zone it takes the nearest
  one its location, or one above it, has. A location filter includes every location under it.
  A location something is at or in cannot be deleted (`409 location_in_use`), nor one moved under
  itself (`location_cycle`) or past 5 levels (`location_too_deep`).
- A **group** is any set the tenant wants: a team, a department, a contract, "Saturday clinic"
  (`POST /v1/groups`, then `PUT /v1/groups/{ref}/members/{resource_id}`). A resource is in up to
  20 of the tenant's 500 groups. Deleting a group leaves its resources as they were. A resource
  joining or leaving a group, its group's deletion included, is a `resource.updated` on the feed
  with its `groups` before and after, by reference.
- `slotlock_list_resources` shows agents each resource's `location` (with its name) and `groups`,
  and narrows by `location` and `group`, with or without a `pool`.
- The searches (`slotlock_get_free_busy`, `slotlock_find_next_available`,
  `slotlock_find_available_slots`) take a selection in place of `resource_ids`: any of `location`,
  `group`, `labels`, `kind` and `pool`, every one given matched. It covers the shared resources in
  use that match, in a stable order, at most 100 (20 for slots): more answers `400
  selection_too_large`, none `404 selection_empty`, so a search is never partial; the answer names
  them in `selected_resource_ids`. "A room for ten with video on floor 3" is one call.

A hall that is also its rooms, or a court that is also its halves, is a **composite**: make each
part a part of the whole (`PUT /v1/resources/{id}/parent` with `parent_id`, `setResourceParent`, or
`slotlock resource parent <room> <hall>`). Booking the whole then conflicts with a booking of any
of its parts, and two parts never with each other, held by PostgreSQL itself: each booking or hold
on a part also claims its place on the whole, `[i, i+1)`, and one on the whole claims every place,
in `slotlock.composite_claims` under `EXCLUDE (resource_id WITH =, during WITH &&, span WITH &&)`.
A part's free/busy (and next-free search) shows the whole's bookings, and the whole's shows its
parts'; agents see a part's `part_of`; a booking refused by the composite names the booking in its
way (`conflicting_reservation_id`); the feed's `resource.updated` carries `parent` before and
after; and the dashboard's resource page sets it, or lists a whole's parts. One level deep, at most 50 parts. A composite changes only
while neither side has a booking or live hold still to come (`409 composite_busy`); one level only
(`composite_too_deep`). A resource that is neither a part nor a whole has no claims, and nothing
about it changes.

Rentals sell a class, not a plate. Put interchangeable resources in a pool
(`PUT /v1/resources/{id}/pool`, `setResourcePool`); agents see each resource's `pool`, list a pool's
members with `slotlock_list_resources` and `pool`, and book the class with `slotlock_book_pool`,
which takes the first member that is free and allows the booking, in one transaction: a class of
five sells exactly five for a time, however many race (`pool_full` after that). To see how many are
free, `slotlock_get_pool_availability` splits a window where that number changes (counting each
member busy over its bookings' occupied time, buffers included, but not the buffers a new booking
would keep, so a member it counts free may still refuse a booking that abuts another); to see which,
search the members with `slotlock_find_available_slots` and `require_free: 1`: each slot names the
members free in `resource_ids`. `GET /v1/pools` lists the pools with their capacity and `order`: which member `slotlock_book_pool` tries first, set with `PUT /v1/pools/{pool}/order` (`setPoolOrder`, for up to 1,000 pools a tenant: `pool_order_limit_reached`, 409, for one more). `stable` (the default) tries them by id; `least_booked` the one with the fewest confirmed bookings made in the last 30 days; `round_robin` the one after the member it booked last, to share bookings across vans, rooms or a team of people.

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
| `quota_exceeded` | The tenant's plan's monthly quota is used up (`SLOTLOCK_QUOTAS=on`): `metric`, `quota`, `stop`, `used` and `resets_at` say which and until when |
| `not_found`, `resource_not_found`, `event_not_found` | Not visible to this caller, or no such id: a resource id is the `id` `slotlock_list_resources` returns, not its `external_ref` |
| `overlap` | The time is taken |
| `revision_conflict`, `idempotency_conflict`, `event_cancelled` | Re-read, then retry with the current revision or a new key |
| `owner_event_quota_exceeded`, `owner_command_quota_exceeded` | Per-caller quota reached (see [Operations](/docs/operations/)) |
| `confirmation_required` | The write needs a person, and this client cannot ask one |
| `confirmation_declined`, `confirmation_cancelled` | The person said no, or dismissed the question |
| `invalid_cursor`, `invalid_event`, `invalid_window`, … | The store rejected a bounded input |
| `request_aborted`, `server_busy`, `store_inconsistent` | Transient; retry |
