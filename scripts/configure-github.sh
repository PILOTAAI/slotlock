#!/usr/bin/env bash
# Configures the GitHub repository PILOTAAI/slotlock: security features, deployment
# environments, rulesets for main and for release tags, and repository settings. The repository
# owner runs it once the repository exists. It is safe to run again: every step sets the same
# end state, and rulesets are updated by name instead of created twice.
#
#   scripts/configure-github.sh --dry-run        print every request, send nothing
#   scripts/configure-github.sh                  apply
#   scripts/configure-github.sh --site-secrets   only replace the Cloudflare secrets, after
#                                                checking them with Cloudflare
#
# Needs bash 3.2 or newer, curl, jq, and gh logged in as an admin of the repository.
# Environment:
#   SKIP_SITE_SECRETS=1     do not ask for the Cloudflare secrets now (add them later)
#   REPLACE_SITE_SECRETS=1  ask for them again even when they are already set
#
# Every endpoint, field and payload shape was read from the GitHub REST API docs on 2026-10-09.
# They are for API version 2026-03-10, the newest one (GET https://api.github.com/versions
# returned 2026-03-10 and 2022-11-28 that day):
#   https://docs.github.com/en/rest/about-the-rest-api/api-versions
#   https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
#   https://docs.github.com/en/rest/users/users#get-the-authenticated-user
#   https://docs.github.com/en/rest/repos/repos#get-a-repository
#   https://docs.github.com/en/rest/repos/repos#update-a-repository
#     (security_and_analysis: secret_scanning, secret_scanning_push_protection)
#   https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics
#   https://docs.github.com/en/rest/repos/repos#enable-private-vulnerability-reporting-for-a-repository
#   https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts
#   https://docs.github.com/en/rest/repos/repos#enable-dependabot-security-updates
#   https://docs.github.com/en/rest/secret-scanning/secret-scanning#about-secret-scanning
#   https://docs.github.com/en/rest/code-scanning/code-scanning#get-a-code-scanning-default-setup-configuration
#   https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration
#   https://docs.github.com/en/rest/branches/branches#get-a-branch
#   https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment
#   https://docs.github.com/en/rest/deployments/branch-policies (list, create, delete)
#   https://docs.github.com/en/rest/actions/secrets#list-environment-secrets
#   https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret
#     (gh secret set encrypts the value with the environment's public key and calls this)
#   https://docs.github.com/en/rest/repos/rules (get all, create, get and update a ruleset)
#   https://docs.github.com/en/rest/apps/apps#get-an-app
#   https://docs.github.com/en/rest/packages/packages (no endpoint changes a package's visibility)
# Behaviour the REST reference does not cover came from:
#   https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
#   https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
#   https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
#   https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
#   https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility
#   https://docs.npmjs.com/trusted-publishers
#   https://docs.npmjs.com/cli/v11/commands/npm-stage
set -euo pipefail

OWNER=PILOTAAI
REPO=slotlock
API_VERSION=2026-03-10
HOMEPAGE=https://slotlock.pylota.io
TOPICS='["agents","calendar","mcp","a2a","postgresql","scheduling","availability","booking"]'

# The checks a pull request must pass. These are the job names that ci.yml and dco.yml report
# on pull_request. A matrix job is reported under its evaluated name, so ci.yml's
# "Test (Node.js ${{ matrix.node }})" becomes one check per Node.js version, with nothing
# appended because the name already uses the matrix value (checked on 2026-10-09 against the
# check runs of another workflow whose matrix job is named this way). site.yml is left out: it
# only runs when certain paths change, and a required check from a skipped workflow stays
# "Pending" and blocks the pull request.
REQUIRED_CHECKS='["Test (Node.js 22)","Test (Node.js 24)","Docker image","Signed-off-by"]'

# The GitHub Actions app (GET /apps/github-actions returned id 15368 on 2026-10-09). Pinning the
# checks to it means a commit status with the same name from anyone else does not count.
ACTIONS_APP_ID=15368

# The base repository role "admin". The REST docs do not list base role ids. The GitHub Terraform
# provider documents maintain 2, write 4, admin 5. The ruleset step checks it after the write:
# GitHub reports whether you, an admin, can bypass.
ADMIN_ROLE_ID=5

