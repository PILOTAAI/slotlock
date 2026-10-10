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

## What Slotlock tells the model

MCP {{mcpModern}} clients receive these instructions from `server/discover`:

> {{mcpInstructions}}

<!-- tools-details -->

## Objects

What the tools return, then what the write tools accept.

<!-- tools-objects -->

## Error codes

Any tool can return {{commonErrors}}; each tool's section above lists the codes it adds.

<!-- include README.md#errors body lead -->
