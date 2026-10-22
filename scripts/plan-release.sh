#!/bin/sh
# Decides whether a commit on main is a release, for tag-release.yml. Prints GITHUB_OUTPUT lines:
#   tag=v<package.json version>
#   release=true    the version has no tag yet and a dated CHANGELOG heading, and every other
#                   release check passes for <rev> (scripts/check-release-tag.sh --commit)
#   release=false   the version is already tagged, or its CHANGELOG heading is not dated yet (a
#                   version in progress); the reason goes to stderr as a notice
# Exits 1, naming the problem, when a dated, untagged version fails a release check: a version
# someone meant to release must not be skipped quietly. Needs git history with origin/main, and jq.
#   scripts/plan-release.sh [<rev>]       (default HEAD; run from a checkout of <rev>)
set -eu
[ "$#" -le 1 ] || {
  echo "usage: scripts/plan-release.sh [<rev>]" >&2
  exit 2
}
rev="${1:-HEAD}"
version=$(jq -r .version package.json)
tag="v$version"
echo "tag=$tag"

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "::notice::$tag already exists: nothing to release." >&2
  echo "release=false"
  exit 0
fi

escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
if ! grep -Eq "^## $escaped - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" CHANGELOG.md; then
  echo "::notice::CHANGELOG.md does not date $version yet: not a release." >&2
  echo "release=false"
  exit 0
fi

sh "$(dirname "$0")/check-release-tag.sh" "$tag" --commit "$rev" >&2
echo "release=true"
