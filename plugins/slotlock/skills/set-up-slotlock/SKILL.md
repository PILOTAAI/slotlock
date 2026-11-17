---
name: set-up-slotlock
description: Set Slotlock up for this project, on Slotlock Cloud, a self-hosted server, the TypeScript library or a language client, then prove it works with a real booking and a refused double booking. Use when someone asks to add Slotlock, connect an app or agent to it, or check that a Slotlock setup works.
---

Set up Slotlock for this project. Slotlock is a calendar for AI agents: each resource (a car, room, person or machine) is a calendar, and PostgreSQL refuses any double booking.

Use the latest release, written <version> below: find it with `npm view slotlock version` or at https://github.com/PILOTAAI/slotlock/releases/latest. The server, the library and every client share that version.

Read these first, and trust them over anything you remember about Slotlock. They describe the latest release:
- https://slotlock.pylota.io/llms.txt (an index of the docs, each page also as Markdown)
- https://slotlock.pylota.io/docs/quickstart.md
- https://slotlock.pylota.io/docs/api.md (the REST API) and https://slotlock.pylota.io/openapi.json

Then:
1. Pick how this project uses Slotlock, and tell me which and why before you change anything:
   - Slotlock Cloud, hosted for us, with nothing to deploy (https://slotlock.pylota.io/docs/hosted.md). I sign in with GitHub or Google at https://app.slotlock.pylota.io/dashboard and create the key there; you use `https://slotlock-api.pylota.io` wherever the steps below say `http://localhost:8080`. Writes there take effect at once, without asking a person.
   - Self-hosted server with Docker (agents over MCP, apps over REST). Follow the quickstart: `git clone https://github.com/PILOTAAI/slotlock.git`, `cd slotlock && git checkout v<version>`, `scripts/quickstart-env.sh > .env`, `docker compose up --build --detach`, then `curl http://localhost:8080/healthz`.
   - The TypeScript library inside an existing Node.js app: `npm install slotlock@<version> postgres` (https://slotlock.pylota.io/docs/library.md).
   - A language client against a server: `pip install slotlock==<version>`, `cargo add slotlock@<version>`, `dotnet add package Slotlock.Client -v <version>`, `go get github.com/PILOTAAI/slotlock/clients/go@v<version>`, or Maven `io.pylota:slotlock:<version>` (https://slotlock.pylota.io/docs/clients.md).
2. Create one API key per agent or app, with the narrowest scope: `read`, `write`, or `admin` for the application API (`docker compose exec slotlock slotlock key create "<name>" --scope <scopes>`; on Slotlock Cloud I create it in the dashboard, where `admin` is called Full). Put keys in the environment (`SLOTLOCK_API_KEY`), never in code or git.
3. Prove it works with a `read,admin` key, and show me the output. The writes below use the application API and never wait for a person, so they work whatever `SLOTLOCK_CONFIRM_WRITES` is:
   - `GET /v1/resources` answers 200, and `POST /v1/resources` with `{"external_ref":"setup-check","timezone":"UTC"}` returns the resource's `id`.
   - `PUT /v1/reservations/setup-check-1` with `{"resource_id":"<id>","start":"2030-01-07T09:00:00Z","end":"2030-01-07T10:00:00Z","revision":1}` answers 200. The same body to `/v1/reservations/setup-check-2` answers `409` with `{"error":{"code":"overlap"}}`. That refusal is correct behaviour; handle it by offering another slot, never by retrying.
   - Cancel the first with `DELETE /v1/reservations/setup-check-1?revision=2`.
   - An agent's own booking over MCP is different: it waits for a person to confirm it when `SLOTLOCK_CONFIRM_WRITES` says so; over REST it then answers `428 confirmation_required`.
4. If this project has an agent, connect it to `http://localhost:8080/mcp` with the key as a bearer token (https://slotlock.pylota.io/docs/connect.md), and list its `slotlock_*` tools.

Rules: keep `SLOTLOCK_CONFIRM_WRITES` at its default unless I say otherwise; do not expose the server beyond localhost without TLS and `SLOTLOCK_PUBLIC_URL`; ask me before anything destructive.
