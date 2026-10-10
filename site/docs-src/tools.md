---
title: Tools reference
description: The slotlock_* tools an agent calls over MCP or as A2A skills, with what each one takes, returns and refuses.
sidebar:
  label: Tools
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

Slotlock serves the same {{toolCount}} operations as MCP tools and as A2A skills, from one registry
in `src/agent-server.ts`. Every table on this page is read from that registry when the site is
built, so a field cannot be documented here unless the server accepts it. `tools/list`, the A2A
agent card and `GET {base}/manifest.json` publish the same schemas as JSON Schema.

<!-- tools-overview -->

## Conventions

- **Times** are RFC 3339 date-times with an offset, such as `2027-03-01T09:00:00Z`. Every interval
  is half-open, `[start, end)`: a booking that ends at 10:00 and one that starts at 10:00 do not
  overlap.
- **Windows** for free/busy, slot search and event lists are at most {{horizonDays}} days. An event
  itself may last up to {{maxEventDaysText}} days.
- **Certainty.** Time is free only when `coverage.certainty` is `certain`. `uncertain` (reason
  `coverage_incomplete`) means some calendar the resource depends on has not been read for the
  window: treat it as unknown, never as free.
- **Writes** take an `idempotency_key`. Retry with the same key and arguments and you get the first
  result back with `replayed: true`; never use a new key for the same booking. Updates and deletes
  also take the `expected_revision` you last read.
- **Failures are results.** A refused or conflicting call returns `{"error":{"code":"…"}}` instead
  of throwing: read the code before retrying. `overlap` means the time is taken.
- **Scope.** The tenant comes from the caller's credentials, never from an argument. The event tools
  see only events the caller created, while every booking on a resource counts as busy time.
- **Earlier names.** Builds before the rename used `calendar.<verb>` and `calendar_<verb>` (for
  example `calendar_list_resources`). Both still resolve to these tools but are not listed.

## What Slotlock tells the model

An MCP {{mcpModern}} client that calls `server/discover` receives these instructions, which tell
the model how to use the tools:

> {{mcpInstructions}}

<!-- tools-details -->

## Objects

The objects the tables above link to: what the tools return first, then the shapes the write tools
accept.

<!-- tools-objects -->

## Error codes

Any tool can return {{commonErrors}}; each tool's section above lists the codes it adds.

<!-- include README.md#errors body lead -->
