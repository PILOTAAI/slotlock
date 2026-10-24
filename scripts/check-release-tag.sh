#!/bin/sh
# Release guard, run before anything is built or published: the tag is v<package.json version>,
# names a commit on origin/main, which is the commit checked out, that version has a dated
# CHANGELOG heading, server.json publishes the same version and image tag, and every language client
# carries that version (scripts/client-versions.sh). Every file is read as that commit has it. Needs
# git history with origin/main, and jq.
#   scripts/check-release-tag.sh <tag>
#   scripts/check-release-tag.sh <tag> --commit <rev>
# With --commit the tag need not exist yet: <rev> is checked as the commit it will name, which is
# how scripts/plan-release.sh vets a release before tag-release.yml creates the tag.
set -eu
usage() {
  echo "usage: scripts/check-release-tag.sh <tag> [--commit <rev>]" >&2
  exit 2
}
[ "$#" -eq 1 ] || [ "$#" -eq 3 ] || usage
tag="$1"
rev=''
if [ "$#" -eq 3 ]; then
  [ "$2" = "--commit" ] || usage
  rev="$3"
fi
fail() {
  echo "::error::$1" >&2
  exit 1
}

if [ -n "$rev" ]; then
  commit=$(git rev-parse --verify --quiet "$rev^{commit}") || fail "$rev is not a commit."
  subject="Commit $commit"
else
  commit=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") || fail "Tag $tag does not exist."
  subject="Tag $tag points at $commit, which"
  # A workflow run on a branch named like the tag checks out that branch, not the tag: what it
  # builds must be the commit the tag names.
  head=$(git rev-parse --verify --quiet 'HEAD^{commit}') || fail "Nothing is checked out."
  [ "$head" = "$commit" ] || fail "The checkout is $head, not $commit, which tag $tag names."
fi
# at FILE: FILE as the commit under check has it.
at() {
  git show "$commit:$1"
}

version=$(at package.json | jq -r .version)
[ "$tag" = "v$version" ] || fail "Tag $tag does not match package.json version $version (expected v$version)."

git merge-base --is-ancestor "$commit" refs/remotes/origin/main \
  || fail "$subject is not on main."

escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
at CHANGELOG.md | grep -Eq "^## $escaped - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" \
  || fail "CHANGELOG.md has no dated heading '## $version - YYYY-MM-DD'."

[ "$(at server.json | jq -r .version)" = "$version" ] || fail "server.json version is not $version."
[ "$(at server.json | jq -r '.packages[0].identifier')" = "ghcr.io/pilotaai/slotlock:$version" ] \
  || fail "server.json image is not ghcr.io/pilotaai/slotlock:$version."

. "$(dirname "$0")/client-versions.sh"
if lagging=$(client_versions_check "$version" "$commit"); then :; else
  fail "$lagging does not name version $version."
fi

echo "Release $tag: $commit is on main; package.json, CHANGELOG.md and server.json agree on $version."
