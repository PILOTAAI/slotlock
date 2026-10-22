#!/usr/bin/env bash
# Does the parts of a release that npm and GitHub keep for a person, then re-runs what waited on
# them. A Release run's summary names this script when it needs it. It is safe to run again: it
# skips whatever is already done. It only uses the Release and Image runs a push of the tag started
# on the commit the tag names on GitHub.
#
#   scripts/bootstrap-release.sh <tag>              for example v0.1.0
#   scripts/bootstrap-release.sh --dry-run <tag>    show what it would do; change nothing
#
# npm, for release.yml's "Publish on npm" job:
#   - slotlock is not on npm yet. npm accepts a trusted publisher only for a package that exists,
#     so the first version comes from your own npm session: this downloads the tarball the tag's
#     Release run built and tested, checks it against that run's SHA256SUMS, stages it and approves
#     the stage (npm asks for your two-factor code). A laptop has no OIDC identity, so that one
#     version carries no provenance; the GitHub release attaches the same tarball and checksum.
#     No trusted publisher is created yet: npm expires one that has not published within 2 days.
#   - slotlock is on npm, the tag's version is not, and npm has no trusted publisher for it. This
#     creates one for release.yml in the npm environment, allowed to stage only (GOVERNANCE.md,
#     Releases). The re-run below then stages the version within minutes, and that publish
#     validates the publisher. This happens once, at the release after the first.
#   Then it re-runs the Release run's failed jobs.
#
# GHCR, for image.yml's "MCP Registry" job: a new GHCR package is private, GitHub has no API that
# changes that, and the MCP Registry pulls the image anonymously. If the tag's image was pushed
# but cannot be pulled anonymously, this names the settings page, waits while you make it public,
# and re-runs the Image run's failed jobs.
#
# It never asks for, reads or stores an npm token: npm uses the session `npm login` gave you.
# Needs bash 3.2 or newer, gh logged in with write access to PILOTAAI/slotlock, npm 11.15.0 or
# newer (npm stage, npm trust) logged in to an account with two-factor authentication that may
# publish slotlock, jq, curl, tar, and sha256sum or shasum.
set -euo pipefail

REPO=PILOTAAI/slotlock
PACKAGE=slotlock
IMAGE_PATH=pilotaai/slotlock
NPM_MINIMUM=11.15.0
# image.yml's job that pushes the image.
IMAGE_JOB='Build, push and attest'

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
}
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

DRY_RUN=0
TAG=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    v*)
      [ -z "$TAG" ] || die "one tag only (got $TAG and $arg)"
      TAG=$arg
      ;;
    *)
      printf 'unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done
if [ -z "$TAG" ]; then
  usage >&2
  exit 2
fi
VERSION=${TAG#v}
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  die "$TAG is not v<semver>"

WORK_DIR=''
cleanup() {
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# act COMMAND...: runs a command that changes something, or only prints it in a dry run.
act() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  (dry run, not run) %s\n' "$*"
    return 0
  fi
  "$@"
}

# version_at_least HAVE NEED: HAVE >= NEED, comparing major.minor.patch as numbers.
version_at_least() {
  local IFS=.
  local i have need
  read -r -a have <<<"${1%%-*}"
  read -r -a need <<<"$2"
  for i in 0 1 2; do
    [ "${have[i]:-0}" -gt "${need[i]:-0}" ] && return 0
    [ "${have[i]:-0}" -lt "${need[i]:-0}" ] && return 1
  done
  return 0
}

# tag_commit: the commit $TAG names on GitHub (an annotated tag peeled to it), in TAG_COMMIT.
TAG_COMMIT=''
tag_commit() {
  [ -z "$TAG_COMMIT" ] || return 0
  TAG_COMMIT=$(gh api "repos/$REPO/commits/tags/$TAG" --jq .sha) ||
    die "$TAG is not a tag on GitHub, or gh cannot read $REPO"
  printf '%s' "$TAG_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || die "GitHub resolved $TAG to '$TAG_COMMIT'"
}

# latest_run WORKFLOW_FILE: "<id> <status> <conclusion>" of the newest run of it that the tag's push
# started on the tag's commit, or nothing. A run a branch named like the tag started is not one.
latest_run() {
  local runs
  tag_commit
  runs=$(gh run list --repo "$REPO" --workflow "$1" --branch "$TAG" --commit "$TAG_COMMIT" \
    --event push --limit 20 --json databaseId,status,conclusion,headSha,event) ||
    die "gh could not list the $1 runs for $TAG"
  printf '%s' "$runs" | jq -r --arg sha "$TAG_COMMIT" '
    [.[] | select(.headSha == $sha and .event == "push")][0]
    | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"'
}

# rerun_failed WORKFLOW_FILE NAME: re-runs the failed jobs (and the jobs after them) of the newest
# run for $TAG, when it failed.
rerun_failed() {
  local id='' status='' conclusion='' run
  run=$(latest_run "$1") || exit 1
  read -r id status conclusion <<<"$run" || true
  if [ -z "$id" ]; then
    say "  no $2 run for $TAG yet"
    return 0
  fi
  if [ "$status" != completed ]; then
    say "  $2 run $id is $status: nothing to re-run"
    return 0
  fi
  case "$conclusion" in
    failure | cancelled | timed_out)
      act gh run rerun "$id" --failed --repo "$REPO"
      say "  $2 run $id: failed jobs re-run (https://github.com/$REPO/actions/runs/$id)"
      ;;
    *) say "  $2 run $id: $conclusion, nothing to re-run" ;;
  esac
}

