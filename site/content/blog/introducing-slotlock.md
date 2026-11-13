---
title: Introducing Slotlock: the calendar AI agents can't double-book
seoTitle: Introducing Slotlock, the calendar AI agents can't double-book
description: Slotlock opens today: an open-source calendar AI agents book over MCP, A2A or REST, where PostgreSQL refuses every double booking, however many agents race.
date: 2026-11-16
author: maintainers
tags:
  - Launch
  - AI agents
  - MCP
image: blog-introducing-slotlock
imageAlt: Introducing Slotlock, the calendar AI agents can't double-book.
status: published
publishAt: 2026-11-16T13:00Z
related:
  - Booking MCP server | /mcp-server/
  - Quickstart | /docs/quickstart/
  - Pricing | /pricing/
---
Today Slotlock is open to everyone. It is a calendar for AI agents: it books vehicles, rooms, machines, people or anything else reservable, answers "when is this free?", and lets PostgreSQL refuse a double booking however many agents race for the same time. You can use it on Slotlock Cloud in a minute, or run the whole server yourself under {{facts.license}}.

## Why another calendar

Calendar APIs were built for a person clicking one button at a time. Agents are different: they run in fleets, they retry when a call times out, and they believe what a tool tells them. Put them on an ordinary calendar and the bookings collide ([four ways it happens](/blog/why-ai-agents-double-book/)).

We hit this first with [Pylota](/blog/pylota-car-rental-case-study/)'s car rental agents, where a phone agent, a chat agent and a partner's agent could all want the same van in the same second. Slotlock is what we built so that could never end in two customers and one van.

## What it does

- **Resources own calendars.** A van, a room or a technician has weekly hours and a time zone. Agents ask when it is free, and get times they can book.
- **PostgreSQL decides overlaps.** An exclusion constraint checks every write inside the transaction, so a race has one winner ([how the constraint works](/blog/postgresql-exclusion-constraint-double-booking/)). The loser gets a refusal it can act on, with a code, not a stack trace.
- **Retries are safe.** Writes take an idempotency key and an expected revision: a retried booking answers the first result instead of booking twice.
- **Unknown is not free.** Busy time imported from a feed that has not synced shows as uncertain, and search never offers it.
- **Holds keep options while a person decides.** An agent holds up to {{facts.holdSlotsMax}} candidate times as one group; booking one releases the rest, and a hold nobody books lapses on its own ([holds, in detail](/blog/holds-keep-a-slot-while-a-person-decides/)).

## How agents and code reach it

- **MCP:** {{facts.toolCount}} tools, {{facts.readToolCount}} that read and {{facts.writeToolCount}} that write, with names, schemas and errors that work in Claude, OpenAI's agents and every MCP host.
- **A2A:** an agent card and tasks, for agents that talk to agents.
- **REST:** the same operations, described by OpenAPI, with webhooks and a change feed.
- **Clients:** {{facts.clientCount}} language clients, for Python, Go, Rust, Java and .NET, plus the TypeScript library the server is built on.

## Start in a minute

Sign in to the [dashboard](https://app.slotlock.pylota.io/dashboard) with GitHub or Google, add a resource and its hours, and create an API key. Then connect an agent. In Claude Code:

```
claude mcp add --transport http slotlock https://slotlock-api.pylota.io/mcp \
  --header "Authorization: Bearer $SLOTLOCK_API_KEY"
```

Ask it when your resource is free next, and to book it. Then ask a second agent to book the same time, and watch it get refused.

Every account starts on Free, with no card. Developer and Team add room for agents in production ([pricing](/pricing/)). Slotlock Cloud runs in the United Kingdom, on a best-effort basis with no service level agreement yet, and the [status page](/docs/status/) says when it is down.

## Or run it yourself

The server is open source under {{facts.license}}: the code Slotlock Cloud runs is the code in the repository. It needs PostgreSQL 16 or newer, and starts with Docker Compose, from npm or as a library inside your own Node.js service ([self-hosting](/docs/self-host/)).

## What we would like from you

Try it with your agents and tell us where it breaks. Open an issue on [GitHub](https://github.com/PILOTAAI/slotlock), or see [pricing](/pricing/) if you want Slotlock on your own infrastructure under its own agreement. The [changelog](/docs/changelog/) says what changes, and anything under `/v1` changes only with 90 days' notice.
