#!/bin/sh
# Waits for the pull request runs of each workflow at a commit to pass, for release-version.yml.
# GitHub holds the workflow runs of a pull request that github-actions[bot] opens until someone with
# write access approves them ("Approve workflows to run" on the pull request), and only a pull
# request's own runs count as its required checks: a run started any other way at the same commit
# does not, nor does one of a fork's pull request. So this waits through the approval, then for
# each run from this repository's own branch to finish. It fails when a run fails, or when the wait
# runs out.
#   scripts/wait-for-pr-checks.sh <commit> <pull request url> <workflow file>...
# Needs gh logged in (GH_TOKEN) with actions: read on GITHUB_REPOSITORY.
# Environment: SLOTLOCK_POLL_SECONDS (default 30), SLOTLOCK_WAIT_MINUTES (default 300).
set -eu
[ "$#" -ge 3 ] || {
  echo "usage: scripts/wait-for-pr-checks.sh <commit> <pull request url> <workflow file>..." >&2
  exit 2
}
fail() {
  echo "::error::$1" >&2
  exit 1
}
commit=$1
url=$2
shift 2
poll=${SLOTLOCK_POLL_SECONDS:-30}
deadline=$(($(date +%s) + ${SLOTLOCK_WAIT_MINUTES:-300} * 60))
server=${GITHUB_SERVER_URL:-https://github.com}
repository=${GITHUB_REPOSITORY:-PILOTAAI/slotlock}
asked=0
reported=''

while :; do
  pending=''
  held=''
  report=''
  for workflow in "$@"; do
    # The newest pull request run of the workflow at the commit, from this repository's own branch:
    # "<id> <status> <conclusion>". The release commit is public, so a fork's pull request can carry
    # it too, and its runs, held for approval or not, are not this pull request's checks. gh run
    # list cannot tell them apart; the API names each run's head repository.
    run=$(REPOSITORY=$repository gh api \
      "repos/$repository/actions/workflows/$workflow/runs?head_sha=$commit&event=pull_request&per_page=100" \
      --jq '[.workflow_runs[] | select(.head_repository.full_name == env.REPOSITORY)][0] // empty | "\(.id) \(.status) \(.conclusion)"')
    id=${run%% *}
    rest=${run#* }
    status=${rest%% *}
    conclusion=${rest#* }
    if [ -z "$run" ]; then
      state='not started'
      pending="$pending $workflow"
    elif [ "$status" = completed ] && [ "$conclusion" = action_required ]; then
      state='waiting for approval'
      pending="$pending $workflow"
      held=1
    elif [ "$status" = completed ] && [ "$conclusion" = success ]; then
      state='passed'
    elif [ "$status" = completed ]; then
      fail "$workflow did not pass on the pull request ($conclusion): $server/$repository/actions/runs/$id"
    else
      state=$status
      pending="$pending $workflow"
    fi
    report="$report $workflow: $state."
  done
  if [ "$report" != "$reported" ]; then
    echo "${report# }"
    reported=$report
  fi
  if [ -n "$held" ] && [ "$asked" = 0 ]; then
    echo "::notice::GitHub holds the checks of a pull request github-actions[bot] opens. Open $url and click \"Approve workflows to run\"; this run then waits for them, merges and tags."
    asked=1
  fi
  [ -n "$pending" ] || exit 0
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ -n "$held" ]; then
      fail "Still waiting for approval of the checks on $url. Approve them, then run Release a version again with the same version."
    fi
    fail "Still waiting for$pending on $url."
  fi
  sleep "$poll"
done