# on_npm SPEC: true when npm has SPEC (a package, or package@version) published.
on_npm() {
  [ -n "$(npm view "$1" version 2>/dev/null || true)" ]
}

npm_login() {
  local who
  [ "$DRY_RUN" -eq 0 ] || return 0
  who=$(npm whoami 2>/dev/null) || die "npm has no session: run npm login (with two-factor authentication), then this again"
  say "  npm session: $who"
}

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check SHA256SUMS
  else
    shasum -a 256 --check SHA256SUMS
  fi
}

# first_publish: stages the tag's tested tarball from this session and approves it.
first_publish() {
  local id='' status='' conclusion='' run tarball spec dist_tag stage_id='' escaped
  run=$(latest_run release.yml) || exit 1
  read -r id status conclusion <<<"$run" || true
  [ -n "$id" ] || die "the push of $TAG ($TAG_COMMIT) started no Release run yet"
  [ "$status" = completed ] || die "Release run $id is $status: run this again when it has finished"

  WORK_DIR=$(mktemp -d)
  gh run download "$id" --repo "$REPO" --name npm-package --dir "$WORK_DIR" ||
    die "Release run $id has no npm-package artifact: its build job must pass first (re-run it)"
  (cd "$WORK_DIR" && sha256_check >/dev/null) ||
    die "the npm-package artifact of Release run $id does not match its SHA256SUMS"
  tarball=$(awk 'NR == 1 { print $2 }' "$WORK_DIR/SHA256SUMS")
  [ "$tarball" = "$PACKAGE-$VERSION.tgz" ] ||
    die "Release run $id packed '$tarball', not $PACKAGE-$VERSION.tgz"
  spec=$(tar -xzOf "$WORK_DIR/$tarball" package/package.json | jq -r '"\(.name)@\(.version)"')
  [ "$spec" = "$PACKAGE@$VERSION" ] || die "$tarball holds $spec, not $PACKAGE@$VERSION"
  say "  $tarball: Release run $id's tested artifact, checksum verified"

  dist_tag=latest
  case "$VERSION" in *-*) dist_tag=next ;; esac
  npm_login
  # A version already staged cannot be staged again; approve that one instead. 1.2.3 is not
  # 1.2.3-rc.1: the version must not run on into more version characters.
  escaped=$(printf '%s' "$VERSION" | sed 's/[.+]/\\&/g')
  if npm stage list "$PACKAGE" 2>/dev/null | grep -Eq "(^|[^0-9A-Za-z.+-])$escaped([^0-9A-Za-z.+-]|\$)"; then
    say "  $PACKAGE@$VERSION is already staged:"
    npm stage list "$PACKAGE"
  elif [ "$DRY_RUN" -eq 1 ]; then
    act npm stage publish "$WORK_DIR/$tarball" --access public --tag "$dist_tag"
  else
    npm stage publish "$WORK_DIR/$tarball" --access public --tag "$dist_tag" | tee "$WORK_DIR/stage.log"
    # npm prints "+ slotlock@<version> (staged with id <stage-id>)".
    stage_id=$(sed -n 's/^+ .* (staged with id \([^)]*\))$/\1/p' "$WORK_DIR/stage.log")
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    act npm stage approve '<stage-id>'
    return 0
  fi
  if [ -z "$stage_id" ]; then
    IFS= read -r -p "  Stage id of $PACKAGE@$VERSION (from npm stage list $PACKAGE): " stage_id || true
    [ -n "$stage_id" ] || die "nothing approved: npm stage approve <stage-id>, then run this again"
  fi
  act npm stage approve "$stage_id"
  say "  $PACKAGE@$VERSION approved (dist-tag $dist_tag)"
}

