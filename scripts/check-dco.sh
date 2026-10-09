#!/bin/sh
# Developer Certificate of Origin check (https://developercertificate.org): every non-merge commit
# in BASE..HEAD must carry a `Signed-off-by:` trailer with its author's email, which
# `git commit --signoff` (-s) adds. Exits 1 and names each commit that lacks one.
#   scripts/check-dco.sh <base-sha> <head-sha>
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: scripts/check-dco.sh <base-sha> <head-sha>" >&2
  exit 2
fi
missing=0
for commit in $(git rev-list --no-merges "$1..$2"); do
  author=$(git log -1 --format='%ae' "$commit" | tr '[:upper:]' '[:lower:]')
  # GitHub's bots (Dependabot) cannot sign off; their commits change only versions and lockfiles.
  case "$author" in *'[bot]@users.noreply.github.com') continue ;; esac
  if git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$commit" \
    | tr '[:upper:]' '[:lower:]' | grep -Fq "<$author>"; then
    continue
  fi
  # Only the hash is printed: a commit subject is untrusted text in a workflow log.
  echo "::error::Commit $(git rev-parse --short "$commit") has no Signed-off-by line for its author's email. Add one with git commit --amend --signoff, or git rebase --signoff for several commits."
  missing=1
done
if [ "$missing" -eq 0 ]; then
  echo "Every commit is signed off."
fi
exit "$missing"
