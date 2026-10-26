#!/bin/sh
# Hosted Slotlock's public status, for status.yml: probes the API's /healthz and the dashboard from
# GitHub's runners, off the server they check, and keeps one open issue labelled `status` for each
# part that is down. Open `status` issues are the current incidents; closed ones are the history
# (docs/hosted/status.md). A part is down when three checks in a row fail, so one dropped request
# opens nothing.
#   GH_TOKEN=<issues: write> GITHUB_REPOSITORY=<owner/repo> scripts/status-probe.sh
# SLOTLOCK_STATUS_API and SLOTLOCK_STATUS_DASHBOARD override the URLs, and
# SLOTLOCK_STATUS_RETRY_SECONDS the wait between checks (20). Needs curl, gh and jq.
set -eu
api=${SLOTLOCK_STATUS_API:-https://slotlock-api.pylota.io}
dashboard=${SLOTLOCK_STATUS_DASHBOARD:-https://app.slotlock.pylota.io}
wait=${SLOTLOCK_STATUS_RETRY_SECONDS:-20}
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY names the repository whose issues hold the status}
work=$(mktemp -d "${TMPDIR:-/tmp}/slotlock-status.XXXXXX")
trap 'rm -rf "$work"' EXIT
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# probe NAME URL: one check, true when the part is up; why it is not is left in $work/NAME.why.
probe() {
  code=$(curl --silent --show-error --max-time 10 --output "$work/$1.body" \
    --write-out '%{http_code}' "$2" 2>"$work/$1.err") || code=000
  case $1 in
  # serve answers 200 {"status":"ready",...} only while its database answers.
  api) [ "$code" = 200 ] && jq -e '.status == "ready"' "$work/$1.body" >/dev/null 2>&1 && return 0 ;;
  *) [ "$code" = 200 ] && return 0 ;;
  esac
  if [ "$code" = 000 ]; then
    printf 'no answer: %s' "$(head -c 200 "$work/$1.err")" >"$work/$1.why"
  elif [ "$code" = 200 ]; then
    # The API answered, but not ready: say what it said rather than "HTTP 200".
    status=$(jq -r 'if (.status | type) == "string" then .status else empty end' "$work/$1.body" \
      2>/dev/null | head -c 100) || status=''
    printf 'not ready: %s' "${status:-no status in the answer}" >"$work/$1.why"
  else
    printf 'HTTP %s' "$code" >"$work/$1.why"
  fi
  return 1
}

# check NAME URL TITLE: three tries, then open or close the part's issue.
check() {
  name=$1 url=$2 title=$3
  tries=0
  until probe "$name" "$url"; do
    tries=$((tries + 1))
    [ "$tries" -lt 3 ] || break
    sleep "$wait"
  done
  open=$(gh issue list --repo "$repository" --label status --state open --limit 100 \
    --json number,title | jq -r --arg title "$title" '.[] | select(.title == $title) | .number' | head -n 1)
  if [ "$tries" -lt 3 ]; then
    echo "$name: up ($url)"
    if [ -n "$open" ]; then
      gh issue close "$open" --repo "$repository" --comment "Up again: $url answered at $(now)."
      echo "$name: closed #$open"
    fi
  else
    echo "$name: down ($url: $(cat "$work/$name.why"))"
    if [ -z "$open" ]; then
      gh label create status --repo "$repository" --color B60205 \
        --description 'Hosted Slotlock is down: open issues are current incidents' --force >/dev/null
      gh issue create --repo "$repository" --label status --title "$title" --body "$url failed three checks in a row from GitHub Actions, the last at $(now): $(cat "$work/$name.why").

This issue closes itself when it answers again. Self-hosted Slotlock is not affected."
    fi
  fi
}

check api "$api/healthz" 'Hosted Slotlock API is down'
check dashboard "$dashboard/dashboard" 'Hosted Slotlock dashboard is down'
