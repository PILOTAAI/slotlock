#!/bin/sh
# Uploads the Java client to Maven Central, for release.yml's maven-central job. Maven Central has no
# trusted publishing: the Central Portal takes a user token, so the upload is made as a deployment
# a maintainer then publishes by hand (publishingType=USER_MANAGED), after Central has validated it.
# Nothing reaches Maven Central until that click.
#   CENTRAL_PORTAL_TOKEN=<base64 of username:password> scripts/central-bundle.sh <repository> <version>
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
  "https://central.sonatype.com/api/v1/publisher/upload?publishingType=USER_MANAGED&name=slotlock-$version")
echo "Uploaded slotlock $version to the Central Portal as deployment $deployment."
echo "Publish it, once Central has validated it: https://central.sonatype.com/publishing/deployments"
