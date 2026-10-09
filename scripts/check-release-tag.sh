#!/bin/sh
# Release guard, run before anything is built or published: the tag is v<package.json version>,
# names a commit on origin/main, that version has a dated CHANGELOG heading, and server.json
# publishes the same version and image tag. Needs git history with origin/main, and jq.
#   scripts/check-release-tag.sh <tag>
set -eu
if [ "$#" -ne 1 ]; then
  echo "usage: scripts/check-release-tag.sh <tag>" >&2
  exit 2
fi
tag="$1"
fail() {
  echo "::error::$1" >&2
  exit 1
}

version=$(jq -r .version package.json)
[ "$tag" = "v$version" ] || fail "Tag $tag does not match package.json version $version (expected v$version)."

commit=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") || fail "Tag $tag does not exist."
git merge-base --is-ancestor "$commit" refs/remotes/origin/main \
  || fail "Tag $tag points at $commit, which is not on main."

escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
grep -Eq "^## $escaped - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" CHANGELOG.md \
  || fail "CHANGELOG.md has no dated heading '## $version - YYYY-MM-DD'."

[ "$(jq -r .version server.json)" = "$version" ] || fail "server.json version is not $version."
[ "$(jq -r '.packages[0].identifier' server.json)" = "ghcr.io/pilotaai/slotlock:$version" ] \
  || fail "server.json image is not ghcr.io/pilotaai/slotlock:$version."

echo "Release $tag: $commit is on main; package.json, CHANGELOG.md and server.json agree on $version."
