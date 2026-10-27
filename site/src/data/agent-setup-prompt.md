Set up Slotlock {{version}} for this project. Slotlock is a calendar for AI agents: each resource
(a car, room, person or machine) is a calendar, and PostgreSQL refuses any double booking.

Read these first, and trust them over anything you remember about Slotlock:
- https://slotlock.pylota.io/llms.txt (an index of the docs, each page also as Markdown)
- https://slotlock.pylota.io/docs/quickstart.md
- https://slotlock.pylota.io/docs/api.md (the REST API) and https://slotlock.pylota.io/openapi.json

Then:
1. Pick how this project uses Slotlock, and tell me which and why before you change anything:
   - Self-hosted server with Docker (agents over MCP, apps over REST). Follow the quickstart:
     `git clone https://github.com/PILOTAAI/slotlock.git`, `cd slotlock && git checkout v{{version}}`,
     `scripts/quickstart-env.sh > .env`,
     `docker compose up --build --detach`, then `curl http://localhost:8080/healthz`.
   - The TypeScript library inside an existing Node.js app: `npm install slotlock@{{version}} postgres`
     (https://slotlock.pylota.io/docs/library.md).
   - A language client against a server: `pip install slotlock`, `cargo add slotlock`,
     `dotnet add package Slotlock.Client`, `go get github.com/PILOTAAI/slotlock/clients/go`, or Maven
     `io.pylota:slotlock:{{version}}` (https://slotlock.pylota.io/docs/clients.md).
2. Create one API key per agent or app, with the narrowest scope: `read`, `write`, or `admin` for
   the application API (`docker compose exec slotlock slotlock key create "<name>" --scope <scopes>`).
   Put keys in the environment (`SLOTLOCK_API_KEY`), never in code or git.
3. Prove it works, and show me the output:
   - `GET /v1/resources` with the key answers 200.
   - Book the same window twice: the second answers `409` with `{"error":{"code":"overlap"}}`.
     That refusal is correct behaviour; handle it by offering another slot, never by retrying.
4. If this project has an agent, connect it to `http://localhost:8080/mcp` with the key as a bearer
   token (https://slotlock.pylota.io/docs/connect.md), and list its `slotlock_*` tools.

Rules: keep `SLOTLOCK_CONFIRM_WRITES` at its default unless I say otherwise; do not expose the
server beyond localhost without TLS and `SLOTLOCK_PUBLIC_URL`; ask me before anything destructive.
