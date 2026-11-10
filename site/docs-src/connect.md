---
title: Connect an agent
description: Give Claude Code, Cursor, VS Code, the Claude API or your own MCP or A2A client the Slotlock tools.
---

A Slotlock server answers MCP at `{base}/mcp` and A2A at `{base}/a2a`, with a bearer token: the
server's own, or an [API key](/docs/keys/) per agent. The examples use the
[Quickstart](/docs/quickstart/) server, `http://localhost:8080`; for your own, use its `https://` URL.

Both are wire protocols, so an agent in any language connects with its own MCP or A2A client. Code
that calls Slotlock directly, without an agent, can use the
[REST clients](/docs/clients/) for Python, Go,
Rust, Java and .NET.

## Editors and coding agents

Point any Streamable HTTP client at `http://localhost:8080/mcp` with the token.

**Claude Code:**

```sh
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer $SLOTLOCK_AUTH_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "slotlock": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer ${env:SLOTLOCK_AUTH_TOKEN}" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`; it asks for the token once):

```json
{
  "inputs": [
    { "type": "promptString", "id": "slotlock-token", "description": "Slotlock token", "password": true }
  ],
  "servers": {
    "slotlock": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer ${input:slotlock-token}" }
    }
  }
}
```

With `SLOTLOCK_CONFIRM_WRITES=all`, writes need a client that can show a confirmation (MCP
2026-07-28 with form elicitation); other clients get `confirmation_required`. Set it to `none` to let
agents book on their own.

## Claude Code and the Claude API, against a deployed server

**Claude Code:**

```sh
claude mcp add --transport http slotlock https://calendar.example.com/slotlock/mcp \
  --header "Authorization: Bearer $SLOTLOCK_API_KEY"
```

**Claude API** (MCP connector, `anthropic-beta: mcp-client-2025-11-20`; the server must be public
over HTTPS):

```json
{
  "model": "<model id>",
  "max_tokens": 1024,
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://calendar.example.com/slotlock/mcp",
      "name": "slotlock",
      "authorization_token": "<token your authenticate accepts>"
    }
  ],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "slotlock" }],
  "messages": [{ "role": "user", "content": "When is vehicle 42 free for two hours next week?" }]
}
```

## MCP (any client)

<!-- code examples/mcp-client.ts#mcp -->

A refusal or conflict is a result (`isError`), not an exception. Slotlock speaks MCP 2026-07-28 to
clients that ask for it and 2025-11-25 or 2025-06-18 to the rest.

## MCP 2026-07-28: confirmation and live updates

With the TypeScript SDK v2 (`@modelcontextprotocol/client`), a client shows Slotlock's confirmation
to the person and hears about changes:

<!-- code examples/mcp-live.ts#live -->

## A2A 1.0

<!-- code examples/a2a-client.ts#a2a -->

Send one `application/json` data part, `{"skill": "<id>", "arguments": {…}}`, with header
`A2A-Version: 1.0`. Each skill in the agent card has an example; replies are synchronous.

The card declares `streaming`. `SendStreamingMessage` with any skill streams its reply as one
message. With `slotlock_watch_resources` (`{"resource_ids": [...]}`, up to 20) it streams a watch:
a task in `TASK_STATE_WORKING` naming the resources it can see, then a status update
`{"resource_id", "uri"}` each time one's free/busy changes, from the same feed and under the same
caps as MCP subscriptions, until `TASK_STATE_COMPLETED` (its duration, shutdown) or
`TASK_STATE_FAILED` (access withdrawn). Closing the stream ends it; the task is not kept, so
`SubscribeToTask` and `GetTask` do not find it. Push notifications are not offered: a tenant's
changes reach a URL as signed webhooks.

## MCP Apps

Read-only tools link to `ui://slotlock/calendar`, a self-contained calendar view that hosts
supporting MCP Apps (`io.modelcontextprotocol/ui`) render in a sandbox. It makes no network requests
and never writes.

A person can pick a slot in it. After `slotlock_find_available_slots` or a certain
`slotlock_find_next_available`, the view shows a strip of days and each day's times by morning,
afternoon and evening, or the one next available time. Picking a time and pressing *Book this time*
sends one chat message naming the resource id and the slot's start and end. The agent books it with
`slotlock_create_event`, through confirmation if `SLOTLOCK_CONFIRM_WRITES` asks for it. The message
carries nothing else from the result. If the host refuses the message, the view shows the text to
send instead. Write tools are marked `visibility: ["model"]`, so a host never lets a view call them.

The view takes its look from the host: its light or dark theme and its standard MCP Apps style
variables (colours, fonts, sizes). It shows times in the person's locale, clock and time zone, with
a 12h/24h switch.
