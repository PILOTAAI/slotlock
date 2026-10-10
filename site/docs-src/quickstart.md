---
title: Quickstart
description: Run Slotlock and PostgreSQL 16 with Docker, connect Claude Code, and have an agent find and book a free slot.
---

You need Docker with Compose v2, `git`, `openssl` and an MCP client. The steps use Claude Code;
[Connect an agent](/docs/connect/) has the setup for Cursor, VS Code, the Claude API and your own
code. Slotlock {{version}} is a pre-release, so it runs from a clone of the repository rather than
from npm.

## 1. Get the code

```sh
git clone https://github.com/PILOTAAI/slotlock.git
cd slotlock
```

## 2. Configure it

`.env.example` holds every setting, with defaults for all but four secrets. Copy it and give each
secret a random value:

```sh
cp .env.example .env
for name in POSTGRES_PASSWORD SLOTLOCK_APP_DB_PASSWORD \
            SLOTLOCK_AUTH_TOKEN SLOTLOCK_CONFIRMATION_SECRET; do
  sed -i.bak "s/^$name=$/$name=$(openssl rand -hex 32)/" .env
done && rm .env.bak
```

Two defaults shape what follows:

- `SLOTLOCK_AVAILABILITY` makes every resource bookable on weekdays from 09:00 to 17:00 in its own
  time zone. Slotlock offers a slot only inside rules like these; with none, it offers nothing.
- `SLOTLOCK_CONFIRM_WRITES=all` makes every write an agent proposes wait for a person (step 6).

## 3. Start Slotlock

```sh
{{composeUp}}
curl http://localhost:8080/healthz
```

Compose starts PostgreSQL 16, applies the `slotlock` schema as the database owner, and runs the
server as a role that owns nothing and cannot bypass row-level security. The server is published on
`127.0.0.1:8080` only, and PostgreSQL is not published at all. When the server is ready, the health
check answers:

```json
{"status":"ready","version":"1.0.0","checks":["database"]}
```

## 4. Add a resource

Agents book resources that already exist. Add a vehicle with the `slotlock` command in the server's
container:

```sh
docker compose exec slotlock slotlock resource add vehicle-42 --timezone Europe/London
```

It prints the resource, with the `id` agents will use:

```json
{"id":"…","external_ref":"vehicle-42","timezone":"Europe/London"}
```

## 5. Connect Claude Code

Read the token from `.env`, then add Slotlock as an HTTP MCP server:

```sh
export SLOTLOCK_AUTH_TOKEN="$(sed -n 's/^SLOTLOCK_AUTH_TOKEN=//p' .env)"
{{claudeMcpAdd}}
```

Claude Code keeps the server in `~/.claude.json`, not in the project, so the token stays out of the
repository. Its agent now has the {{toolCount}} `slotlock_*` tools.

## 6. Find a slot and book it

Ask Claude Code:

> When is vehicle-42 free for two hours in the week of 1 March 2027? Book the first slot as a
> vehicle handover.

The agent first calls `slotlock_list_resources` to learn the vehicle's `id`, then
`slotlock_find_next_available` with arguments like these:

```json
{
  "resource_ids": ["…"],
  "start": "2027-03-01T00:00:00Z",
  "end": "2027-03-08T00:00:00Z",
  "duration_minutes": 120
}
```

The vehicle has no bookings and is open from 09:00 London time, which is 09:00 UTC in March, so the
answer is Monday morning, and it is certain:

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

To book it, the agent calls `slotlock_create_event`. Because of `SLOTLOCK_CONFIRM_WRITES=all`,
Slotlock first asks the person: Book "Vehicle handover" on resource …: 2027-03-01 09:00–11:00
(Europe/London), with the resource's `id` in place of the dots. The write runs only if they accept. A client that cannot
show that question (one without MCP 2026-07-28 form elicitation) gets `confirmation_required`, and
nothing is written.

:::note[Trying it on your own?]
To let the agent book without asking, set `SLOTLOCK_CONFIRM_WRITES=none` in `.env` and run
`docker compose up --detach` again. Keep confirmation on for anything real; the
[security model](/docs/security/#confirmation-before-writes) explains it.
:::

Ask for the same two hours again and the second `slotlock_create_event` comes back as
`{"error":{"code":"overlap"}}`: PostgreSQL refused the overlapping write, and the agent can read the
code and look for the next slot instead.

## Next

- [Tools reference](/docs/tools/): every `slotlock_*` tool's input, output and error codes.
- [Concepts](/docs/concepts/): resources, availability rules, holds, certainty and tenancy.
- [Connect an agent](/docs/connect/): other MCP clients, the Claude API, A2A and the SDKs.
- [Use Slotlock from TypeScript](/docs/library/): the same engine as a library, with holds.
- Going further than this machine: put a TLS reverse proxy in front, set `SLOTLOCK_PUBLIC_URL`, and
  work through the [production checklist](https://github.com/PILOTAAI/slotlock#production-checklist).
