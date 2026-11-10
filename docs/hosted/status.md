# Hosted Slotlock status

Where to see whether hosted Slotlock is up, and how that is kept honest.

## For users

- **Current incidents:** open issues labelled `status`,
  <https://github.com/PILOTAAI/slotlock/issues?q=is%3Aissue%20label%3Astatus%20is%3Aopen>.
  The probe is off until the service opens ([Turning it on](#turning-it-on)); until then, no open
  issue means nothing, not "up".
- **History:** the closed ones, each with the time it opened and the time it recovered.
- **The API's own answer:** once the service is open, `https://slotlock-api.pylota.io/healthz`
  returns `{"status":"ready","version":"…","checks":["database"]}` while the server and its database
  answer, and `503` otherwise.

Planned maintenance is announced the same way, as a `status` issue opened before it starts.

## How it works

Every ten minutes, `.github/workflows/status.yml` runs `scripts/status-probe.sh` on a GitHub-hosted
runner, away from the server it checks. It asks for:

| Part | Request | Up when |
| --- | --- | --- |
| API | `GET https://slotlock-api.pylota.io/healthz` | `200` with `"status":"ready"`, which needs the database |
| Dashboard | `GET https://app.slotlock.pylota.io/dashboard` | `200` |

A part that fails three checks in a row, 20 seconds apart, gets an issue titled "Hosted Slotlock API
is down" or "Hosted Slotlock dashboard is down", once; the next run that finds it up closes the issue
with the time. GitHub may run a scheduled workflow late, most often at the start of an hour, so the
probe runs at seven minutes past and every ten minutes after; an incident shorter than that can go
unrecorded.

## Turning it on

The probe stays off until the service opens, so it raises no incident for a server not yet running.
The repository owner turns it on once:

```sh
gh variable set SLOTLOCK_STATUS_PROBE --repo PILOTAAI/slotlock --body on
```

The first incident creates the `status` label. GitHub turns a scheduled workflow off after 60 days
without repository activity in a public repository; if that happens, re-enable "Hosted status" under
Actions. The probe needs only `issues: write`; it reads nothing private and holds no credential
beyond the run's own token.

## Objectives

What hosted Slotlock aims for each calendar month. These are objectives the service is run to, not
a promise: the [Terms](/TERMS.md) give no service level agreement, and missing one gives no
credit.

| Objective | Target | Measured from |
| --- | --- | --- |
| Calls that succeed | 99.5% | `slotlock_calls_total`: every MCP, A2A and REST call that named an operation, failed when it ended in `internal_error` or a 5xx. A refusal that is the caller's (`forbidden`, `overlap`, `quota_exceeded`, any 4xx) is not a failure |
| Calls under a second at the server | 95% | `slotlock_call_duration_seconds` |
| The API answering the probe | 99.5% of checks | `scripts/status-probe.sh`, above |

A 99.5% month allows about 3 hours 36 minutes of failure. The Prometheus rules in
`docs/hosted/slo-rules.yml` record each ratio and alert when the month's error budget is being spent
14.4 times too fast over an hour (it would be gone in two days) or 6 times over six hours, each
confirmed by a shorter window, and when more than 5% of calls in an hour took over a second.

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the server also sends a span for each call to an
OpenTelemetry collector (OTLP over HTTP, JSON): its protocol, operation, outcome or status and
duration, in the caller's trace when the call carried a `traceparent`. Like the metrics, a span
names no tenant, key, argument or address.

