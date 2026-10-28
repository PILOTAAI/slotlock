---
title: Scaling
description: How far one PostgreSQL takes Slotlock, how to measure it, and how to grow past it, by resource, by region, with replicas and alongside a solver.
---

Slotlock's guarantee is one database statement: PostgreSQL's exclusion constraint refuses an
overlapping write, whichever server sends it. Everything here grows the system without giving
that up.

## Measure it

```sh
DATABASE_URL=postgresql://…/scratch npm run bench -- --clients 8 --seconds 8
```

`scripts/bench.mjs` runs four workloads with `pgbench`, each against Slotlock's range constraint
and against the usual alternative, one row per 15-minute slot with a primary key, and prints
attempts a second. It works in a schema of its own, `slotlock_bench`, and drops it when it ends:
point it at a scratch database.

On 4 CPUs, PostgreSQL 16 at its defaults, 8 clients and 8 seconds a run (RFC 0002):

| Workload | Range constraint | Slot rows | Slots ÷ range |
| --- | --- | --- | --- |
| Non-overlapping, 1 resource | 6,694 | 9,718 | 1.45× |
| Non-overlapping, 1,000 resources | 7,310 | 8,584 | 1.17× |
| Saturated single resource (mostly refused) | 3,237 | 7,511 | 2.3× |
| Contended, 1,000 resources | 8,780 | 7,340 | 0.84× |

Slot rows are not orders of magnitude faster: within 2.3× either way, while they fix the
granularity, grow with booking length and take about twice the storage. Treat gaps under 15% as
noise; run it on your own hardware before you size a deployment.

## Partition by resource

Overlap exists only within one resource, so every check stays inside the partition that holds it.

- **PostgreSQL 17 and 18** accept an exclusion constraint on a partitioned table when it compares
  every partition key column with `=`. Hash-partition `slotlock.reservations` by `resource_id`
  and the constraint Slotlock creates already has that shape.
- **PostgreSQL 16** needs the constraint on each leaf partition instead, which is just as correct:
  no booking spans two partitions.
- Partition once the table is large enough that vacuum and index maintenance hurt (tens of
  millions of rows), not before.

## Distribute with Citus

Citus accepts exclusion constraints that compare the distribution column with equality, so
distributing the booking tables by `resource_id` keeps every overlap check on one node, with no
cross-node consensus. Co-locate `resources`, `reservations`, `calendar_events` and their
occurrences on `resource_id` so a booking's transaction stays on one node.

## A home region per tenant

One resource can have only one place where its writes are ordered: that is what refuses the second
booking. Spanner routes writes through a leader region for the same reason. With PostgreSQL, give
each tenant a home region and send its writes there:

- Route by tenant at the edge (the API key names it), to that region's servers and primary.
- Reads may come from a replica in any region, within the freshness bound below.
- Moving a tenant is a planned migration (copy, then switch its route), never two primaries at
  once.

## Read replicas

Free/busy and searches may read a replica: a stale answer can only offer a slot that is in fact
taken, and the write then refuses it with `overlap`, which an agent already handles. Writes, holds
and anything that confirms go to the primary. Bound the staleness: watch
`pg_last_xact_replay_timestamp()` and stop sending reads to a replica more than a few seconds
behind.

## Observe it

- **Traces:** every call takes a W3C `traceparent` (the header, or MCP `_meta`) and reports it in
  `onEvent` (`traceId`), so an OpenTelemetry exporter can join Slotlock's spans to the caller's.
  `slotlock serve` writes each call as a JSON line with `trace_id`.
- **Metrics:** with `SLOTLOCK_METRICS_TOKEN`, `slotlock serve` answers Prometheus at `/metrics`:
  `slotlock_calls_total` and `slotlock_call_duration_seconds` by protocol, operation and outcome,
  refusals, maintenance and webhook deliveries. Labels never name a tenant.
- **SLOs worth publishing:** availability of `/healthz`; p99 latency of `slotlock_create_event`
  and free/busy; the share of webhook deliveries within a minute; maintenance passes that finish.
- **Signals to alert on:** `server_busy` (503) rising, `coverage.stale` on the change feed,
  `webhook.disabled`, maintenance `capped` for hours.

## Back it up

Bookings are the record of what was promised. Run PostgreSQL with continuous WAL archiving and
point-in-time recovery (`pg_basebackup` plus `archive_command`, or your provider's PITR):

- **RPO:** seconds (the archive's lag), not a nightly dump's day.
- **RTO:** the time to restore a base backup and replay WAL. Rehearse it.
- After a restore, run `slotlock migrate` (it is idempotent) and replay the change feed from the
  last cursor your consumers saw.

## Alongside a solver

Constraint solvers such as [Timefold](https://docs.timefold.ai/timefold-solver/latest/introduction)
and [OR-Tools CP-SAT](https://developers.google.com/optimization/cp/cp_solver) optimise a whole
plan: which van takes which job to minimise empty miles. They solve a snapshot; Slotlock decides
each write as it arrives. They compose:

1. Read the snapshot: free/busy for the resources in the plan.
2. Solve it.
3. Commit the plan through Slotlock, a booking (or `slotlock_book_together` bundle) at a time,
   each with an idempotency key derived from the plan, so a retry repeats nothing.
4. An `overlap` means the snapshot went stale while the solver ran: book nothing more from this
   plan, read again, and solve again from what is now true.

The solver never needs to be right about concurrency; Slotlock never needs to know what is optimal.
