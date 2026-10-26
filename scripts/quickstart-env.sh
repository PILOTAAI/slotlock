#!/bin/sh
# Prints .env.example with each secret it leaves empty filled in, for the Docker Compose quickstart:
#   scripts/quickstart-env.sh > .env
#   docker compose up --build
# Each secret is its own `openssl rand -hex 32`, as .env.example asks; hex keeps the two database
# passwords safe inside a postgres:// URL. Every other line is copied as it is, so the dashboard
# stays off (its four settings stay empty) and the optional settings keep their examples. CI runs the
# quickstart from this file (ci.yml, Compose quickstart).
# Needs openssl. Run it from the repository root.
set -eu
[ "$#" -eq 0 ] || {
  echo "usage: scripts/quickstart-env.sh > .env" >&2
  exit 2
}
[ -f .env.example ] || {
  echo "error: no .env.example here; run this from the repository root" >&2
  exit 1
}
while IFS= read -r line || [ -n "$line" ]; do
  case $line in
  POSTGRES_PASSWORD= | SLOTLOCK_APP_DB_PASSWORD= | SLOTLOCK_AUTH_TOKEN= | SLOTLOCK_CONFIRMATION_SECRET=)
    printf '%s%s\n' "$line" "$(openssl rand -hex 32)"
    ;;
  *) printf '%s\n' "$line" ;;
  esac
done <.env.example
