---
title: Introduction
description: Slotlock is the calendar AI agents cannot double-book. Each resource is its own calendar, holds expire on their own, and PostgreSQL refuses every overlapping write and returns the conflict as data.
---

<!-- include README.md#_intro -->

## Start here

- **Connect an agent.** The [Quickstart](/docs/quickstart/) runs Slotlock with Docker, connects
  Claude Code, and has it find and book a free slot. [Connect an agent](/docs/connect/) covers
  Cursor, VS Code, the Claude API and the MCP and A2A SDKs.
- **Look up a tool.** The [tools reference](/docs/tools/) lists each `slotlock_*` tool's input,
  output and error codes, with an example.
- **Build on it.** Call Slotlock [from TypeScript](/docs/library/), or embed the
  [MCP and A2A server](/docs/reference/) behind your own authentication.
- **Understand it.** [Concepts](/docs/concepts/) explains resources, rules, holds, certainty and
  tenancy; the [security model](/docs/security/) explains who may write what, and when a person
  confirms.

<!-- include README.md#why-it-is-built-for-agents -->

## How Slotlock fits together

- **The engine** (`expandRules`, `findNextAvailable`) is pure availability maths: no database, no
  clock, the same answer every time.
- **The store** (`createSlotlockStore`) keeps resources, holds, reservations and events in the
  `slotlock` schema of your PostgreSQL 16 database. An exclusion constraint on that schema decides
  every overlap.
- **The agent server** (`createSlotlockAgentServer`) serves the {{toolCount}} `slotlock_*` tools over
  MCP ({{mcpModern}}, {{mcpLegacy}} and {{mcpOlder}}) and A2A {{a2a}} from one registry, with your
  authentication in front of it. `slotlock serve` runs it from environment variables.
- **Interchange** (`parseICalendarChanges`, `emitICalendar`, `normalizeExternalCalendarChange`)
  turns provider calendars into busy time and coverage, and publishes iCalendar back out.

<!-- include README.md#project-status-and-boundaries -->
