#!/bin/sh
# Publishes the Java client to Maven Central, for release.yml's maven-central job. Maven Central has
# no trusted publishing: the Central Portal takes a user token. The human gate is the maintainer's
# approval of the maven-central environment, as for PyPI, crates.io and NuGet: once the job runs, the
# upload publishes itself when Central has validated it (publishingType=AUTOMATIC), and this script
# waits until Central says PUBLISHED. With USER_MANAGED, a second click in the Central Portal was
# needed, and four releases in a row stayed unpublished without it (docs/release/clients.md).
#   CENTRAL_PORTAL_TOKEN=<base64 of username:password> scripts/central-bundle.sh <repository> <version>
# CENTRAL_POLL_SECONDS (default 15) and CENTRAL_WAIT_MINUTES (default 30) pace the wait.
# <repository> is the local Maven repository Gradle's maven-publish wrote (clients/java:
# gradle publishMavenPublicationToBundleRepository). Every file of io/pylota/slotlock/<version> must
# carry a .asc signature and .md5 and .sha1 checksums, as Central requires
# (central.sonatype.org/publish/requirements); the bundle is that directory in the Maven repository
# layout, without Gradle's maven-metadata.xml. The token travels in a header file, never on a
# command line. API: central.sonatype.org/publish/publish-portal-api (read 2026-10-24).
# Needs curl and zip.
set -eu
[ "$#" -eq 2 ] || {
  echo "usage: CENTRAL_PORTAL_TOKEN=... scripts/central-bundle.sh <repository> <version>" >&2
  exit 2
}
[ -n "${CENTRAL_PORTAL_TOKEN:-}" ] || {
  echo "::error::CENTRAL_PORTAL_TOKEN is not set: the maven-central environment needs it (docs/release/clients.md)." >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
repository=$1
version=$2
path="io/pylota/slotlock/$version"
[ -d "$repository/$path" ] || fail "$repository has no $path: run gradle publishMavenPublicationToBundleRepository first."

for file in "$repository/$path"/*; do
  case $file in *.asc | *.md5 | *.sha1 | *.sha256 | *.sha512) continue ;; esac
  for extension in asc md5 sha1; do
    [ -f "$file.$extension" ] || fail "$(basename "$file") has no .$extension: Central refuses the deployment."
  done
done

work=$(mktemp -d "${TMPDIR:-/tmp}/slotlock-central.XXXXXX")
trap 'rm -rf "$work"' EXIT
(cd "$repository" && zip -q -r "$work/bundle.zip" "$path")
printf 'Authorization: Bearer %s\n' "$CENTRAL_PORTAL_TOKEN" >"$work/headers"
deployment=$(curl --fail-with-body --silent --show-error --header "@$work/headers" \
  --form "bundle=@$work/bundle.zip" \
  "https://central.sonatype.com/api/v1/publisher/upload?publishingType=AUTOMATIC&name=slotlock-$version")
# The answer is the deployment's id, which goes into the status URL below.
case $deployment in
  '' | *[!0-9A-Za-z-]*) fail "the Central Portal answered the upload with something other than a deployment id." ;;
esac
echo "Uploaded slotlock $version to the Central Portal as deployment $deployment; it publishes once validated."

# Wait for Central's verdict. PUBLISHING means it is already on its way to Maven Central and cannot be
# stopped, so a wait that ends there succeeds; one that ends before publishing started fails, so a
# deployment that never publishes is a red job, not a silent gap.
poll=${CENTRAL_POLL_SECONDS:-15}
deadline=$(($(date +%s) + ${CENTRAL_WAIT_MINUTES:-30} * 60))
state=
while :; do
  answer=$(curl --fail-with-body --silent --show-error --request POST --header "@$work/headers" \
    "https://central.sonatype.com/api/v1/publisher/status?id=$deployment" | tr -d '\n')
  state=$(printf '%s' "$answer" | sed -n 's/.*"deploymentState"[[:space:]]*:[[:space:]]*"\([A-Z_]*\)".*/\1/p')
  case $state in
    PUBLISHED)
      echo "Maven Central has slotlock $version (io.pylota:slotlock). repo1.maven.org can take a few minutes more to serve it."
      exit 0
      ;;
    FAILED)
      fail "Central refused deployment $deployment: $(printf '%s' "$answer" | cut -c1-1500)"
      ;;
    PENDING | VALIDATING | VALIDATED | PUBLISHING) ;;
    *) fail "the Central Portal answered the status of deployment $deployment without a known state: $(printf '%s' "$answer" | cut -c1-300)" ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$state" = PUBLISHING ]; then
      echo "Deployment $deployment is publishing to Maven Central; it cannot be stopped now. Check https://central.sonatype.com/publishing/deployments if repo1.maven.org has not served $version within an hour."
      exit 0
    fi
    fail "deployment $deployment was still $state after ${CENTRAL_WAIT_MINUTES:-30} minutes: see https://central.sonatype.com/publishing/deployments"
  fi
  sleep "$poll"
done
