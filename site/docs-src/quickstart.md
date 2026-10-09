---
title: Quickstart
description: Run Slotlock and PostgreSQL 16 with Docker Compose and connect an MCP client, or build the package and call it from TypeScript.
---

Two ways in. Docker Compose runs PostgreSQL 16 and the Slotlock server, ready for an MCP or A2A
client. Or build the package and call it from your own TypeScript. Slotlock {{version}} is a
pre-release and is not on npm yet.

<!-- include? README.md#self-host-with-docker -->
## Self-host with Docker

A Docker Compose setup is being added to the repository. Until it lands, run PostgreSQL 16 with the
`btree_gist` extension available and follow the library steps below; the
[README](https://github.com/PILOTAAI/slotlock#readme) always has the current instructions.
<!-- end include -->

<!-- include? README.md#connect-an-mcp-client -->
## Connect an MCP client

Serve the tools with `createSlotlockAgentServer` (see the
[reference](/docs/reference/#expose-slotlock-to-agents)), then add the server to a client. For
Claude Code:

```sh
claude mcp add --transport http slotlock https://calendar.example.com/slotlock/mcp \
  --header "Authorization: Bearer $SLOTLOCK_TOKEN"
```
<!-- end include -->

## Use it as a library

Until the first release is tagged, build the package from the repository:

```sh
git clone https://github.com/PILOTAAI/slotlock.git
cd slotlock
npm ci && npm run build
# then, in your project, install the built package and its peer dependency:
#   npm install <path-to>/slotlock/dist postgres
```

<!-- include README.md#install -->

<!-- include README.md#quick-start-the-next-free-slot -->

<!-- include README.md#set-up-postgresql -->

<!-- include README.md#book-and-read-as-the-application -->