BRANCH_RULESET='Protect main'
TAG_RULESET='Release tags'

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

DRY_RUN=0
SITE_SECRETS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --site-secrets) SITE_SECRETS_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Dry-run output goes to fd 3, a copy of stdout, so it still shows inside $(...).
exec 3>&1

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# result MESSAGE: the outcome of a step. A dry run marks it as not applied.
result() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  (dry run, not applied) %s\n' "$*"
  else
    printf '  %s\n' "$*"
  fi
}
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# gh_api METHOD PATH [BODY]
# Sends one request with the headers the docs ask for and prints the response. BODY is JSON fed
# on stdin (--input -), never put on the command line. A dry run prints the request instead.
gh_api() {
  local method=$1 path=$2 body=${3-}
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n> %s /%s\n' "$method" "$path" >&3
    if [ -n "$body" ]; then
      printf '%s\n' "$body" | jq . >&3
    fi
    return 0
  fi
  if [ -n "$body" ]; then
    printf '%s' "$body" | gh api --method "$method" \
      -H 'Accept: application/vnd.github+json' \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      -H 'Content-Type: application/json' \
      --input - "$path"
  else
    gh api --method "$method" \
      -H 'Accept: application/vnd.github+json' \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "$path"
  fi
}

# gh_get PATH DRY_RUN_RESULT
# A GET. A dry run sends nothing and prints DRY_RUN_RESULT, which stands for "nothing is
# configured yet".
gh_get() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n> GET /%s\n  (dry run: not sent, assuming %s)\n' "$1" "$2" >&3
    printf '%s\n' "$2"
    return 0
  fi
  gh api --method GET \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: $API_VERSION" \
    "$1"
}

# branch_exists NAME: true when the branch exists, false on a 404, stops on any other error.
branch_exists() {
  local err
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n> GET /repos/%s/%s/branches/%s\n  (dry run: not sent, assuming it exists)\n' \
      "$OWNER" "$REPO" "$1" >&3
    return 0
  fi
  if err=$(gh api --method GET \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: $API_VERSION" \
    --silent "repos/$OWNER/$REPO/branches/$1" 2>&1); then
    return 0
  fi
  case "$err" in
    *'(HTTP 404)'*) return 1 ;;
  esac
  die "could not read branch $1: $err"
}

preflight() {
  local repo
  command -v jq >/dev/null 2>&1 || die 'jq is required (https://jqlang.org)'
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Dry run: nothing is sent. Every request below would carry"
    say "  Accept: application/vnd.github+json and X-GitHub-Api-Version: $API_VERSION"
    REVIEWER_ID=0
    REVIEWER_LOGIN='<you>'
    say "The reviewer id shows as 0; a real run uses yours (gh api user --jq .id)."
    return 0
  fi
  command -v gh >/dev/null 2>&1 || die 'gh is required (https://cli.github.com)'

  # The required reviewer on the npm and mcp-registry environments is whoever runs this.
  REVIEWER_ID=$(gh api user -H "X-GitHub-Api-Version: $API_VERSION" --jq .id)
  REVIEWER_LOGIN=$(gh api user -H "X-GitHub-Api-Version: $API_VERSION" --jq .login)
  case "$REVIEWER_ID" in
    '' | *[!0-9]*) die "could not read your user id from gh api user (got '$REVIEWER_ID')" ;;
  esac

  repo=$(gh_get "repos/$OWNER/$REPO" '{}')
  if [ "$(printf '%s' "$repo" | jq -r '.permissions.admin // false')" != true ]; then
    die "$REVIEWER_LOGIN is not an admin of $OWNER/$REPO"
  fi
  # On the Free, Pro and Team plans, required reviewers on an environment exist only for public
  # repositories, so the release gates below need the repository to be public.
  if [ "$(printf '%s' "$repo" | jq -r .visibility)" != public ]; then
    warn "$OWNER/$REPO is not public yet; environment reviewers may be refused until it is"
  fi
  if [ "$(printf '%s' "$repo" | jq -r .default_branch)" != main ]; then
    warn "the default branch is not main; the workflows and the rulesets below assume main"
  fi
  say "Configuring $OWNER/$REPO as $REVIEWER_LOGIN (id $REVIEWER_ID)"
}

