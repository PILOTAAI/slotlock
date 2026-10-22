#!/bin/sh
# Decides whether main holds a release to tag, for tag-release.yml. Prints GITHUB_OUTPUT lines:
#   tag=v<package.json version at <rev>>
#   commit=<the commit the tag names, or will name>
#   release=true    the version has no tag yet, and every release check passes for the release
#                   commit (scripts/check-release-tag.sh --commit)
#   release=false   the version is already tagged on main, or its CHANGELOG heading is not dated
#                   yet (a version in progress); the reason goes to stderr as a notice
# The release commit is the oldest commit of the unbroken run, on <rev>'s first-parent line, of
# commits at which the version is ready: package.json at it, a dated CHANGELOG heading, and
# tag-release.yml present. A run GitHub dropped for a later one (a concurrency group keeps one
# pending run) still tags the commit that made the release, and a version dated before this
# automation existed is tagged where it arrived, so its workflows are the ones that run.
# Exits 1, naming the problem, when a dated, untagged version fails a release check, or when its tag
# is not on main: a version someone meant to release must not be skipped quietly.
# Needs git history with origin/main, and jq.
#   scripts/plan-release.sh [<rev>]       (default HEAD)
set -eu
[ "$#" -le 1 ] || {
  echo "usage: scripts/plan-release.sh [<rev>]" >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
rev=$(git rev-parse --verify --quiet "${1:-HEAD}^{commit}") || fail "${1:-HEAD} is not a commit."
# The walk below would otherwise find a release commit on main behind a commit that is not.
git merge-base --is-ancestor "$rev" refs/remotes/origin/main || fail "$rev is not on main."
version=$(git show "$rev:package.json" | jq -r .version)
tag="v$version"
echo "tag=$tag"

if tagged=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}"); then
  git merge-base --is-ancestor "$tagged" refs/remotes/origin/main \
    || fail "Tag $tag points at $tagged, which is not on main."
  echo "::notice::$tag already exists: nothing to release." >&2
  echo "commit=$tagged"
  echo "release=false"
  exit 0
fi

escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
# dated COMMIT: COMMIT's CHANGELOG.md dates this version.
dated() {
  git show "$1:CHANGELOG.md" 2>/dev/null | grep -Eq "^## $escaped - [0-9]{4}-[0-9]{2}-[0-9]{2}\$"
}
# ready COMMIT: the version is ready to release at COMMIT.
ready() {
  [ "$(git show "$1:package.json" 2>/dev/null | jq -r .version 2>/dev/null)" = "$version" ] \
    && dated "$1" \
    && git cat-file -e "$1:.github/workflows/tag-release.yml" 2>/dev/null
}

if ! dated "$rev"; then
  echo "::notice::CHANGELOG.md does not date $version yet: not a release." >&2
  echo "release=false"
  exit 0
fi
ready "$rev" || fail "$rev has no .github/workflows/tag-release.yml."

commit=$rev
for candidate in $(git rev-list --first-parent "$rev"); do
  ready "$candidate" || break
  commit=$candidate
done

sh "$(dirname "$0")/check-release-tag.sh" "$tag" --commit "$commit" >&2
echo "commit=$commit"
echo "release=true"
