#!/bin/sh
# Prints the dist-tag a release of <version> goes out under, so `latest` only ever moves forward:
#   next              a prerelease (1.2.0-rc.1)
#   latest            a release later than the current latest, or the first release
#   latest-<M>.<m>    a release on an older line (0.2.1 after 0.3.0); users of that line ask npm for
#                     slotlock@latest-0.2
# npm installs `latest` by default, and an explicit --tag latest skips npm's own refusal to move it to
# a lower version, so the current latest comes from the registry. npm rejects a tag that reads as a
# version range ("v1.4"), which latest-<M>.<m> never does.
#   scripts/dist-tag.sh <version> --npm          the current latest is what the registry's latest
#                                                dist-tag holds (release.yml, bootstrap-release.sh)
#   scripts/dist-tag.sh <version> <current latest, or empty>
#   scripts/dist-tag.sh <version> --git-tags     the current latest is the highest v<release> tag
#                                                other than v<version> (for the image's latest tag)
set -eu
[ "$#" -eq 2 ] || {
  echo "usage: scripts/dist-tag.sh <version> --npm|--git-tags|<current latest>" >&2
  exit 2
}
. "$(dirname "$0")/semver.sh"
version=$1
is_version "$version" || {
  echo "::error::$version is not a version like 1.2.3 or 1.2.3-rc.1 (no leading v)." >&2
  exit 2
}
current=$2
if [ "$current" = --npm ]; then
  # Only a package the registry does not have (npm's E404) has no latest. Any other failure stops
  # here: read as "no release yet", a registry error would stage a patch to an older line as
  # `latest`, and a staged version's tag cannot be changed.
  errors=$(mktemp "${TMPDIR:-/tmp}/slotlock-dist-tag.XXXXXX")
  trap 'rm -f "$errors"' EXIT
  if current=$(npm view slotlock dist-tags.latest 2>"$errors"); then
    if [ -z "$current" ]; then
      echo "::error::npm has slotlock but no latest dist-tag; choose this release's tag by hand." >&2
      exit 1
    fi
  elif grep -Eq 'code E404$' "$errors"; then
    current=''
  else
    cat "$errors" >&2
    echo "::error::npm did not say which version slotlock's latest dist-tag holds; try again." >&2
    exit 1
  fi
elif [ "$current" = --git-tags ]; then
  current=''
  for tag in $(git tag --list 'v*'); do
    candidate=${tag#v}
    # A prerelease never holds latest, and the version being released is not its own rival.
    case $candidate in *-*) continue ;; esac
    if ! is_version "$candidate" || [ "$candidate" = "$version" ]; then continue; fi
    if [ -z "$current" ] || later "$candidate" "$current"; then current=$candidate; fi
  done
fi
if [ -n "$current" ] && ! is_version "$current"; then
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