# trusted_publisher: creates the trusted publisher release.yml uses, unless the package has one.
trusted_publisher() {
  local configs
  npm_login
  # npm prints nothing for a package with none, and {"error": ...} on stdout when it fails.
  configs=$(npm trust list "$PACKAGE" --json 2>/dev/null) ||
    die "npm trust list $PACKAGE failed; run it yourself to see why, then this again"
  if printf '%s' "$configs" | jq -e 'type == "object" and has("error")' >/dev/null 2>&1; then
    die "npm trust list $PACKAGE failed: $(printf '%s' "$configs" | jq -c .error)"
  fi
  if printf '%s' "$configs" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
    say "  $PACKAGE already has a trusted publisher (npm allows one per package):"
    printf '%s\n' "$configs" | jq . | sed 's/^/    /'
    say "  One that did not publish within 2 days of its creation has expired. If the publish job"
    say "  still fails, revoke it (npm trust revoke $PACKAGE --id <id>) and run this again."
    return 0
  fi
  act npm trust github "$PACKAGE" --file release.yml --repository "$REPO" \
    --environment npm --allow-stage-publish
  say "  trusted publisher: $REPO, release.yml, environment npm, stage publish only"
}

# image_public: true when the tag's image can be pulled anonymously, as the MCP Registry pulls it.
# GHCR refuses an anonymous token for a private or missing package (403).
image_public() {
  local token
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$IMAGE_PATH:pull" 2>/dev/null |
    jq -r '.token // empty') || return 1
  [ -n "$token" ] || return 1
  curl -fsS -o /dev/null -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/$IMAGE_PATH/manifests/$VERSION" 2>/dev/null
}

image() {
  local id='' status='' conclusion='' run pushed attempt
  run=$(latest_run image.yml) || exit 1
  read -r id status conclusion <<<"$run" || true
  if image_public; then
    say "  ghcr.io/$IMAGE_PATH:$VERSION pulls anonymously"
  elif [ -z "$id" ]; then
    say "  no Image run for $TAG yet: run this again when it has finished"
    return 0
  elif [ "$status" != completed ]; then
    say "  Image run $id is $status: run this again when it has finished"
    return 0
  else
    pushed=$(gh run view "$id" --repo "$REPO" --json jobs \
      --jq ".jobs[] | select(.name == \"$IMAGE_JOB\") | .conclusion") ||
      die "gh could not read Image run $id"
    if [ "$pushed" != success ]; then
      say "  Image run $id did not push the image ($IMAGE_JOB: ${pushed:-not run})"
      rerun_failed image.yml Image
      return 0
    fi
    say "  ghcr.io/$IMAGE_PATH is private. Make it public (GitHub has no API for this; it cannot be undone):"
    say "    https://github.com/orgs/PILOTAAI/packages/container/package/slotlock"
    say "    Package settings > Danger Zone > Change visibility > Public"
    say "  If Public is not offered, allow public packages first: organization Settings > Packages."
    [ "$DRY_RUN" -eq 0 ] || return 0
    for attempt in 1 2 3 4 5; do
      IFS= read -r -p "  Press Enter once it is public ($attempt of 5): " _ || die "stopped before the image was public"
      image_public && break
      say "  still not pullable anonymously"
    done
    image_public || die "ghcr.io/$IMAGE_PATH:$VERSION still cannot be pulled anonymously"
    say "  ghcr.io/$IMAGE_PATH:$VERSION pulls anonymously"
  fi
  rerun_failed image.yml Image
}

command -v gh >/dev/null 2>&1 || die 'gh is required (https://cli.github.com)'
command -v jq >/dev/null 2>&1 || die 'jq is required (https://jqlang.org)'
command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v npm >/dev/null 2>&1 || die "npm $NPM_MINIMUM or newer is required"
version_at_least "$(npm --version)" "$NPM_MINIMUM" ||
  die "npm $(npm --version) has no npm stage or npm trust: install npm $NPM_MINIMUM or newer"
[ "$DRY_RUN" -eq 0 ] || say "Dry run: nothing is changed."
tag_commit
say "$TAG names $TAG_COMMIT"

step "npm: $PACKAGE@$VERSION"
if on_npm "$PACKAGE@$VERSION"; then
  say "  $PACKAGE@$VERSION is on npm"
elif ! on_npm "$PACKAGE"; then
  first_publish
  say "  No trusted publisher yet: npm expires one that has not published within 2 days. The next"
  say "  release's publish job asks for this script again, and the publisher it creates publishes then."
else
  trusted_publisher
fi
rerun_failed release.yml Release

step "GHCR: ghcr.io/$IMAGE_PATH:$VERSION"
image
