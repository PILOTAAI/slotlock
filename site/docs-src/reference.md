---
title: MCP and A2A reference
description: The tools, endpoints, error codes and client setup for Slotlock's MCP and A2A server.
---

One operation registry in `src/agent-server.ts` is served over MCP ({{mcpModern}} stateless,
{{mcpLegacy}} and {{mcpOlder}}) and A2A {{a2a}} by the same HTTP handler. The table below is read
from that registry when this site is built.

## Tools

{{toolCount}} operations: {{readToolCount}} reads and {{writeToolCount}} writes. MCP lists them as
tools and A2A as skills; both publish the same input and output JSON Schemas (`tools/list`, the
agent card and `manifest.json`).

<!-- tools-table -->

A query window (free/busy, slot search, event lists) is at most {{horizonDays}} days, and a slot
search can look for a slot that long; an event itself may last up to {{maxEventDays}} days.
Earlier builds used dotted names (`calendar.list_resources`); those still resolve on every entry
point but are not advertised.

<!-- include README.md#expose-slotlock-to-agents lead -->

<!-- include README.md#endpoints -->

<!-- include README.md#errors -->

<!-- include README.md#authentication-and-oauth-discovery -->

<!-- include README.md#calendar-resources-and-live-updates -->

<!-- include README.md#caching-and-tracing -->

<!-- include README.md#connect-an-agent -->

<!-- include README.md#supported-versions -->
