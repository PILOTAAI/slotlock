#!/bin/sh
# Prepares the release of <version> in a checkout of main, for release-version.yml. It sets the
# version in package.json and package-lock.json (npm version), in server.json (the version and the
# image tag) and in slotlock.manifest.json, and turns CHANGELOG.md's "## Unreleased" heading into
# "## <version> - <today, UTC>". Merged to main, that change is a release: tag-release.yml tags it.
# It refuses a version that is not later than package.json's, one already tagged, and a CHANGELOG.md
# whose "## Unreleased" section is missing or empty, since the release notes are that section.
#   scripts/prepare-release.sh <version>      for example 0.1.1, or 0.2.0-rc.1 (no leading v)
# Needs jq, npm and git, and the tags fetched.
set -eu
[ "$#" -eq 1 ] || {
  echo "usage: scripts/prepare-release.sh <version>" >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
new=$1
printf '%s' "$new" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  fail "$new is not a version like 1.2.3 or 1.2.3-rc.1 (no leading v)."
current=$(jq -r .version package.json)

# later A B: A is a later version than B. Major, minor and patch compare as numbers; with those
# equal, a release is later than its prereleases, and two prereleases compare as text.
later() {
  a=$1
  b=$2
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split each core into its three numbers
  set -- ${a%%-*} ${b%%-*}
  IFS=$old_ifs
  [ "$1" -ne "$4" ] && {
    [ "$1" -gt "$4" ]
    return
  }
  [ "$2" -ne "$5" ] && {
    [ "$2" -gt "$5" ]
    return
  }
  [ "$3" -ne "$6" ] && {
    [ "$3" -gt "$6" ]
    return
  }
  case "$a,$b" in
    *-*,*-*) [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | LC_ALL=C sort | tail -n 1)" = "$a" ] ;;
    *-*,*) return 1 ;;
    *,*-*) return 0 ;;
    *) return 1 ;;
  esac
}
later "$new" "$current" || fail "$new is not later than package.json's $current."
if git rev-parse --verify --quiet "refs/tags/v$new" >/dev/null; then
  fail "v$new is already tagged."
fi

grep -q '^## Unreleased$' CHANGELOG.md ||
  fail "CHANGELOG.md has no '## Unreleased' section: add this release's changes under it first."
notes=$(awk '$0 == "## Unreleased" { found = 1; next } found && /^## / { exit } found && NF { print }' CHANGELOG.md)
[ -n "$notes" ] ||
  fail "CHANGELOG.md's '## Unreleased' section is empty: add this release's changes under it first."

# replace FILE OLD NEW: every OLD in FILE becomes NEW, the rest of the file byte for byte.
replace() {
  awk -v old="$2" -v new="$3" '{
    out = ""
    while ((i = index($0, old)) > 0) {
      out = out substr($0, 1, i - 1) new
      $0 = substr($0, i + length(old))
    }
    print out $0
  }' "$1" >"$1.tmp"
  mv "$1.tmp" "$1"
}

date=$(date -u +%Y-%m-%d)
replace CHANGELOG.md '## Unreleased' "## $new - $date"
npm version "$new" --no-git-tag-version --ignore-scripts >/dev/null
replace server.json "\"version\": \"$current\"" "\"version\": \"$new\""
replace server.json "ghcr.io/pilotaai/slotlock:$current" "ghcr.io/pilotaai/slotlock:$new"
replace slotlock.manifest.json "\"version\": \"$current\"" "\"version\": \"$new\""

# Every copy of the version moved, or nothing is committed.
[ "$(jq -r .version package.json)" = "$new" ] || fail "package.json is not at $new."
[ "$(jq -r '.version + " " + .packages[""].version' package-lock.json)" = "$new $new" ] ||
  fail "package-lock.json is not at $new."
[ "$(jq -r .version server.json)" = "$new" ] || fail "server.json's version is not $new."
[ "$(jq -r '.packages[0].identifier' server.json)" = "ghcr.io/pilotaai/slotlock:$new" ] ||
  fail "server.json's image is not ghcr.io/pilotaai/slotlock:$new."
[ "$(jq -r .version slotlock.manifest.json)" = "$new" ] || fail "slotlock.manifest.json is not at $new."
grep -q "^## $new - $date\$" CHANGELOG.md || fail "CHANGELOG.md does not date $new."

echo "Prepared $new (was $current), dated $date."
