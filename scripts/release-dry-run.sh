#!/bin/sh
# The dry run of release-version.yml (dry_run: true), after it has minted the release app's token and
# run scripts/prepare-release.sh: checks the token the run would open and merge the pull request with
# can read this repository and push the release branch, then says what a real run would do. It
# pushes, opens, merges and tags nothing; `git push --dry-run` asks GitHub for push access and sends
# no commit. Run it with dry_run before a first release through the app.
#   GH_TOKEN=<that token> GITHUB_REPOSITORY=<owner/repo> scripts/release-dry-run.sh <version> app|github
set -eu
usage() {
  echo "usage: scripts/release-dry-run.sh <version> app|github" >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
[ "$#" -eq 2 ] || usage
. "$(dirname "$0")/semver.sh"
version=$1
is_version "$version" || usage
case $2 in
app) who='the release app' ;;
github) who='GITHUB_TOKEN' ;;
*) usage ;;
esac
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY names the repository}
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
branch="release/v$version"

[ "$(gh api "repos/$repository" --jq .full_name 2>/dev/null)" = "$repository" ] ||
  fail "the $who token cannot read $repository."
git push --dry-run --quiet origin "HEAD:refs/heads/$branch" 2>/dev/null ||
  fail "the $who token cannot push $branch to origin."

{
  echo "### Dry run: releasing $version as $who"
  echo "The token reads $repository and may push \`$branch\`. A real run would commit these files there,"
  echo "open the pull request, wait for CI and DCO, merge it and tag the release:"
  echo '```'
  git status --porcelain
  echo '```'
  if [ "$2" = github ]; then
    echo "No release app is stored, so a real run opens the pull request as GITHUB_TOKEN, and GitHub holds"
    echo "its checks until someone approves them. An owner of the organization stores the app with"
    echo "\`node scripts/create-release-app.mjs\`."
  fi
} >>"$summary"
