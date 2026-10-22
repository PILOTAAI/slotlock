#!/bin/sh
# Puts the release scripts/prepare-release.sh prepared up for merge, for release-version.yml. It
# commits the change on release/v<version> as github-actions[bot], signed off, pushes the branch and
# opens its pull request into main. It prints SHA=<the release commit> and PR=<its number>, for
# GITHUB_ENV, and nothing else on stdout.
#
# A run that stops before its merge leaves its branch, and perhaps its pull request, behind. The
# next run replaces that branch when it holds nothing but one such release commit, and only as it was
# read here (a lease), so a push made since is never lost; an open pull request is reused. A branch
# holding anything else stops the run.
#   scripts/open-release-pr.sh <version>
# Needs git with an origin it can push to and origin/main fetched, and gh logged in (GH_TOKEN).
set -eu
[ "$#" -eq 1 ] || {
  echo "usage: scripts/open-release-pr.sh <version>" >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
version=$1
branch="release/v$version"
server=${GITHUB_SERVER_URL:-https://github.com}
repository=${GITHUB_REPOSITORY:-PILOTAAI/slotlock}
bot='github-actions[bot]'
bot_email='41898282+github-actions[bot]@users.noreply.github.com'

git switch -q -c "$branch" >&2
git add package.json package-lock.json server.json slotlock.manifest.json CHANGELOG.md
git -c user.name="$bot" -c user.email="$bot_email" commit -q -m "Release $version" \
  -m "Signed-off-by: $bot <$bot_email>" >&2
commit=$(git rev-parse HEAD)

lease=''
if [ -n "$(git ls-remote origin "refs/heads/$branch")" ]; then
  git fetch -q origin "refs/heads/$branch" >&2
  lease=$(git rev-parse FETCH_HEAD)
  if [ "$(git rev-list --count "origin/main..$lease")" != 1 ] ||
    [ "$(git log -1 --format='%an %s' "$lease")" != "$bot Release $version" ]; then
    fail "$branch holds commits this workflow did not make. Delete the branch, or release another version."
  fi
  echo "::notice::Replacing $branch, which an earlier run left at $lease." >&2
fi
# With an empty lease the branch must still not exist when the push lands.
git push -q --force-with-lease="refs/heads/$branch:$lease" origin "refs/heads/$branch" >&2

# open_pr: the number of the open pull request from the branch into main, or nothing.
open_pr() {
  gh pr list --repo "$repository" --head "$branch" --base main --state open \
    --json number --jq '.[0].number // empty'
}
pr=$(open_pr)
if [ -z "$pr" ]; then
  run_url="$server/$repository/actions/runs/${GITHUB_RUN_ID:-}"
  body="Prepared by the \"Release a version\" workflow ([run]($run_url)): $version in package.json, package-lock.json, server.json and slotlock.manifest.json, and its CHANGELOG.md section dated. The workflow merges it once CI and DCO pass, then starts Tag release."
  if ! out=$(gh pr create --repo "$repository" --base main --head "$branch" \
    --title "Release $version" --body "$body" 2>&1); then
    printf '%s\n' "$out" >&2
    case $out in
      *'not permitted to create or approve pull requests'*)
        fail "GitHub Actions may not open pull requests in $repository. An admin allows it once: Settings > Actions > General > Workflow permissions > \"Allow GitHub Actions to create and approve pull requests\" ($server/$repository/settings/actions), or scripts/configure-github.sh sets it. If the box cannot be ticked there, the organization holds it: $server/organizations/${repository%%/*}/settings/actions. Then run Release a version again: it replaces the branch this run pushed."
        ;;
    esac
    fail "Could not open the pull request for $branch."
  fi
  pr=$(open_pr)
  [ -n "$pr" ] || fail "Opened the pull request for $branch, but gh cannot find it."
fi
printf 'SHA=%s\nPR=%s\n' "$commit" "$pr"
