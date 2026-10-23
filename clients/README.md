# Slotlock clients

Slotlock's REST API from Python, Go, Rust, Java and .NET: the agent tools (`/v1/events`,
`/v1/free-busy`, ...) and the [application API](../README.md#application-api) (resources, bookable
hours, holds, reservations, coverage, maintenance). Each client has one method per operation, and
each runs the same scenario against a real server in CI.

| Language | Directory | Needs | Install, until it is on its registry |
| --- | --- | --- | --- |
| Python | [`python`](python) | Python 3.10+, no dependencies | `pip install "git+https://github.com/PILOTAAI/slotlock.git#subdirectory=clients/python"` |
| Go | [`go`](go) | Go 1.22+, no dependencies | `go get github.com/PILOTAAI/slotlock/clients/go@main` |
| Rust | [`rust`](rust) | Rust 1.85+, `ureq`, `serde` | `slotlock = { git = "https://github.com/PILOTAAI/slotlock" }` |
| Java | [`java`](java) | Java 17+, no dependencies | `gradle jar` in `clients/java` |
| .NET | [`dotnet`](dotnet) | .NET 8 or 10, no dependencies | `dotnet pack clients/dotnet/src/Slotlock` |

None is on PyPI, the Go module proxy's tagged versions, crates.io, Maven Central or NuGet yet.

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
SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event slotlock serve --migrate
slotlock key create "Client suites" --scope read,write,admin
```

| Language | Command, in its directory |
| --- | --- |
| Python | `PYTHONPATH=src python -m unittest -v tests/test_client.py` |
| Go | `go test ./...` |
| Rust | `cargo test` |
| Java | `gradle build` |
| .NET | `dotnet run --project tests/Slotlock.Tests` |