# The required checks must match what the workflows report. When this runs from the checkout,
# compare with the workflow files and warn if they drifted. This only warns: an admin can still
# merge a pull request past a check that never reports (see the main ruleset below).
check_workflow_names() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  if [ ! -f "$dir/.github/workflows/ci.yml" ] || [ ! -f "$dir/.github/workflows/dco.yml" ]; then
    warn "no .github/workflows next to this script; required check names not compared"
    return 0
  fi
  # shellcheck disable=SC2016 # the ${{ }} is workflow text, not shell
  if ! grep -Fq 'name: Test (Node.js ${{ matrix.node }})' "$dir/.github/workflows/ci.yml" ||
    ! grep -Fq "node: ['22', '24']" "$dir/.github/workflows/ci.yml" ||
    ! grep -Fq 'name: Docker image' "$dir/.github/workflows/ci.yml" ||
    ! grep -Fq 'name: Signed-off-by' "$dir/.github/workflows/dco.yml"; then
    warn "ci.yml or dco.yml no longer names its jobs as REQUIRED_CHECKS expects; update REQUIRED_CHECKS"
  fi
}

# 1. Security features.
configure_security() {
  local current out
  step '1. Security'

  # SECURITY.md tells reporters to use the Security tab's "Report a vulnerability" button. That
  # button exists only when private vulnerability reporting is on.
  gh_api PUT "repos/$OWNER/$REPO/private-vulnerability-reporting" >/dev/null
  result 'private vulnerability reporting: enabled'

  # Secret scanning finds committed credentials. Push protection refuses a push that contains
  # one, before it is public. Both are settings in security_and_analysis.
  gh_api PATCH "repos/$OWNER/$REPO" "$(jq -n '{
    security_and_analysis: {
      secret_scanning: {status: "enabled"},
      secret_scanning_push_protection: {status: "enabled"}
    }
  }')" >/dev/null
  result 'secret scanning and push protection: enabled'

  # Dependabot alerts (with the dependency graph) first: security updates act on those alerts.
  # dependabot.yml already asks for weekly version updates; security updates are separate and
  # are not delayed by its cooldown.
  gh_api PUT "repos/$OWNER/$REPO/vulnerability-alerts" >/dev/null
  gh_api PUT "repos/$OWNER/$REPO/automated-security-fixes" >/dev/null
  result 'Dependabot alerts and security updates: enabled'

  # CodeQL default setup for the two languages here: TypeScript (src/, site/, scripts/) and the
  # workflows themselves (actions). The extended suite adds more security queries, which suits a
  # library that parses untrusted calendar data. Default setup needs code on the default branch.
  if branch_exists main; then
    current=$(gh_get "repos/$OWNER/$REPO/code-scanning/default-setup" '{"state":"not-configured"}')
    if printf '%s' "$current" | jq -e '.state == "configured"
        and ((.languages // []) | sort) == ["actions", "javascript-typescript"]
        and .query_suite == "extended"' >/dev/null; then
      result 'CodeQL default setup: already configured'
    # A refusal here must not stop the environments and rulesets below. GitHub can refuse a
    # language main does not contain yet, as when main holds only the README the repository was
    # created with.
    elif out=$(gh_api PATCH "repos/$OWNER/$REPO/code-scanning/default-setup" "$(jq -n '{
        state: "configured",
        languages: ["actions", "javascript-typescript"],
        query_suite: "extended",
        runner_type: "standard"
      }')" 2>&1); then
      result 'CodeQL default setup: configured (javascript-typescript, actions)'
    else
      CODEQL_SKIPPED=1
      warn "GitHub refused CodeQL default setup: $out"
    fi
  else
    CODEQL_SKIPPED=1
    warn 'main has no commits yet, so CodeQL default setup cannot start. Push main, then run this again.'
  fi
}

# configure_environment NAME REVIEWERS_JSON REF_TYPE PATTERN
# Creates or updates the environment, then leaves exactly one deployment policy on it: PATTERN
# for REF_TYPE (branch or tag). Any other pattern is removed.
configure_environment() {
  local env=$1 reviewers=$2 type=$3 pattern=$4 policies id
  # custom_branch_policies: only refs matching the policies below may deploy. Until a policy
  # exists nothing can deploy, so the gap during a first run fails closed.
  # prevent_self_review stays false: with one maintainer, the person who pushes the release tag
  # is also the only reviewer, and must be able to approve that run.
  gh_api PUT "repos/$OWNER/$REPO/environments/$env" "$(jq -n --argjson reviewers "$reviewers" '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: $reviewers,
    deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}
  }')" >/dev/null

  policies=$(gh_get "repos/$OWNER/$REPO/environments/$env/deployment-branch-policies?per_page=100" \
    '{"branch_policies":[]}')
  if printf '%s' "$policies" |
    jq -e --arg n "$pattern" --arg t "$type" 'any(.branch_policies[]; .name == $n and .type == $t)' >/dev/null; then
    result "$env: $type pattern $pattern already allowed"
  else
    gh_api POST "repos/$OWNER/$REPO/environments/$env/deployment-branch-policies" \
      "$(jq -n --arg n "$pattern" --arg t "$type" '{name: $n, type: $t}')" >/dev/null
    result "$env: $type pattern $pattern allowed"
  fi
  for id in $(printf '%s' "$policies" |
    jq -r --arg n "$pattern" --arg t "$type" '.branch_policies[] | select(.name != $n or .type != $t) | .id'); do
    gh_api DELETE "repos/$OWNER/$REPO/environments/$env/deployment-branch-policies/$id" >/dev/null
    result "$env: removed deployment policy $id, which is not $type $pattern"
  done
}

