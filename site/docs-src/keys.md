---
title: API keys
description: Give each agent a key of its own, limited to what it needs and revocable without a restart.
sidebar:
  label: API keys
---

A key stands in for the server token for one agent or app. Create it on the server, then send it
as a bearer token.

## Create a key

```sh
docker compose exec slotlock slotlock key create "Booking agent" | jq -r .key
```

`key create` prints one JSON line with the key's id, prefix and scopes; `.key` is the `slk_…`
secret. It is shown once and Slotlock keeps only its SHA-256, so store it now.

Commands here run inside the Compose service, as above. With npm, run `npx slotlock …`; from a
built clone, `node dist/cli.js …`. The rest of this page writes `slotlock …` for short.

## Use it

```sh
curl http://localhost:8080/v1/resources -H "Authorization: Bearer slk_…"
claude mcp add --transport http slotlock http://localhost:8080/mcp \
  --header "Authorization: Bearer slk_…"
```

## Choose its scopes

| Scope | Allows | Give it to |
| --- | --- | --- |
| `read` | Listing resources, free/busy, the next free slot, reading events | An agent that only answers questions |
| `write` | Creating, changing and cancelling events | An agent that books |
| `admin` | The [application API](/docs/api/): resources, hours, holds, reservations, the tenant | Your own backend, never an agent |

A key gets `read` and `write` unless you say otherwise:

```sh
slotlock key create "Availability bot" --scope read --expires-in-days 90
slotlock key create "Booking site" --scope read,write,admin
```

## Rotate and revoke

```sh
slotlock key list            # one JSON object per key, never the secret
slotlock key rotate <id>     # a new secret; the id, scopes and bookings stay
slotlock key revoke <id>     # stops working on its next request
```

## Limits

- 100 active keys per tenant.
- A key may expire after 1 to 3,650 days (`--expires-in-days`); without it, it never expires.
- A key acts in the tenant it was created in (`SLOTLOCK_TENANT`), so one server can serve many
  tenants.
- The last six characters are a checksum, so secret scanners can recognise a leaked key offline.

Would you rather people made their own keys? Turn on the [dashboard](/docs/dashboard/).
