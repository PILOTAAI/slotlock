---
title: Connect an agent
description: Give Claude Code, Cursor, VS Code, the Claude API or your own MCP or A2A client the Slotlock tools.
---

A Slotlock server answers MCP at `{base}/mcp` and A2A at `{base}/a2a`, with the same
{{toolCount}} tools behind both and a bearer token in front. The editor setups below use the local
server from the [Quickstart](/docs/quickstart/), `http://localhost:8080`, and its token in
`SLOTLOCK_AUTH_TOKEN`. For a server you deploy, use its `https://` URL and a token your
`authenticate` callback accepts.

## Editors and coding agents

<!-- include README.md#connect-an-mcp-client body -->

## Claude Code and the Claude API, against a deployed server

<!-- include README.md#claude-code-and-the-claude-api body -->

<!-- include README.md#mcp-any-client promote -->

<!-- include README.md#mcp-2026-07-28-confirmation-and-live-updates promote -->

<!-- include README.md#a2a-10 promote -->

<!-- include README.md#mcp-apps promote -->