# trim VALUE: VALUE without leading or trailing whitespace, which a paste often carries.
trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

# The Cloudflare account ID and API token site.yml's deploy job reads. Both are checked with
# Cloudflare by scripts/check-cloudflare-credentials.sh, the check site.yml runs before every
# deploy, and only then stored, together: the environment never receives a value Cloudflare refuses
# or a token from another account. The token is read with echo off. Each value reaches the checker
# in its environment, as site.yml passes it, and gh on stdin through printf (a shell builtin), so
# neither is ever on a command line or in a file.
configure_site_secrets() {
  local existing account token attempt checker
  if [ "${SKIP_SITE_SECRETS:-0}" = 1 ]; then
    SITE_SECRETS_SKIPPED=1
    result 'site secrets: skipped (SKIP_SITE_SECRETS=1)'
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n> GET /repos/%s/%s/environments/site/secrets\n  (dry run: not sent)\n' "$OWNER" "$REPO" >&3
    printf '> unless both are set: read CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (echo off),\n' >&3
    printf '  check them with scripts/check-cloudflare-credentials.sh, and only if Cloudflare accepts\n' >&3
    printf '  them, gh secret set <NAME> --env site --repo %s/%s with each value on stdin\n' "$OWNER" "$REPO" >&3
    printf '  (not prompted for in a dry run)\n' >&3
    return 0
  fi
  existing=$(gh_get "repos/$OWNER/$REPO/environments/site/secrets?per_page=100" '{"secrets":[]}')
  if [ "${REPLACE_SITE_SECRETS:-0}" != 1 ] && printf '%s' "$existing" | jq -e '
      any(.secrets[]; .name == "CLOUDFLARE_API_TOKEN")
      and any(.secrets[]; .name == "CLOUDFLARE_ACCOUNT_ID")' >/dev/null; then
    result 'site: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN already set (--site-secrets replaces them)'
    return 0
  fi
  checker="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-cloudflare-credentials.sh"
  for attempt in 1 2 3; do
    account=''
    token=''
    IFS= read -r -p 'site: CLOUDFLARE_ACCOUNT_ID (Cloudflare dashboard, Account home; empty to skip): ' account || true
    account=$(trim "$account")
    [ -n "$account" ] || break
    IFS= read -r -s -p 'site: CLOUDFLARE_API_TOKEN (hidden): ' token || true
    printf '\n' >&2
    token=$(trim "$token")
    if CLOUDFLARE_ACCOUNT_ID=$account CLOUDFLARE_API_TOKEN=$token GITHUB_ACTIONS='' bash "$checker"; then
      printf '%s' "$account" | gh secret set CLOUDFLARE_ACCOUNT_ID --env site --repo "$OWNER/$REPO"
      printf '%s' "$token" | gh secret set CLOUDFLARE_API_TOKEN --env site --repo "$OWNER/$REPO"
      token=''
      result 'site: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN accepted by Cloudflare and stored'
      return 0
    fi
    warn "site: nothing stored. Fix what the error names and try again ($attempt of 3)."
  done
  token=''
  SITE_SECRETS_SKIPPED=1
  warn 'site: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN left as they were'
}

