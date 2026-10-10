#!/usr/bin/env bash
# Checks the two Cloudflare values the site deploy uses, with Cloudflare itself, and says what is
# wrong when they do not work. It never prints either value.
#
#   CLOUDFLARE_API_TOKEN   an API token; Wrangler sends it as "Authorization: Bearer <token>"
#   CLOUDFLARE_ACCOUNT_ID  the account that holds the pylota.io zone
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/check-cloudflare-credentials.sh
#
# Exits 0 when Cloudflare reports the token active and the token can list the account's Workers
# (which needs both the right account and a Workers permission), and 1 with the reason otherwise.
# site.yml runs it before every deploy; configure-github.sh runs it before it stores the values.
#
# What Cloudflare answers for a value that is not a token, checked against api.cloudflare.com on
# 2026-10-10 with made-up values: "Invalid request headers" (6003, with 6111 "Invalid format for
# Authorization header") for anything shorter than 40 characters or containing a space or a quote,
# such as an account ID or a token's ID (32 hex), an older Global API Key (37 hex) or a cut-off
# paste; "Invalid API Token" (1000) for a well-formed value that is not a live token. Token formats:
# https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/ (cfut_ user token,
# cfat_ account token, cfk_ Global API Key; tokens made before April 2026 are 40 characters).
set -euo pipefail

API=${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}
token=${CLOUDFLARE_API_TOKEN-}
account=${CLOUDFLARE_ACCOUNT_ID-}

fail() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    printf '::error title=Cloudflare credentials::%s\n' "$*"
  else
    printf 'error: %s\n' "$*" >&2
  fi
  exit 1
}

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required (https://jqlang.org)'

# shape VALUE: what a value Cloudflare refused looks like, without repeating it.
shape() {
  local value=$1
  if [[ $value =~ ^[0-9a-f]{32}$ ]]; then
    printf 'It is 32 hexadecimal characters, the shape of an account ID or of a token'"'"'s ID, not the token itself (Cloudflare shows the token once, when it is created)'
  elif [[ $value =~ ^[0-9a-f]{37,45}$ ]]; then
    printf 'It is %s hexadecimal characters, the shape of a Global API Key; Wrangler needs an API token' "${#value}"
  elif [ "${#value}" -lt 40 ]; then
    printf 'It is %s characters long and API tokens have at least 40, so the paste may be cut off' "${#value}"
  else
    printf 'It is shaped like a token, but Cloudflare does not know it: it was rolled, deleted or mistyped'
  fi
}

# Refusals that need no network.
[ -n "$token" ] || fail 'CLOUDFLARE_API_TOKEN is empty.'
[ -n "$account" ] || fail 'CLOUDFLARE_ACCOUNT_ID is empty.'
case "$token" in
  *[[:space:]]*) fail 'CLOUDFLARE_API_TOKEN contains a space or a line break. Paste only the token: no "Bearer", no name.' ;;
  *[\"\'\`]*) fail 'CLOUDFLARE_API_TOKEN contains a quote. Paste the token without quotes.' ;;
  cfk_*) fail 'CLOUDFLARE_API_TOKEN starts with cfk_, so it is a Global API Key. Create an API token instead (site/README.md).' ;;
esac
[ "$token" != "$account" ] || fail 'CLOUDFLARE_API_TOKEN holds the account ID. The two values are swapped or duplicated.'
[[ $account =~ ^[0-9A-Za-z]{1,32}$ ]] ||
  fail 'CLOUDFLARE_ACCOUNT_ID is not an account ID (letters and digits, at most 32). Copy it from the Cloudflare dashboard: Account home, Account ID.'

# cf PATH: GET PATH as the token and print the JSON body. The header reaches curl on stdin, so the
# token is never on a command line.
cf() {
  printf 'Authorization: Bearer %s\n' "$token" |
    curl --silent --show-error --max-time 20 --header @- "$API$1" 2>/dev/null || true
}

# errors BODY: Cloudflare's errors as "code message" pairs, or a note that the body was not JSON.
errors() {
  printf '%s' "$1" | jq -r '[.errors[]? | "\(.code) \(.message)" +
    (if (.error_chain // []) | length > 0 then " (" + ([.error_chain[] | "\(.code) \(.message)"] | join(", ")) + ")" else "" end)]
    | if length == 0 then "no error details" else join("; ") end' 2>/dev/null ||
    printf 'no JSON answer (is api.cloudflare.com reachable?)'
}

active() { printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1; }

# 1. Is it a live token? Account API tokens verify under the account, user API tokens under /user.
kind='account'
verified=$(cf "/accounts/$account/tokens/verify")
if ! active "$verified"; then
  kind='user'
  user_verified=$(cf '/user/tokens/verify')
  if ! active "$user_verified"; then
    fail "Cloudflare refused CLOUDFLARE_API_TOKEN: $(errors "$user_verified"). $(shape "$token"). Create an API token (site/README.md) and store it with scripts/configure-github.sh --site-secrets."
  fi
  verified=$user_verified
fi
status=$(printf '%s' "$verified" | jq -r '.result.status // "unknown"')
[ "$status" = active ] ||
  fail "CLOUDFLARE_API_TOKEN is a $kind API token whose status is $status, not active. Roll it or create a new one (site/README.md)."

# 2. Does it reach Workers in this account? This needs the right account ID and a Workers permission.
scripts=$(cf "/accounts/$account/workers/scripts")
active "$scripts" ||
  fail "CLOUDFLARE_API_TOKEN is an active $kind API token but cannot list Workers in CLOUDFLARE_ACCOUNT_ID: $(errors "$scripts"). Either the account ID is not the account that holds pylota.io, or the token lacks the Workers permissions of the \"Edit Cloudflare Workers\" template (site/README.md)."

printf 'Cloudflare accepts CLOUDFLARE_API_TOKEN (an active %s API token), and it can list Workers in CLOUDFLARE_ACCOUNT_ID.\n' "$kind"
