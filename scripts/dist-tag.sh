#!/bin/sh
# Prints the dist-tag a release of <version> goes out under, so `latest` only ever moves forward:
#   next              a prerelease (1.2.0-rc.1)
#   latest            a release later than the current latest, or the first release
#   latest-<M>.<m>    a release on an older line (0.2.1 after 0.3.0); users of that line ask npm for
#                     slotlock@latest-0.2
# npm installs `latest` by default, and an explicit --tag latest skips npm's own refusal to move it to
# a lower version, so release.yml asks the registry for the current latest and passes it here. npm
# rejects a tag that reads as a version range ("v1.4"), which latest-<M>.<m> never does.
#   scripts/dist-tag.sh <version> <current latest, or empty>
#   scripts/dist-tag.sh <version> --git-tags     the current latest is the highest v<release> tag
#                                                other than v<version> (for the image's latest tag)
set -eu
[ "$#" -eq 2 ] || {
  echo "usage: scripts/dist-tag.sh <version> <current latest>|--git-tags" >&2
  exit 2
}
. "$(dirname "$0")/semver.sh"
version=$1
is_version "$version" || {
  echo "::error::$version is not a version like 1.2.3 or 1.2.3-rc.1 (no leading v)." >&2
  exit 2
}
current=$2
if [ "$current" = --git-tags ]; then
  current=''
  for tag in $(git tag --list 'v*'); do
    candidate=${tag#v}
    # A prerelease never holds latest, and the version being released is not its own rival.
    case $candidate in *-*) continue ;; esac
    if ! is_version "$candidate" || [ "$candidate" = "$version" ]; then continue; fi
    if [ -z "$current" ] || later "$candidate" "$current"; then current=$candidate; fi
  done
elif [ -n "$current" ] && ! is_version "$current"; then
  echo "::error::The current latest, $current, is not a version." >&2
  exit 2
fi

case $version in
*-*) echo next ;;
*)
  if [ -z "$current" ] || later "$version" "$current"; then
    echo latest
  else
    echo "latest-${version%.*}"
  fi
  ;;
esac
