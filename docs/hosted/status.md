# Hosted Slotlock status

Where to see whether hosted Slotlock is up, and how that is kept honest.

## For users

- **Status page:** <https://stats.uptimerobot.com/F7RQohQzXM>. Uptime by day for the API, the dashboard and the site, checked every
  five minutes by UptimeRobot from outside the servers, with incidents and announcements. It is
  UptimeRobot's free plan, so it has no email subscriptions and no `status.slotlock.pylota.io`
  address yet.
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

Three probes watch from outside the servers they check:

- **The status Worker** (`workers/status`), every five minutes on a Cloudflare Cron Trigger. It
  opens and closes the `status` issues, and also publishes blog posts whose time has come.
- **`.github/workflows/status.yml`** runs `scripts/status-probe.sh` on a GitHub-hosted runner, as a
  backup that keeps working if Cloudflare does not. It is set to every ten minutes, but GitHub runs
  scheduled workflows late: in November 2026 it ran every 3.5 to 10.5 hours.
- **UptimeRobot**, every five minutes from outside GitHub and Cloudflare
  (`scripts/configure-uptime.mjs`). It alerts the maintainers directly, and publishes the status
  page from the same checks. Its heartbeat monitor, which would notice the status Worker stopping,
  needs a paid plan, and the free plan refused it. Until then, nothing watches the Worker itself;
  UptimeRobot still checks the service, and the launch check (`scripts/check-launch.mjs`, every
  three hours) warns when the GitHub probe below has not run for 12 hours.

The Worker and the workflow ask for:

| Part | Request | Up when |
| --- | --- | --- |
| API | `GET https://slotlock-api.pylota.io/healthz` | `200` with `"status":"ready"`, which needs the database |
| Dashboard | `GET https://app.slotlock.pylota.io/dashboard` | `200` |
| Site (the Worker only) | `GET https://slotlock.pylota.io/` | `200` |

A part that fails three checks in a row, 20 seconds apart, gets an issue titled "Hosted Slotlock API
is down", "Hosted Slotlock dashboard is down" or "Slotlock site is down", once. The next run that
finds it up closes the issue, with the time. The Worker and the workflow use the same titles, so
either one opens or closes the same issue. An incident shorter than five minutes can go unrecorded.

## Turning it on

The probe stays off until the service opens, so it raises no incident for a server not yet running.
The repository owner turns it on once:

```sh
gh variable set SLOTLOCK_STATUS_PROBE --repo PILOTAAI/slotlock --body on
```

The first incident creates the `status` label. GitHub turns a scheduled workflow off after 60 days
without repository activity in a public repository; if that happens, re-enable "Hosted status" under
Actions. The workflow needs only `issues: write`; it reads nothing private and holds no credential
beyond the run's own token.

The status Worker deploys from main with `.github/workflows/status-worker.yml`. It needs two secrets
on the `site` environment, which that workflow passes to the Worker:

- `SLOTLOCK_STATUS_GITHUB_TOKEN`: a fine-grained token for this repository alone, with Issues and
  Actions read and write. Without it the Worker only logs what it finds.
- `SLOTLOCK_STATUS_HEARTBEAT_URL`: UptimeRobot's heartbeat URL. `scripts/configure-uptime.mjs`
  stores it on a paid UptimeRobot plan; without it, the Worker sends no heartbeat.

## Objectives

What hosted Slotlock aims for each calendar month. These are objectives the service is run to, not
a promise: the [Terms](/TERMS.md) give no service level agreement, and missing one gives no
credit.

| Objective | Target | Measured from |
| --- | --- | --- |
| Calls that succeed | 99.5% | `slotlock_calls_total`: every MCP, A2A and REST call that named an operation, failed when it ended in `internal_error` or a 5xx. A refusal that is the caller's (`forbidden`, `overlap`, `quota_exceeded`, any 4xx) is not a failure |
| Calls under a second at the server | 95% | `slotlock_call_duration_seconds` |
| The API answering the probe | 99.5% of checks | The status Worker and UptimeRobot, above |

A 99.5% month allows about 3 hours 36 minutes of failure. The Prometheus rules in
`docs/hosted/slo-rules.yml` record each ratio and alert when the month's error budget is being spent
14.4 times too fast over an hour (it would be gone in two days) or 6 times over six hours, each
confirmed by a shorter window, and when more than 5% of calls in an hour took over a second.

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the server also sends a span for each call to an
OpenTelemetry collector (OTLP over HTTP, JSON): its protocol, operation, outcome or status and
duration, in the caller's trace when the call carried a `traceparent`. Like the metrics, a span
names no tenant, key, argument or address.

