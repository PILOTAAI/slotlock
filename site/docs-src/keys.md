---
title: API keys and dashboard
description: Give each agent a key of its own, scoped and revocable, from the command line or from a dashboard where people sign in with GitHub.
sidebar:
  label: API keys and dashboard
---

A key replaces the server token for one agent: it can be limited to reading, and revoked without a
restart. Send it where the token went:

```sh
docker compose exec slotlock slotlock key create "Booking agent"
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer slk_…"
```

<!-- include README.md#api-keys promote -->

<!-- include README.md#dashboard promote -->