# 2. Deployment environments. Each one is limited to the refs its workflow runs on.
configure_environments() {
  local me
  step '2. Environments'
  me=$(jq -n --argjson id "$REVIEWER_ID" '[{type: "User", id: $id}]')

  # npm: release.yml's "Stage on npm" job. It runs on v* tags and stages the package with a
  # short-lived OIDC credential, so a person approves each run before it can stage.
  configure_environment npm "$me" tag 'v*'

  # mcp-registry: mcp-registry.yml's publish job, called by image.yml for the same v* tag. A
  # registry version can be published once only, so a person approves it too.
  configure_environment mcp-registry "$me" tag 'v*'

  # site: site.yml's deploy job, on a push to main or a manual run on main. No reviewer: the
  # change already went through a pull request into main.
  configure_environment site '[]' branch main
  configure_site_secrets
}

# upsert_ruleset TARGET NAME BODY
# Updates the repository ruleset called NAME, or creates it when there is none. Sets RULESET_ID.
# Returns 1 with gh's message in RULESET_ERROR when GitHub refuses the write.
upsert_ruleset() {
  local target=$1 name=$2 body=$3 list id count out
  RULESET_ID=''
  RULESET_ERROR=''
  list=$(gh_get "repos/$OWNER/$REPO/rulesets?includes_parents=false&targets=$target&per_page=100" '[]') ||
    die "could not list the $target rulesets"
  count=$(printf '%s' "$list" | jq --arg n "$name" '[.[] | select(.name == $n)] | length') ||
    die "could not read the $target rulesets"
  id=$(printf '%s' "$list" | jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id // empty') ||
    die "could not read the $target rulesets"
  if [ "$count" -gt 1 ]; then
    warn "$count rulesets are named '$name'; updating id $id only. Delete the others in Settings > Rules."
  fi
  if [ -n "$id" ]; then
    if out=$(gh_api PUT "repos/$OWNER/$REPO/rulesets/$id" "$body" 2>&1); then
      RULESET_ID=$id
      result "ruleset '$name': updated (id $id)"
      return 0
    fi
  elif out=$(gh_api POST "repos/$OWNER/$REPO/rulesets" "$body" 2>&1); then
    RULESET_ID=$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null || true)
    result "ruleset '$name': created${RULESET_ID:+ (id $RULESET_ID)}"
    return 0
  fi
  RULESET_ERROR=$out
  return 1
}

# verify_bypass ID EXPECTED: GitHub says whether the person running this can bypass the ruleset.
# For an admin that is the admin role entry, so this also confirms ADMIN_ROLE_ID.
verify_bypass() {
  local got
  if [ "$DRY_RUN" -eq 1 ] || [ -z "$1" ]; then
    return 0
  fi
  # A failed check is only reported: the ruleset itself is already written.
  if ! got=$(gh_get "repos/$OWNER/$REPO/rulesets/$1" '{}' | jq -r '.current_user_can_bypass // "unknown"'); then
    warn "could not read ruleset $1 back to check who can bypass it"
    return 0
  fi
  if [ "$got" = "$2" ]; then
    result "you can bypass it: $got, as intended"
  else
    warn "GitHub says you can bypass ruleset $1: '$got', expected '$2'. Check the bypass list in Settings > Rules; the admin role id ($ADMIN_ROLE_ID) may be wrong."
  fi
}

# branch_ruleset_body PIN: the main ruleset, with the checks pinned to GitHub Actions when PIN
# is true.
branch_ruleset_body() {
  jq -n --arg name "$BRANCH_RULESET" --argjson checks "$REQUIRED_CHECKS" \
    --argjson app "$ACTIONS_APP_ID" --argjson role "$ADMIN_ROLE_ID" --argjson pin "$1" '{
    name: $name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [{actor_id: $role, actor_type: "RepositoryRole", bypass_mode: "pull_request"}],
    conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"]
      }},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [$checks[] | {context: .}
          + (if $pin then {integration_id: $app} else {} end)]
      }}
    ]
  }'
}

