#!/usr/bin/env bash
# Sets up the language-client registries the release workflow publishes to, then re-runs the
# release's failed jobs. The repository owner runs it once, after scripts/configure-github.sh has
# created the environments. It is safe to run again: each step checks what is already in place.
#
#   scripts/configure-registries.sh [--tag v0.3.0] [--dry-run] [--only STEP]...
#
# Steps, in order (--only runs just the named ones):
#   pypi     PyPI takes a trusted publisher only through its web form: prints the exact values
#   crates   publishes the first version of the crate from the tag with a token you paste (once),
#            then prints the trusted-publishing values for every later release
#   nuget    sets the repository variable NUGET_USER and prints the trusted-publishing policy
#   maven    checks and stores the Central Portal token, creates a signing key, sends its public
#            half to keyserver.ubuntu.com and stores the key and its passphrase
#   site     scripts/configure-github.sh --site-secrets (checks the Cloudflare token first)
#   rerun    re-runs the failed jobs of the tag's Release run, and of the last failed Site run
#
# Every secret is read with echo off and reaches gh on stdin, never on a command line or in a
# file, except the generated signing key, which is also kept, passphrase-protected, in
# ~/.config/slotlock/maven-signing/ (move it to a password manager).
#
# Needs bash 3.2 or newer, gh logged in as an admin of the repository, git, curl, jq; gpg and
# openssl for maven; cargo (rustup) for crates.
#
# Sources read on 2026-10-27:
#   docs.pypi.org/trusted-publishers/creating-a-project-through-oidc (pending publishers: web form)
#   crates.io/docs/trusted-publishing (only for a crate that exists; first version by token)
#   learn.microsoft.com/nuget/nuget-org/trusted-publishing (policy: web form; login needs `user`)
#   central.sonatype.org/publish/publish-portal-api (Bearer base64(user:password); 401 when wrong)
#   central.sonatype.org/publish/requirements/gpg (keyserver.ubuntu.com is one Central reads)
#   cli.github.com/manual/gh_secret_set, gh_variable_set, gh_run_rerun (gh 2.89.0)
set -euo pipefail

OWNER=PILOTAAI
REPO=slotlock
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UA='slotlock-configure-registries (https://github.com/PILOTAAI/slotlock)'
KEY_HOME="$HOME/.config/slotlock/maven-signing"

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }
say() { printf '\n== %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}
pause() { [ "$DRY_RUN" -eq 1 ] || IFS= read -r -p '  Press Enter when done (or to skip) ' _ || true; }
http_code() { curl --silent --output /dev/null --write-out '%{http_code}' --user-agent "$UA" "$@"; }

# Temporary directories and worktrees, removed on every exit, an interrupted one included.
TEMP_DIRS=()
TEMP_WORKTREE=''
cleanup() {
  if [ -n "$TEMP_WORKTREE" ]; then git -C "$ROOT" worktree remove --force "$TEMP_WORKTREE" 2>/dev/null || true; fi
  if [ "${#TEMP_DIRS[@]}" -gt 0 ]; then rm -rf "${TEMP_DIRS[@]}"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
temp_dir() {
  local dir
  dir=$(mktemp -d)
  chmod 700 "$dir"
  TEMP_DIRS+=("$dir")
  printf '%s' "$dir"
}

DRY_RUN=0
TAG=''
ONLY=''
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tag)
      [ $# -ge 2 ] || die '--tag needs a value'
      TAG=$2
      shift
      ;;
    --only)
      [ $# -ge 2 ] || die '--only needs a step'
      ONLY="$ONLY $2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
  shift
done
for step in $ONLY; do
  case "$step" in pypi | crates | nuget | maven | site | rerun) ;; *) die "unknown step: $step" ;; esac
