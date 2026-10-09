---
title: Introduction
description: What Slotlock is, what it guarantees, and what it leaves to your application.
---

<!-- include README.md#_intro -->

<!-- include README.md#why-it-is-built-for-agents -->

## How the pieces fit

- **The engine** (`expandRules`, `findNextAvailable`) is pure availability maths: no database, no
  clock, the same answer every time.
- **The store** (`createSlotlockStore`) keeps resources, holds, reservations and events in the
  `slotlock` schema of your PostgreSQL 16 database. An exclusion constraint on that schema decides
  every overlap.
- **The agent server** (`createSlotlockAgentServer`) serves {{toolCount}} operations over MCP
  ({{mcpModern}}, {{mcpLegacy}} and {{mcpOlder}}) and A2A {{a2a}} from one registry, with your
  authentication in front of it.
- **Interchange** (`parseICalendarChanges`, `emitICalendar`, `normalizeExternalCalendarChange`)
  turns provider calendars into busy time and coverage, and publishes iCalendar back out.

<!-- include README.md#project-status-and-boundaries -->

## Next

- [Quickstart](/docs/quickstart/): the next free slot in a few lines, then PostgreSQL.
- [Concepts](/docs/concepts/): resources, rules, holds, certainty and tenancy.
- [MCP and A2A reference](/docs/reference/): every tool, endpoint and error code.
- [Security model](/docs/security/): confirmation before writes, row-level security, retention.