# 3. The main branch.
configure_branch_ruleset() {
  step "3. Ruleset '$BRANCH_RULESET' (refs/heads/main)"
  # Every change arrives by pull request, and every review conversation must be resolved first.
  # Required approvals are 0: GitHub does not let an author approve their own pull request, and
  # MAINTAINERS.md lists one maintainer, so 1 would block every change. Raise it to 1 when a
  # second maintainer joins (GOVERNANCE.md). Squash is the only merge method, as in step 5.
  # The checks must pass on a branch that is up to date with main (strict). Force pushes and
  # deletion of main are blocked.
  #
  # Bypass: the admin role, for pull requests only. An admin can merge a pull request whose
  # checks cannot pass or cannot run, such as an initial import whose commits carry no
  # Signed-off-by line, but cannot push to main directly or force-push it. Every bypass goes
  # through a pull request, so it stays visible and in the audit log.
  if ! upsert_ruleset branch "$BRANCH_RULESET" "$(branch_ruleset_body true)"; then
    case "$RULESET_ERROR" in
      *'(HTTP 422)'*)
        # GitHub may accept an app as a check's source only after that app has reported a
        # check in the repository. On a new repository, fall back to unpinned checks.
        warn "GitHub refused checks pinned to the GitHub Actions app: $RULESET_ERROR"
        warn "Applying the same checks unpinned. Run this again after CI has run once to pin them."
        upsert_ruleset branch "$BRANCH_RULESET" "$(branch_ruleset_body false)" || die "$RULESET_ERROR"
        ;;
      *) die "$RULESET_ERROR" ;;
    esac
  fi
  verify_bypass "$RULESET_ID" pull_requests_only
}

# 4. Release tags.
configure_tag_ruleset() {
  step "4. Ruleset '$TAG_RULESET' (refs/tags/v*)"
  # A v* tag starts release.yml and image.yml, which stage the npm package and push the image.
  # GOVERNANCE.md says releases come only from a protected v<version> tag. Only the admin role
  # may create, move or delete one. Tag rulesets allow no "pull requests only" mode, so the
  # bypass is "always".
  upsert_ruleset tag "$TAG_RULESET" "$(jq -n --arg name "$TAG_RULESET" --argjson role "$ADMIN_ROLE_ID" '{
    name: $name,
    target: "tag",
    enforcement: "active",
    bypass_actors: [{actor_id: $role, actor_type: "RepositoryRole", bypass_mode: "always"}],
    conditions: {ref_name: {include: ["refs/tags/v*"], exclude: []}},
    rules: [{type: "creation"}, {type: "update"}, {type: "deletion"}]
  }')" || die "$RULESET_ERROR"
  verify_bypass "$RULESET_ID" always
}

# 5. Repository settings.
configure_repository() {
  step '5. Repository settings'
  # Squash only: main gets one commit per pull request. Its default message lists the branch's
  # commit messages, so their Signed-off-by lines (the DCO record) carry over to main. Merge
  # commits and rebase are off. Head branches are deleted after the merge. "Update branch" is
  # offered, because the checks are strict. Commits made in the web editor must be signed off,
  # so they pass the DCO check too. The wiki is off: the docs live in the repository and on
  # the site.
  gh_api PATCH "repos/$OWNER/$REPO" "$(jq -n --arg homepage "$HOMEPAGE" '{
    homepage: $homepage,
    has_wiki: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    delete_branch_on_merge: true,
    allow_update_branch: true,
    web_commit_signoff_required: true
  }')" >/dev/null
  result "merge: squash only; delete branch on merge; wiki off; homepage $HOMEPAGE"

  # Topics make the repository findable. This replaces the whole list.
  gh_api PUT "repos/$OWNER/$REPO/topics" "$(jq -n --argjson names "$TOPICS" '{names: $names}')" >/dev/null
  result "topics: $(printf '%s' "$TOPICS" | jq -r 'join(", ")')"

  # Discussions: on. MAINTAINERS.md sends questions to "an issue or discussion". The documented
  # "Update a repository" body has no has_discussions field, so it is in the checklist below.
}

