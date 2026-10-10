---
title: Use Slotlock from TypeScript
description: Call Slotlock's engine and PostgreSQL store from your own code, with holds, events and tenant isolation, and no server in between.
sidebar:
  label: TypeScript library
---

The library is what the server runs on: availability maths that needs no database, and a store
that keeps resources, holds, reservations and events in your PostgreSQL 16. Use it when your
application books time itself, or when you want holds, which only the library offers.

:::note[Not on npm yet]
Slotlock {{version}} is a pre-release. Until the first release is tagged, build the package from
the repository and install the build:

```sh
git clone https://github.com/PILOTAAI/slotlock.git
cd slotlock
npm ci && npm run build
# then, in your project:
npm install <path-to>/slotlock/dist postgres
```
:::

<!-- include README.md#install -->

<!-- include README.md#quick-start-the-next-free-slot -->

<!-- include README.md#set-up-postgresql -->

<!-- include README.md#book-and-read-as-the-application -->
