#!/bin/sh
# Publishes the Go client at <version>, for release.yml's go-module job. A Go module version is a
# tag: here the annotated tag clients/go/v<version> on the release commit, pushed to origin (the
# module is github.com/PILOTAAI/slotlock/clients/go, so its tags carry that directory as a prefix).
# The job runs only after the release suite has passed and a maintainer has approved the go-module
# environment, and then asks the Go module proxy for the version, which records it for go get and
# pkg.go.dev. A re-run finds the tag on origin naming the release commit and pushes nothing; a tag
# naming another commit stops it, since a published module version must never change.
#   scripts/tag-go-module.sh <version> <commit>
# Needs git with an origin it can push tags to.
set -eu
[ "$#" -eq 2 ] || {
  echo "usage: scripts/tag-go-module.sh <version> <commit>" >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
. "$(dirname "$0")/semver.sh"
version=$1
is_version "$version" || {
  echo "::error::$version is not a version like 1.2.3 or 1.2.3-rc.1 (no leading v)." >&2
  exit 2
}
commit=$(git rev-parse --verify --quiet "$2^{commit}") || fail "$2 is not a commit."
tag="clients/go/v$version"

module=$(git show "$commit:clients/go/go.mod" 2>/dev/null | sed -n 's/^module //p')
[ "$module" = github.com/PILOTAAI/slotlock/clients/go ] ||
  fail "clients/go/go.mod at $commit names module '$module', not github.com/PILOTAAI/slotlock/clients/go."

# The commit the tag names on origin, peeled when it is annotated.
remote=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" |
  awk '$2 ~ /\^\{\}$/ { peeled = $1 } { plain = $1 } END { print peeled ? peeled : plain }')
if [ -n "$remote" ]; then
  [ "$remote" = "$commit" ] || fail "$tag already names $remote on origin, not $commit: a module version never moves."
  echo "$tag already names $commit on origin: nothing to push."
  exit 0
fi

git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  tag -a "$tag" -m "Slotlock Go client $version" "$commit"
git push --quiet origin "refs/tags/$tag"
echo "Pushed $tag on $commit."