# 6. What this script cannot do.
print_checklist() {
  step '6. Left for you to do by hand'
  cat <<EOF

[ ] Turn on Discussions. MAINTAINERS.md points people to them, and the REST "Update a
    repository" endpoint documents no field for them. Settings > General > Features >
    Discussions: https://github.com/$OWNER/$REPO/settings
    (gh repo edit $OWNER/$REPO --enable-discussions does it through a has_discussions field
    that gh 2.83.2 sends to the same endpoint, outside the documented body.)

[ ] Make the image public once the first v* tag has pushed it. New GHCR packages are private,
    the MCP Registry pulls the image anonymously, and the REST API has no endpoint that changes
    a package's visibility (it can only list, get, delete and restore packages). In the UI:
      https://github.com/orgs/$OWNER/packages/container/package/$REPO
      Package settings > Danger Zone > Change visibility > Public
    This cannot be undone. If Public is not offered, allow public packages first: organization
    Settings > Packages > Package creation > Public. Best done while that tag's Image run waits
    for your mcp-registry approval: approve after the change and the "MCP Registry" job passes.
    If it already failed on the private image, re-run that job.

[ ] Stage the first npm version yourself, from your own npm session (npm login, with 2FA).
    A trusted publisher is configured on an existing package's settings page, so the first
    version cannot come from release.yml. From a clean checkout of the commit you will tag,
    with npm 11.15.0 or newer (the version release.yml requires for npm stage):
      npm ci && npm run typecheck && npm test      (builds and verifies dist/)
      cd dist && npm pack --ignore-scripts
      npm stage publish ./slotlock-<version>.tgz --access public
      npm stage approve <stage-id>                 (asks for your 2FA code)
    npm keeps one version index for staged and published versions, so the Release run for that
    version's tag cannot stage it again; expect its "Stage on npm" job to fail that one time.

[ ] Create the npm trusted publisher for the package slotlock (npm org pylotahq), shortly
    before you push the next v* tag: npm expires a new configuration that has no successful
    publish within 2 days.
      npmjs.com > Packages > slotlock > Settings > Trusted publishing > GitHub Actions
      Organization or user: $OWNER
      Repository:           $REPO
      Workflow filename:    release.yml
      Environment name:     npm
    Leave direct "npm publish" off. release.yml only stages, and npm stage publish is always
    allowed for a trusted publisher.
EOF
  if [ "${SITE_SECRETS_SKIPPED:-0}" = 1 ]; then
    cat <<EOF

[ ] Add the site secrets (site/README.md says how to create the token). This checks them with
    Cloudflare before it stores them:
      scripts/configure-github.sh --site-secrets
EOF
  fi
  if [ "${CODEQL_SKIPPED:-0}" = 1 ]; then
    cat <<EOF

[ ] CodeQL default setup did not start (see the warning above): main had no commits, or GitHub
    refused a language main does not contain yet. Merge the initial import into main, then run
    this script again.
EOF
  fi
  cat <<EOF

[ ] Before the first site deploy (site/README.md): slotlock.pylota.io must have no CNAME record,
    and the pylota.io zone must have the route slotlock.pylota.io/* with no Worker. Without it
    the booking Worker's *.pylota.io/* route answers first. The bypass is in PILOTAAI/pylota's
    infra/tofu/booking.tf and is applied by that repository's infra workflow.

[ ] When MAINTAINERS.md lists a second maintainer, set required_approving_review_count to 1 in
    this script and run it again.
EOF
}

SITE_SECRETS_SKIPPED=0
CODEQL_SKIPPED=0
REVIEWER_ID=''
REVIEWER_LOGIN=''
RULESET_ID=''
RULESET_ERROR=''

preflight
if [ "$SITE_SECRETS_ONLY" -eq 1 ]; then
  step 'Site secrets'
  REPLACE_SITE_SECRETS=1
  SKIP_SITE_SECRETS=0
  configure_site_secrets
  [ "$SITE_SECRETS_SKIPPED" = 0 ] || exit 1
  exit 0
fi
check_workflow_names
configure_security
configure_environments
configure_branch_ruleset
configure_tag_ruleset
configure_repository
print_checklist
