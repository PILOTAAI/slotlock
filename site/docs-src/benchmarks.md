---
title: Benchmarks
description: How Slotlock's range constraint compares with one row per slot under pgbench, measured on every release, with the method and its caveats.
---

Every release runs RFC 0002's workloads once its tests pass and attaches the results to its GitHub
release. This page shows the newest.

## Latest results

<!-- benchmark-results -->

Single short runs; treat gaps under 15% as noise.

## Method

`scripts/bench.mjs` runs each workload with `pgbench` twice: against Slotlock's design, a range
column under an exclusion constraint, and against the usual alternative, one row per 15-minute
slot with a primary key, so a 1-hour booking writes 4 rows. Each write books one hour in one
transaction, through a function that catches the conflict as a server would, so a refused booking
counts as an answer, not an error. Both tables start empty for every run.

| Workload | What each transaction does |
| --- | --- |
| Non-overlapping, 1 resource | Books an hour no one holds on one resource: every attempt lands. |
| Non-overlapping, 1,000 resources | The same, spread over 1,000 resources. |
| Saturated single resource | Books one of 100 hours on one resource: once they fill, almost every attempt is refused. |
| Contended, 1,000 resources | Books one of 50 hours on one of 1,000 resources: bookings and refusals mixed. |
| Durable commits off | The first workload with `synchronous_commit` off, without the wait for the WAL flush. |
| Free/busy reads | Reads one resource's busy times over a day, from 50,000 bookings on 1,000 resources. |

The release job runs 8 clients for 8 seconds a run, on a GitHub-hosted `ubuntu-24.04` runner, with
PostgreSQL 16 at its defaults in a service container on the same machine. The table's first line
records the version, the CPU count, the clients and the duration of the run it shows.

## Caveats

- One short run per cell, on shared hardware whose neighbours vary: compare ratios more than
  absolute numbers, and two releases only when the gap is well over 15%.
- PostgreSQL runs at its defaults in a container, with no tuning for the hardware.
- Slot rows also fix the granularity (Slotlock's millisecond buffers would round), grow with booking
  length and take about twice the storage. Speed is not the only cost.
- Size a deployment from a run on your own hardware, not from this page.

## Run it yourself

```sh
DATABASE_URL=postgresql://…/scratch npm run bench -- --clients 8 --seconds 8 --out bench-results
```

It needs `psql` and `pgbench` on the path, works in a schema of its own, `slotlock_bench`, and drops
it when it ends: point it at a scratch database. `--out` writes `bench.json` and `bench.md`, the two
files a release attaches; `--json` prints the JSON instead of the table.
