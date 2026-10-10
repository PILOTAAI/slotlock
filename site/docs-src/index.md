---
title: Introduction
description: Slotlock is the calendar AI agents cannot double-book. Each resource is its own calendar, holds expire on their own, and PostgreSQL refuses every overlapping write and returns the conflict as data.
---

<!-- include README.md#_intro -->

## Start here

- [Quickstart](/docs/quickstart/): run Slotlock with Docker and have Claude Code book a slot.
- [Connect an agent](/docs/connect/): Cursor, VS Code, the Claude API, MCP and A2A SDKs.
- [API keys and dashboard](/docs/keys/): a key per agent, or a GitHub sign-in to make your own.
- [Tools reference](/docs/tools/): every `slotlock_*` tool's input, output and errors.
- [TypeScript library](/docs/library/) or [your own server](/docs/reference/): build on it.

<!-- include README.md#why-it-is-built-for-agents -->

## How it fits together

- **Engine** (`expandRules`, `findNextAvailable`): availability maths, no database.
- **Store** (`createSlotlockStore`): resources, holds and events in your PostgreSQL 16, where an
  exclusion constraint decides every overlap.
- **Agent server** (`createSlotlockAgentServer`): the {{toolCount}} tools over MCP and A2A, behind
  your authentication. `slotlock serve` runs it from environment variables.
- **Interchange** (`parseICalendarChanges`, `emitICalendar`): provider calendars in and out.

<!-- include README.md#project-status-and-boundaries -->
