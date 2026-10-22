---
title: Quickstart
description: Run Slotlock and PostgreSQL 16 with Docker, connect Claude Code, and have an agent find and book a free slot.
---

You need Docker with Compose v2, `git`, `openssl` and Claude Code ([other clients](/docs/connect/)).
The quickstart runs Slotlock {{version}} from a clone with Docker Compose. Without Docker, install
it from npm and run `npx slotlock` with two database roles, as the
[README shows](https://github.com/PILOTAAI/slotlock#without-docker).

Step 6 asks you before the agent books, which needs an MCP client that supports protocol version
{{mcpModern}} with form elicitation. Claude Code uses that revision on its v2 MCP runtime, the
default from v2.1.274 (from v2.1.232 in sessions that fetch feature flags; `MCP_SDK_GENERATION=v2`
selects it): see
[MCP client runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes). An older client
gets `confirmation_required` for every booking while `SLOTLOCK_CONFIRM_WRITES=all`, the default;
the note at the end of [step 6](#6-find-a-slot-and-book-it) turns confirmation off instead.

## 1. Get the code

```sh
git clone https://github.com/PILOTAAI/slotlock.git
cd slotlock
```

## 2. Configure it

Fill the four empty secrets in `.env` with random values:

```sh
cp .env.example .env
for name in POSTGRES_PASSWORD SLOTLOCK_APP_DB_PASSWORD \
            SLOTLOCK_AUTH_TOKEN SLOTLOCK_CONFIRMATION_SECRET; do
  sed -i.bak "s/^$name=$/$name=$(openssl rand -hex 32)/" .env
done && rm .env.bak
```

The defaults make every resource bookable on weekdays 09:00 to 17:00 (`SLOTLOCK_AVAILABILITY`,
unless the resource has hours of its own: `slotlock hours set`) and make every write wait for a
person (`SLOTLOCK_CONFIRM_WRITES=all`).

## 3. Start Slotlock

```sh
{{composeUp}}
curl http://localhost:8080/healthz
```

```json
{"status":"ready","version":"{{version}}","checks":["database"]}
```

The server listens on `127.0.0.1:8080` only, as a database role that cannot bypass row-level
security.

## 4. Add a resource

```sh
docker compose exec slotlock slotlock resource add vehicle-42 --timezone Europe/London
```

## 5. Connect Claude Code

```sh
export SLOTLOCK_AUTH_TOKEN="$(sed -n 's/^SLOTLOCK_AUTH_TOKEN=//p' .env)"
{{claudeMcpAdd}}
```

Claude Code now has the {{toolCount}} `slotlock_*` tools.

## 6. Find a slot and book it

Ask Claude Code:

> When is vehicle-42 free for two hours in the week of 1 March 2027? Book the first slot as a
> vehicle handover.

The agent lists resources, then calls `slotlock_find_next_available`, which answers Monday 09:00 to
11:00 UTC, `certain`:

```json
{
  "resource_id": "…",
  "start": "2027-03-01T09:00:00.000Z",
  "end": "2027-03-01T11:00:00.000Z",
  "coverage": {
    "start": "2027-03-01T00:00:00.000Z",
    "end": "2027-03-08T00:00:00.000Z",
    "certainty": "certain",
    "reason": null
  }
}
```

Before `slotlock_create_event` runs, Claude Code asks you (the step that needs protocol
{{mcpModern}}): Book vehicle-42 for 2027-03-01 09:00–11:00 (Europe/London): "Vehicle handover".
Accept, and it is booked. Book the same time again and the agent gets
`{"error":{"code":"overlap"}}`.

:::note[Trying it on your own, or with an older client?]
Set `SLOTLOCK_CONFIRM_WRITES=none` in `.env` and run `docker compose up --detach` to let the agent
book without asking. Keep confirmation on for anything real.
:::

## Next

- [Tools reference](/docs/tools/): every tool's input, output and errors.
- [Connect an agent](/docs/connect/): Cursor, VS Code, the Claude API, A2A.
- [TypeScript library](/docs/library/): the same engine in your code, with holds.
- For a server beyond this machine, put a TLS proxy in front, set `SLOTLOCK_PUBLIC_URL`, and work
  through the [production checklist](https://github.com/PILOTAAI/slotlock#production-checklist).
