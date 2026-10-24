#!/bin/sh
# Checks a staged npm version before a maintainer approves it (CONTRIBUTING.md, Releases). Approving
# publishes the tarball release.yml staged, however old it is: 0.2.0 went public 17 hours after main
# had moved zod past a high advisory, because nothing looked again at approval. This refuses a stage:
#   - that is not slotlock, or whose dist-tag is `latest` while approving it would move `latest`
#     backwards (scripts/dist-tag.sh, against the registry's latest now);
#   - whose tarball is not the one the tag's release run tested (the GitHub release's SHA256SUMS);
#   - whose runtime dependencies, as a consumer installs them today, have a high or critical
#     advisory (npm audit --omit=dev), unless each is named with --allow GHSA-xxxx-xxxx-xxxx.
# Run it logged in to npm (as for `npm stage approve`) and gh, from a checkout of this repository:
#   scripts/check-stage.sh <stage-id> [--allow <GHSA id>]...
# Needs npm 11.15 or newer (npm stage), gh, jq, tar and shasum or sha256sum. It approves nothing.
set -eu
usage() {
  echo "usage: scripts/check-stage.sh <stage-id> [--allow <GHSA id>]..." >&2
  exit 2
}
fail() {
  echo "refused: $1" >&2
  exit 1
}
[ "$#" -ge 1 ] || usage
stage_id=$1
shift
allowed=' '
while [ "$#" -gt 0 ]; do
  case $1 in
  --allow)
    [ "$#" -ge 2 ] || usage
    allowed="$allowed$2 "
    shift 2
    ;;
  *) usage ;;
  esac
done
case $stage_id in '' | -* | *[!0-9A-Za-z-]*) usage ;; esac

scripts=$(cd "$(dirname "$0")" && pwd)
. "$scripts/semver.sh"
repository=${SLOTLOCK_REPOSITORY:-PILOTAAI/slotlock}
work=$(mktemp -d "${TMPDIR:-/tmp}/slotlock-stage.XXXXXX")
trap 'rm -rf "$work"' EXIT

# What npm staged: name, version and the dist-tag it will publish under (npm stage view --json gives
# id, packageName, version, tag, createdAt, actor and shasum).
npm stage view "$stage_id" --json >"$work/stage.json" || fail "npm could not show stage $stage_id."
name=$(jq -r '.packageName // empty' "$work/stage.json")
version=$(jq -r '.version // empty' "$work/stage.json")
tag=$(jq -r '.tag // empty' "$work/stage.json")
staged=$(jq -r '.createdAt // "an unknown time"' "$work/stage.json")
[ "$name" = slotlock ] || fail "stage $stage_id is $name, not slotlock."
is_version "$version" || fail "stage $stage_id names version '$version'."
echo "Stage $stage_id: slotlock@$version, dist-tag $tag, staged $staged."

# `latest` only moves forward. A stage's tag is fixed when it is staged, so a later version approved
# first (0.3.0 before 0.2.1) leaves an older stage that would take `latest` back.
current=$(npm view slotlock dist-tags.latest 2>/dev/null || true)
expected=$("$scripts/dist-tag.sh" "$version" "$current")
if [ "$tag" = latest ] && [ "$expected" != latest ]; then
  fail "approving it would move latest from $current back to $version. Reject it (npm stage reject $stage_id) and release it again from a tag; scripts/dist-tag.sh gives it $expected."
fi

# The tarball is the one the tag's release run built and tested: its sha256 is in the release.
(cd "$work" && npm stage download "$stage_id" >/dev/null) || fail "npm could not download stage $stage_id."
tarball=$(find "$work" -maxdepth 1 -name '*.tgz' | head -n 1)
[ -n "$tarball" ] || fail "npm stage download wrote no tarball."
[ "$(tar -xzOf "$tarball" package/package.json | jq -r '.name + "@" + .version')" = "slotlock@$version" ] ||
  fail "the downloaded tarball is not slotlock@$version."
gh release download "v$version" --repo "$repository" --pattern SHA256SUMS --dir "$work" ||
  fail "the GitHub release v$version has no SHA256SUMS: was it built by release.yml?"
want=$(awk -v file="slotlock-$version.tgz" '$2 == file || $2 == "*" file { print $1 }' "$work/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS in release v$version has no line for slotlock-$version.tgz."
if command -v sha256sum >/dev/null 2>&1; then
  have=$(sha256sum "$tarball" | awk '{ print $1 }')
else
  have=$(shasum -a 256 "$tarball" | awk '{ print $1 }')
fi
[ "$have" = "$want" ] ||
  fail "the staged tarball's sha256 is $have, but release v$version tested $want."
echo "Its tarball is the one release v$version built and tested (sha256 $have)."

# Advisories in what a consumer gets today: the tarball's dependencies, resolved from the registry.
mkdir "$work/consumer"
cp "$tarball" "$work/consumer/slotlock.tgz"
printf '{"name":"slotlock-stage-check","version":"0.0.0","private":true,"dependencies":{"slotlock":"file:slotlock.tgz"}}\n' \
  >"$work/consumer/package.json"
(cd "$work/consumer" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null) ||
  fail "npm could not resolve slotlock@$version's dependencies."
# npm audit exits 1 when it finds anything: its JSON report is the answer either way.
(cd "$work/consumer" && npm audit --omit=dev --json >"$work/audit.json") || true
jq -e '.auditReportVersion == 2' "$work/audit.json" >/dev/null ||
  fail "npm audit gave no report (auditReportVersion 2)."
# One line per advisory: GHSA id, severity, package, vulnerable range, title.
jq -r '[.vulnerabilities[].via[] | objects | select(.severity == "high" or .severity == "critical")]
  | unique_by(.url) | .[]
  | "\(.url | split("/") | last)\t\(.severity)\t\(.name)\t\(.range)\t\(.title)"' \
  "$work/audit.json" >"$work/advisories.tsv"
blocking=0
while IFS="$(printf '\t')" read -r ghsa severity package range title; do
  case $allowed in
  *" $ghsa "*) echo "Allowed: $ghsa ($severity) $package $range: $title" ;;
  *)
    echo "Blocking: $ghsa ($severity) $package $range: $title" >&2
    blocking=1
    ;;
  esac
done <"$work/advisories.tsv"
[ "$blocking" -eq 0 ] ||
  fail "slotlock@$version's runtime dependencies have the advisories above. Release a version that moves them, or name each with --allow after recording why in the release notes."

echo "No high or critical advisory blocks slotlock@$version. Approve it with:"
echo "  npm stage approve $stage_id"
