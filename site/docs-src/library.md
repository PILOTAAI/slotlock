---
title: Use Slotlock from TypeScript
description: Call Slotlock's engine and PostgreSQL store from your own code, with holds, events and tenant isolation, and no server in between.
sidebar:
  label: TypeScript library
---

The library is what the server runs on. Use it when your application books time itself, or for
holds, which only the library offers.

:::note[Not on npm yet]
Slotlock {{version}} is a pre-release. Build it and install the build:

```sh
git clone https://github.com/PILOTAAI/slotlock.git
cd slotlock && npm ci && npm run build
cd <your-project> && npm install <path-to>/slotlock/dist postgres
```
:::

<!-- include README.md#install -->

<!-- include README.md#quick-start-the-next-free-slot -->

<!-- include README.md#set-up-postgresql -->

<!-- include README.md#book-and-read-as-the-application -->