done
wants() { [ -z "$ONLY" ] || case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

for tool in gh git curl jq; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
if [ "$DRY_RUN" -eq 0 ]; then
  gh auth status >/dev/null 2>&1 || die 'gh is not logged in: gh auth login'
fi
if [ -z "$TAG" ]; then
  TAG=$(git -C "$ROOT" tag --list 'v*' --sort=-v:refname | head -n 1)
  [ -n "$TAG" ] || TAG=$(git -C "$ROOT" ls-remote --tags --refs origin 'v*' | sed 's#.*refs/tags/##' | sort -V | tail -n 1)
fi
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "no release tag found; pass --tag vX.Y.Z" ;; esac
VERSION=${TAG#v}
printf 'Setting up the registries for %s/%s, release %s%s\n' "$OWNER" "$REPO" "$TAG" \
  "$([ "$DRY_RUN" -eq 1 ] && printf ' (dry run: nothing is stored or published)')"

# Prints the four values every trusted-publishing form asks for.
publisher_values() {
  note "owner:        $OWNER"
  note "repository:   $REPO"
  note "workflow:     release.yml"
  note "environment:  $1"
}

step_pypi() {
  say 'PyPI (slotlock)'
  if [ "$(http_code https://pypi.org/pypi/slotlock/json)" = 200 ]; then
    note 'The project exists. Its trusted publisher: https://pypi.org/manage/project/slotlock/settings/publishing/'
  else
    note 'PyPI creates trusted publishers only in its web form, and the project does not exist yet,'
    note 'so add a PENDING publisher: https://pypi.org/manage/account/publishing/'
    note '(Your account > Publishing > "Add a new pending publisher" > GitHub)'
    note 'PyPI project name: slotlock'
  fi
  publisher_values pypi
  pause
}

step_crates() {
  say 'crates.io (slotlock)'
  local exists token tree cargo
  exists=$(http_code "https://crates.io/api/v1/crates/slotlock")
  if [ "$exists" != 200 ]; then
    note 'crates.io takes trusted publishing only for a crate that exists, so the first version is'
    note "published from $TAG with a token, once."
    note 'Create it at https://crates.io/settings/tokens/new: name "slotlock first publish",'
    note 'expiry 1 day, scope publish-new, crate pattern slotlock.'
    if [ "$DRY_RUN" -eq 1 ]; then
      note "(dry run) would publish clients/rust at $TAG with cargo publish --locked"
    else
      command -v cargo >/dev/null || die 'cargo is not installed (https://rustup.rs)'
      IFS= read -r -s -p '  crates.io token (hidden, empty to skip): ' token || true
      printf '\n'
      token=$(trim "$token")
      if [ -n "$token" ]; then
        git -C "$ROOT" fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
        tree=$(temp_dir)
        git -C "$ROOT" worktree add --quiet --detach "$tree/src" "$TAG"
        TEMP_WORKTREE="$tree/src"
        # The toolchain CI builds the client with, as release.yml publishes it.
        cargo=(cargo)
        if command -v rustup >/dev/null; then
          rustup toolchain install 1.94.0 --profile minimal >/dev/null
          cargo=(cargo +1.94.0)
        fi
        if (cd "$tree/src/clients/rust" && CARGO_REGISTRY_TOKEN=$token "${cargo[@]}" publish --locked); then
          note "slotlock $VERSION is on crates.io. Revoke the token now: https://crates.io/settings/tokens"
        else
          warn 'cargo publish failed: nothing else was changed'
        fi
        token=''
      fi
    fi
  else
    note 'The crate exists.'
  fi
  note 'Every later version is published by release.yml. Add trusted publishing at'
  note 'https://crates.io/crates/slotlock/settings (Trusted Publishing > Add > GitHub):'
  publisher_values crates-io
  pause
}

step_nuget() {
  say 'NuGet (Slotlock.Client)'
  local current user
  current=$([ "$DRY_RUN" -eq 1 ] || gh variable get NUGET_USER --repo "$OWNER/$REPO" 2>/dev/null || true)
  if [ -n "$current" ]; then
    note "NUGET_USER is already set to $current."
  elif [ "$DRY_RUN" -eq 1 ]; then
    note '(dry run) would ask for your nuget.org profile name and gh variable set NUGET_USER'
  else
    IFS= read -r -p '  Your nuget.org profile name, not your email (empty to skip): ' user || true
    user=$(trim "$user")
    if [ -n "$user" ]; then
      gh variable set NUGET_USER --repo "$OWNER/$REPO" --body "$user"
      note "NUGET_USER set to $user."
    fi
  fi
  note 'Add the trusted publishing policy in nuget.org > your username > Trusted Publishing'
  note '(https://www.nuget.org/account/trustedpublishing):'
  publisher_values nuget
  pause
}

step_maven() {
  say 'Maven Central (io.pylota:slotlock)'
  local existing user password token code email passphrase fpr gnupg input saved
  if [ "$DRY_RUN" -eq 1 ]; then
    note '(dry run) would check and store CENTRAL_PORTAL_TOKEN, then create a signing key, send it to'
    note 'keyserver.ubuntu.com and store MAVEN_SIGNING_KEY and MAVEN_SIGNING_PASSWORD in maven-central'
    return 0
  fi
  command -v gpg >/dev/null || die 'gpg is not installed'
  command -v openssl >/dev/null || die 'openssl is not installed'
  gh api "repos/$OWNER/$REPO/environments/maven-central" >/dev/null 2>&1 ||
    die 'the maven-central environment is missing: run scripts/configure-github.sh first'
  existing=$(gh secret list --env maven-central --repo "$OWNER/$REPO" --json name --jq '.[].name' 2>/dev/null || true)

  note 'The namespace io.pylota must be verified in the Central Portal (Namespaces, a DNS TXT record'
  note 'on pylota.io): https://central.sonatype.com/publishing/namespaces'
  if printf '%s\n' "$existing" | grep -qx CENTRAL_PORTAL_TOKEN && [ "${REPLACE:-0}" != 1 ]; then
    note 'CENTRAL_PORTAL_TOKEN is already set (REPLACE=1 asks again).'
  else
    note 'Generate a user token at https://central.sonatype.com/usertoken (Account > Generate User Token).'
    IFS= read -r -p '  Token username (empty to skip): ' user || true
    user=$(trim "$user")
    if [ -n "$user" ]; then
      IFS= read -r -s -p '  Token password (hidden): ' password || true
      printf '\n'
      token=$(printf '%s:%s' "$user" "$(trim "$password")" | base64 | tr -d '\n')
      password=''
      code=$(curl --silent --output /dev/null --write-out '%{http_code}' --user-agent "$UA" \
        --header @<(printf 'Authorization: Bearer %s\n' "$token") \
        "https://central.sonatype.com/api/v1/publisher/published?namespace=io.pylota&name=slotlock&version=$VERSION")
      if [ "$code" = 200 ]; then
        printf '%s' "$token" | gh secret set CENTRAL_PORTAL_TOKEN --env maven-central --repo "$OWNER/$REPO"
        note 'The Central Portal accepted the token: CENTRAL_PORTAL_TOKEN stored.'
      else
        warn "the Central Portal answered $code to the token: nothing stored"
      fi
      token=''
    fi
  fi

  if printf '%s\n' "$existing" | grep -qx MAVEN_SIGNING_KEY &&
    printf '%s\n' "$existing" | grep -qx MAVEN_SIGNING_PASSWORD && [ "${REPLACE:-0}" != 1 ]; then
    note 'MAVEN_SIGNING_KEY and MAVEN_SIGNING_PASSWORD are already set (REPLACE=1 stores them again).'
    pause
    return 0
  fi
  gnupg=$(temp_dir)
  # A key an earlier run made and saved is reused, so a run stopped after it was created (by a
  # failed upload, or between the two secrets) resumes with the same key instead of a second one.
  saved=$(find "$KEY_HOME" -maxdepth 1 -name '*.asc' 2>/dev/null | head -n 1 || true)
  if [ -n "$saved" ] && [ -f "${saved%.asc}.passphrase" ] && [ "${NEW_KEY:-0}" != 1 ]; then
    fpr=$(basename "${saved%.asc}")
    passphrase=$(head -n 1 "${saved%.asc}.passphrase")
    printf '%s' "$passphrase" | GNUPGHOME=$gnupg gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-fd 0 --import "$saved"
    note "Reusing the signing key $fpr saved in $KEY_HOME (NEW_KEY=1 makes a new one)."
  else
    email=$(git -C "$ROOT" config user.email || true)
    IFS= read -r -p "  Email for the signing key [$email]: " input || true
    email=$(trim "${input:-$email}")
    [ -n "$email" ] || die 'the signing key needs an email'
    passphrase=$(openssl rand -base64 30 | tr -d '\n/+=')
    printf '%s' "$passphrase" | GNUPGHOME=$gnupg gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-fd 0 --quick-generate-key "Slotlock release signing <$email>" rsa4096 sign 3y
    fpr=$(GNUPGHOME=$gnupg gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')
    mkdir -p "$KEY_HOME"
    chmod 700 "$KEY_HOME"
    printf '%s' "$passphrase" | GNUPGHOME=$gnupg gpg --batch --armor --pinentry-mode loopback \
      --passphrase-fd 0 --export-secret-keys "$fpr" >"$KEY_HOME/$fpr.asc"
    printf '%s\n' "$passphrase" >"$KEY_HOME/$fpr.passphrase"
    chmod 600 "$KEY_HOME/$fpr.asc" "$KEY_HOME/$fpr.passphrase"
    note "Signing key $fpr created and saved in $KEY_HOME."
  fi
  # The key Gradle reads must sign with this passphrase: prove it before storing anything.
  printf 'slotlock' >"$gnupg/probe"
  printf '%s' "$passphrase" | GNUPGHOME=$gnupg gpg --batch --quiet --pinentry-mode loopback \
    --passphrase-fd 0 --detach-sign --armor --output "$gnupg/probe.asc" "$gnupg/probe"
  GNUPGHOME=$gnupg gpg --batch --quiet --verify "$gnupg/probe.asc" "$gnupg/probe" 2>/dev/null ||
    die 'the key does not sign with its passphrase: nothing stored'
  # Central checks every signature against a key server, so a key it cannot find there is useless:
  # stop before storing it. A re-run reuses the saved key and tries the upload again.
  GNUPGHOME=$gnupg gpg --batch --quiet --keyserver hkps://keyserver.ubuntu.com --send-keys "$fpr" ||
    die "could not send the public key to keyserver.ubuntu.com: nothing stored; run this again"
  gh secret set MAVEN_SIGNING_KEY --env maven-central --repo "$OWNER/$REPO" <"$KEY_HOME/$fpr.asc"
  printf '%s' "$passphrase" | gh secret set MAVEN_SIGNING_PASSWORD --env maven-central --repo "$OWNER/$REPO"
  passphrase=''
  note "Signing key $fpr sent to keyserver.ubuntu.com, and MAVEN_SIGNING_KEY and"
  note 'MAVEN_SIGNING_PASSWORD stored.'
  note "A passphrase-protected copy and its passphrase are in $KEY_HOME: move them to a password"
  note 'manager and delete them there.'
  pause
}

step_site() {
  say 'Site (Cloudflare)'
  if [ "$DRY_RUN" -eq 1 ]; then
    note '(dry run) would run scripts/configure-github.sh --site-secrets'
  else
    "$ROOT/scripts/configure-github.sh" --site-secrets || warn 'the site secrets were not replaced'
  fi
}

step_rerun() {
  say 'Re-run the failed jobs'
  local run site answer
  if [ "$DRY_RUN" -eq 1 ]; then
    note "(dry run) would gh run rerun --failed the Release run of $TAG and the last failed Site run"
    return 0
  fi
  run=$(gh run list --repo "$OWNER/$REPO" --workflow release.yml --branch "$TAG" --limit 1 \
    --json databaseId,conclusion --jq '.[0] | select(.conclusion == "failure") | .databaseId')
  site=$(gh run list --repo "$OWNER/$REPO" --workflow site.yml --branch main --limit 1 \
    --json databaseId,conclusion --jq '.[0] | select(.conclusion == "failure") | .databaseId')
  [ -n "$run$site" ] || {
    note 'Nothing has failed.'
    return 0
  }
  IFS= read -r -p "  Re-run the failed jobs of${run:+ Release run $run}${site:+ and Site run $site}? [y/N] " answer || true
  case "$answer" in y | Y | yes) ;; *) return 0 ;; esac
  [ -z "$run" ] || gh run rerun "$run" --failed --repo "$OWNER/$REPO"
  [ -z "$site" ] || gh run rerun "$site" --failed --repo "$OWNER/$REPO"
  note 'Each registry job waits for your approval of its environment:'
  note "https://github.com/$OWNER/$REPO/actions${run:+/runs/$run}"
  note 'Maven Central then holds a deployment for you to publish:'
  note 'https://central.sonatype.com/publishing/deployments'
}

wants pypi && step_pypi
wants crates && step_crates
wants nuget && step_nuget
wants maven && step_maven
wants site && step_site
wants rerun && step_rerun
printf '\nDone.\n'
