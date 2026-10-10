---
title: MCP and A2A server
description: Serve the Slotlock tools from your own application, behind your authentication, and what the server does on the wire.
sidebar:
  label: MCP and A2A server
---

`createSlotlockAgentServer` serves the {{toolCount}} tools over MCP ({{mcpModern}}, {{mcpLegacy}},
{{mcpOlder}}) and A2A {{a2a}} from one HTTP handler. `slotlock serve` is this server configured from
environment variables; embed it when your application owns authentication and tenancy.

<!-- include README.md#expose-slotlock-to-agents lead -->

<!-- include README.md#endpoints promote -->

## Errors

Tools return [error codes](/docs/tools/#error-codes) the agent acts on. These are the other two
kinds.

<!-- include README.md#errors-from-your-own-backend promote -->

<!-- include README.md#protocol-errors promote -->

<!-- include README.md#authentication-and-oauth-discovery promote -->

## Confirmation before writes

`confirmation` makes the listed writes wait for a person; see the
[security model](/docs/security/#confirmation-before-writes).

<!-- include README.md#calendar-resources-and-live-updates promote -->

<!-- include README.md#caching-and-tracing promote -->

<!-- include README.md#supported-versions -->
