---
title: TypeScript library
description: Call Slotlock's engine and PostgreSQL store from your own Node.js code, with no server in between.
sidebar:
  label: TypeScript library
---

The library is what the server runs on. Use it when your Node.js application books time itself.
From another language, use the [REST API](/docs/api/) or a [client](/docs/clients/).

## Install

```sh
npm install slotlock@{{version}} postgres
```

Node.js 22.12+ and PostgreSQL 16+ with `btree_gist`, which Slotlock creates if it is missing.
TypeScript declarations are included.

## Find a free slot, with no database

<!-- code examples/availability.ts#next-slot -->

## Set up the database

Two roles: one owns the schema and deploys it once per release; your application connects as
another that owns nothing and cannot bypass row-level security.

```sql
CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
```

<!-- code examples/deploy.ts#deploy -->

Run it after every upgrade: `applySchema` is idempotent and safe from several instances at once.

## Book time

<!-- code examples/store.ts#connect -->

<!-- code examples/store.ts#book -->

- `withTenant` scopes every call to one tenant through row-level security.
- A taken window comes back as `{ ok: false, code: 'overlap' }`, never a thrown error.
- Holds, reservations, recurring events and external calendar feeds work the same way.

## Next

- [Concepts](/docs/concepts/): resources, events, holds, coverage and tenants.
- [The README](https://github.com/PILOTAAI/slotlock#book-and-read-as-the-application): every store
  call, recurring events, external calendars and serving your own MCP endpoint.
- [Operations](/docs/operations/): maintenance, retention and upgrades.
