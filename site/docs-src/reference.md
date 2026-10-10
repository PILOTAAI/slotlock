---
title: MCP and A2A server
description: Serve the Slotlock tools from your own application, behind your authentication, and what the server does on the wire.
sidebar:
  label: MCP and A2A server
---

`createSlotlockAgentServer` serves Slotlock's {{toolCount}} tools over MCP ({{mcpModern}} stateless,
{{mcpLegacy}} and {{mcpOlder}}) and A2A {{a2a}} from one HTTP handler. The `slotlock serve` command
in the [Quickstart](/docs/quickstart/) is this server with configuration from environment
variables; embed it yourself when your application owns authentication, tenancy and the resources'
bookable hours. What each tool takes and returns is in the [tools reference](/docs/tools/).

<!-- include README.md#expose-slotlock-to-agents lead -->

<!-- include README.md#endpoints promote -->

## Errors

Tool results carry the [error codes](/docs/tools/#error-codes) an agent acts on. These are the
other two kinds.

<!-- include README.md#errors-from-your-own-backend promote -->

<!-- include README.md#protocol-errors promote -->

<!-- include README.md#authentication-and-oauth-discovery promote -->

## Confirmation before writes

Set `confirmation` to make the listed writes wait for a person; the
[security model](/docs/security/#confirmation-before-writes) covers how the question is sealed,
asked and answered, and what clients that cannot ask get.

<!-- include README.md#calendar-resources-and-live-updates promote -->

<!-- include README.md#caching-and-tracing promote -->

<!-- include README.md#supported-versions -->
