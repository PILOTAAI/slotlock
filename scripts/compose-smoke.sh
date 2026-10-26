#!/usr/bin/env bash
# Runs the Docker Compose quickstart as the README gives it and checks it end to end, for CI:
#   1. docker compose up --build: PostgreSQL, the db-roles and migrate one-off services, the server.
#   2. Both one-off services exit 0, and the server reports healthy.
#   3. An admin key from `slotlock key create` passes scripts/smoke-deployment.mjs.
#   4. docker compose down, then up again: the smoke resource is still there, so the data lives on
#      the volume (PostgreSQL 18 keeps it under /var/lib/postgresql/18/docker).
#   5. docker compose down --volumes.
#   scripts/compose-smoke.sh [<settings file>]      default .env, as the README writes it
# Needs the settings file (scripts/quickstart-env.sh > .env), docker with Compose v2, node, jq and
# curl. Run it in a throwaway checkout: step 5 deletes the quickstart's volume.
set -euo pipefail

ENV_FILE=${1:-.env}
say() { printf '%s\n' "$*"; }
compose() { docker compose --env-file "$ENV_FILE" "$@"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  compose ps --all >&2 || true
  compose logs --no-color >&2 || true
  exit 1
}
[ -f "$ENV_FILE" ] || {
  printf '::error::no %s: write it with scripts/quickstart-env.sh first\n' "$ENV_FILE" >&2
  exit 1
}
# The URL the server names itself by, as docker-compose.yml defaults it: the smoke check compares it
# with the OpenAPI document's server.
PORT=$(sed -n 's/^SLOTLOCK_PORT=//p' "$ENV_FILE")
URL=$(sed -n 's/^SLOTLOCK_PUBLIC_URL=//p' "$ENV_FILE")
URL=${URL:-http://localhost:${PORT:-8080}}
# Whatever happens, the quickstart's containers and volume go with the run.
trap 'compose down --volumes >/dev/null 2>&1 || true' EXIT

# wait_healthy: the server container reports healthy within two minutes.
wait_healthy() {
  local id health=starting
  for _ in $(seq 1 60); do
    id=$(compose ps --quiet slotlock)
    if [ -n "$id" ]; then
      health=$(docker inspect --format '{{.State.Health.Status}}' "$id")
      [ "$health" = healthy ] && return 0
    fi
    sleep 2
  done
  fail "the slotlock service is ${health}, not healthy"
}

# exited_cleanly SERVICE: the one-off SERVICE ran and exited 0.
exited_cleanly() {
  local id code
  id=$(compose ps --all --quiet "$1")
  [ -n "$id" ] || fail "the $1 service never ran"
  code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
  [ "$code" = 0 ] || fail "the $1 service exited $code"
}

say "== docker compose up --build"
compose up --build --detach
wait_healthy
exited_cleanly db-roles
exited_cleanly migrate
curl --fail --silent --show-error "$URL/healthz"
say ''

say "== an admin key, and the deployment smoke check"
key=$(compose exec -T slotlock slotlock key create "Compose quickstart" --scope read,write,admin | jq -r .key)
[[ "$key" =~ ^slk_[0-9A-Za-z]{46}$ ]] || fail "slotlock key create printed no key"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$key"
SLOTLOCK_URL="$URL" SLOTLOCK_ADMIN_KEY="$key" node scripts/smoke-deployment.mjs ||
  fail "the deployment smoke check failed"

say "== docker compose down, then up on the same volume"
compose down
compose up --detach
wait_healthy
resources=$(curl --fail --silent --show-error -H "Authorization: Bearer $key" "$URL/v1/resources")
jq -e '[.resources[].external_ref] | index("slotlock-smoke") != null' <<<"$resources" >/dev/null ||
  fail "after a restart the smoke resource is gone: the database is not on the volume"
say "the key and the smoke resource survived the restart"

compose down --volumes
