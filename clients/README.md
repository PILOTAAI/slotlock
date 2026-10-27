# Slotlock clients

Slotlock's REST API from Python, Go, Rust, Java and .NET: the agent tools (`/v1/events`,
`/v1/free-busy`, ...) and the [application API](../README.md#application-api) (resources, bookable
hours, holds, reservations, coverage, maintenance). Each client has one method per operation, and
each runs the same scenario against a real server in CI.

| Language | Directory | Needs | Install |
| --- | --- | --- | --- |
| Python | [`python`](python) | Python 3.10+, no dependencies | `pip install slotlock` |
| Go | [`go`](go) | Go 1.22+, no dependencies | `go get github.com/PILOTAAI/slotlock/clients/go` |
| Rust | [`rust`](rust) | Rust 1.85+, `ureq`, `serde` | `cargo add slotlock` |
| Java | [`java`](java) | Java 17+, no dependencies | `io.pylota:slotlock` from Maven Central |
| .NET | [`dotnet`](dotnet) | .NET 8 or 10, no dependencies | `dotnet add package Slotlock.Client` |

Each release publishes every client at the package's version, once its tests have passed and a
maintainer has approved each registry: `slotlock` on PyPI and crates.io, `Slotlock.Client` on NuGet,
`io.pylota:slotlock` on Maven Central, and the Go module's `clients/go/v<version>` tags
([docs/release/clients.md](../docs/release/clients.md)).

## What they share

- **A key.** Pass the server's URL (its `SLOTLOCK_PUBLIC_URL`) and an API key. The agent tools need
  `read` or `write`; the application API needs `admin`
  (`slotlock key create "Booking site" --scope read,write,admin`).
- **Errors.** A refusal carries the HTTP status and the server's code: `409 overlap` for a taken
  window, `428 confirmation_required` for a write that waits for a person, `404 resource_not_found`,
  `403 forbidden` for a key without the scope, `http_<status>` when the answer has no code (a
  non-JSON error page, an empty body). `retry_after` comes with a 429 or 503 whose `Retry-After`
  says how long to wait, in seconds or as an HTTP date (`Wed, 21 Oct 2015 07:28:00 GMT`, read as
  the time left, never below zero); either is capped at a day, and any other value is no wait.
- **Null clears.** An optional argument that may be null (`update_event`'s title, description,
  location, organizer and recurrence rule) has three states: left out keeps the value, null clears
  it, a value sets it. A required one that may be null (`rules`) sends null or a value, which differ:
  null is the server's default hours, `[]` is never bookable.
- **Safe defaults.** Plain HTTP is refused except to `localhost`, `127.0.0.1` and `::1`, since it
  would send the key unencrypted. With the HTTP client it makes itself, a client for one of those
  reaches it directly, never through a proxy from the environment; elsewhere each platform's usual
  proxy settings apply. No redirect is followed: a 3xx is a refusal (`http_302`), so the key goes
  with no other request. A path argument of `.` or `..` is refused before any request, since the
  server would read it as a path segment. The timeout covers the whole call, the response body
  included. A client never prints its key.

## Generated from the server

[`openapi.json`](../openapi.json) is the REST API as the server describes it, and
[`generate.ts`](generate.ts) writes each client's operations from it (`_operations.py`,
`operations.go`, `operations.rs`, `SlotlockOperations.java`, `SlotlockClient.Operations.g.cs`). The
transports beside them are written by hand. After a change to the server:

```sh
SLOTLOCK_WRITE_GENERATED=1 npx vitest run src/__tests__/generated.test.ts
```

The repository's tests fail while `openapi.json` or a generated file is stale.

## Testing a client

Each suite checks what it can without a server, and runs the full scenario when `SLOTLOCK_URL` and
`SLOTLOCK_ADMIN_KEY` point at one that confirms only deletes:

```sh
export DATABASE_URL=postgresql://slotlock_app:…@localhost:5432/slotlock
export SLOTLOCK_MIGRATE_DATABASE_URL=postgresql://<owner>:…@localhost:5432/slotlock
export SLOTLOCK_CONFIRMATION_SECRET="$(openssl rand -hex 32)"
npx slotlock migrate      # first, so the key below has a schema to go in
export SLOTLOCK_ADMIN_KEY="$(npx slotlock key create "Client suites" --scope read,write,admin | jq -r .key)"
SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event npx slotlock serve &
export SLOTLOCK_URL=http://localhost:8080
until curl -fs "$SLOTLOCK_URL/healthz" > /dev/null; do sleep 1; done
```

| Language | Command, in its directory |
| --- | --- |
| Python | `PYTHONPATH=src python -m unittest -v tests/test_client.py` |
| Go | `go test ./...` |
| Rust | `cargo test` |
| Java | `gradle build` |
| .NET | `dotnet run --project tests/Slotlock.Tests` |
