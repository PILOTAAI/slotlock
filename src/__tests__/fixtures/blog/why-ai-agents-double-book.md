---
title: Why AI agents double-book, and what the calendar has to do about it
seoTitle: Why AI agents double-book, and how the calendar must stop it
description: Agents retry, run in parallel and trust what an API tells them. Four ways that turns into double bookings, and what a calendar for agents has to do instead.
date: 2026-11-11
author: maintainers
tags:
  - AI agents
  - MCP
  - double booking
image: blog-why-ai-agents-double-book
imageAlt: Why AI agents double-book, and what the calendar has to do about it.
status: published
related:
  - Booking MCP server | /mcp-server/
  - Free/busy certainty | /docs/concepts/#freebusy-certainty
  - Security model | /docs/security/
---
An AI agent with a calendar tool can book a meeting room, a rental van or a court in seconds. Give several agents the same tool and the bookings start to collide. The cause is rarely the model. It is a calendar API built for people clicking one button at a time.

## 1. Agents run in parallel

A person books, waits and looks. Agents are deployed in fleets: a phone agent, a chat agent and a partner's agent can all ask for the same van in the same second. Any calendar that checks availability and then writes, in two steps, lets more than one of them through. The fix is to make the write itself conditional, in one place every path goes through. Slotlock puts that condition in PostgreSQL as an exclusion constraint, so a race has one winner however many agents run ([how the constraint works](/blog/postgresql-exclusion-constraint-double-booking/)).

## 2. Agents retry

Tool calls time out, connections drop, and agent frameworks retry. If the first call actually booked and the retry books again, the customer has two vans. Every write needs an idempotency key: the same key with the same arguments answers the first result instead of booking twice. In Slotlock, event writes and holds take an `idempotency_key`, and a retry answers `replayed`. The same key with different arguments is refused, because it means a bug.

## 3. Agents trust what they are told

A model treats an empty busy list as free time. If the busy time comes from a marketplace feed that failed to sync overnight, "nothing is booked" and "we do not know" look the same, and the agent books into a gap that is not there.

A calendar for agents has to tell those apart. Slotlock records how far each imported feed has been read, and marks unread time `uncertain` rather than free. Search tools never offer an uncertain slot, and a resource with `requireCertain` refuses a booking there. "Unknown" stays unknown, and the agent can say so.

## 4. Agents need a person in the loop, briefly

Most bookings end with a person choosing: which of three times, which car. While they decide, the options must not be sold to someone else, and if they walk away, the options must come back. A calendar without holds forces agents to book first and cancel later, which shows the slot as taken to everyone else in the meantime.

Slotlock's agents hold up to {{facts.holdSlotsMax}} candidates as one group for {{facts.holdTtlMin}} to {{facts.holdTtlMax}} seconds; booking one releases the rest, and a hold nobody books lapses on the database clock ([holds, in detail](/blog/holds-keep-a-slot-while-a-person-decides/)).

## Refusals an agent can act on

When a write is refused, an agent needs to know why, in a form it can branch on. A protocol error or a stack trace ends the conversation; a result with a code continues it. Slotlock answers a taken time as a tool result, `{"error":{"code":"overlap"}}` over MCP or a `409` RFC 9457 problem over REST, so the agent searches again and offers the next free time.

## A checklist for any calendar your agents use

1. Is the overlap check part of the write, enforced where every path goes through?
2. Does every write take an idempotency key?
3. Can the calendar say "unknown" instead of "free" when its data is stale?
4. Can an agent hold options while a person decides, with an expiry it does not have to clean up?
5. Are refusals data with a code, not errors?
6. Does the tenant come from the credential, never from an argument the model fills in?

Slotlock was built to answer yes to each, first for [Pylota](/blog/pylota-car-rental-case-study/)'s car rental agents. You can [connect it to an agent](/mcp-server/) in a minute, or [read the code](/open-source/).
