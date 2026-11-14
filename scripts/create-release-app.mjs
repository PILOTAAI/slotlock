#!/usr/bin/env node
// Creates the release app, this repository's one GitHub App. "Release a version"
// (.github/workflows/release-version.yml) opens and merges release pull requests with it: checks on a
// pull request github-actions[bot] opens wait for a person's approval, an app's run at once. The CMS
// schedule (cms-schedule.yml) merges scheduled blog posts with the same key. The admin console
// writes posts and the status page's incidents, and reads deploys, with a private key of its own
// (scripts/configure-admin-console.mjs), so either key can be revoked alone.
//
// An owner of the PILOTAAI organization runs it once, from a checkout of main:
//   node scripts/create-release-app.mjs             create the app, install it, store it
//   node scripts/create-release-app.mjs --replace   the same, when one is already stored
//   node scripts/create-release-app.mjs --dry-run   print the app's manifest; change nothing
// Options: --name <app name> (default "PILOTAAI Slotlock release"; GitHub app names are unique),
// --no-open (print the page's address instead of opening a browser).
//
// It serves a page on 127.0.0.1 (scripts/github-app-manifest.mjs) that hands GitHub the manifest;
// you click "Create GitHub App", then install it on PILOTAAI/slotlock only. The app is private, has
// no webhook, and asks for what its users need between them (RELEASE_APP there): contents,
// pull_requests and issues write; actions, checks and statuses read. Each user mints its tokens with
// only its own part. It cannot change workflows, push past the "Protect main" ruleset or create
// release tags. Before storing anything, a short-lived installation token
// (revoked straight after) checks the installation reaches exactly PILOTAAI/slotlock with exactly
// those permissions. The private key goes to the release-app environment secret
// RELEASE_APP_PRIVATE_KEY via gh's stdin (never on disk, in an argument or on screen), and the
// client ID to the variable RELEASE_APP_CLIENT_ID. Only main can deploy to release-app
// (scripts/configure-github.sh).
//
// Needs Node.js 22.12+ and gh logged in as an organization owner. Environment (for tests):
// SLOTLOCK_GITHUB_URL, SLOTLOCK_GITHUB_API_URL, SLOTLOCK_POLL_SECONDS (3), SLOTLOCK_WAIT_MINUTES
// (30), SLOTLOCK_CONFIGURE_GITHUB (the configure script to run).
//
// Endpoints and fields read from the GitHub docs on 2026-10-23:
//   https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//   https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app
//   https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
//   https://docs.github.com/en/rest/apps/installations (list repositories, revoke the token)
//   https://cli.github.com/manual/gh_secret_set and gh_variable_set (the value on stdin, --env)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Failure,
  RELEASE_APP,
  createAppFromManifest,
  ghGet,
  ghSet,
  listPermissions,
  onlyMainDeploys,
  web,
} from './github-app-manifest.mjs';

const OWNER = 'PILOTAAI';
const REPO = 'slotlock';
const ENVIRONMENT = RELEASE_APP.environment;
const KEY_SECRET = RELEASE_APP.keySecret;
const CLIENT_ID_VARIABLE = RELEASE_APP.clientIdVariable;
// What the app asks for. GitHub adds metadata: read to every app.
const PERMISSIONS = RELEASE_APP.permissions;
const DEFAULT_NAME = RELEASE_APP.name;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configureScript =
  process.env.SLOTLOCK_CONFIGURE_GITHUB || join(root, 'scripts', 'configure-github.sh');

function usage() {
  return 'usage: node scripts/create-release-app.mjs [--replace] [--dry-run] [--no-open] [--name <app name>]';
}

function parseArguments(argv) {
  const options = { name: DEFAULT_NAME, replace: false, dryRun: false, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--replace') options.replace = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--name' && argv[index + 1]) {
      options.name = argv[index + 1];
      index += 1;
    } else return null;
  }
  // GitHub app names are at most 34 characters.
  if (options.name.trim() === '' || options.name.length > 34) return null;
  return options;
}

export function releaseAppManifest(name, base) {
  return {
    name,
    url: `https://github.com/${OWNER}/${REPO}`,
    description:
      "Opens and merges Slotlock's release pull requests, publishes scheduled blog posts, and keeps the admin console's posts, status page and deploy history.",
    hook_attributes: { url: 'https://slotlock.pylota.io/', active: false },
    redirect_url: `${base}/created`,
    setup_url: `${base}/installed`,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

/** The organization owner, the release-app environment limited to main, and nothing stored yet. */
function preflight(options) {
  const user = ghGet('user');
  if (!user?.login) throw new Failure('gh is not logged in (gh auth login).');
  const membership = ghGet(`user/memberships/orgs/${OWNER}`);
  if (membership?.role !== 'admin' || membership?.state !== 'active') {
    throw new Failure(
      `${user.login} is not an owner of ${OWNER}. Creating an app for the organization needs one.`,
    );
  }
  const environment = ghGet(`repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}`);
  if (!environment) {
    console.log(`The ${ENVIRONMENT} environment does not exist: running ${configureScript}.`);
    const configured = spawnSync('bash', [configureScript], {
      stdio: 'inherit',
      env: { ...process.env, SKIP_SITE_SECRETS: '1' },
    });
    if (configured.status !== 0) throw new Failure(`${configureScript} failed.`);
    if (!ghGet(`repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}`)) {
      throw new Failure(`${configureScript} did not create ${ENVIRONMENT}.`);
    }
  }
  if (!onlyMainDeploys(OWNER, REPO, ENVIRONMENT)) {
    throw new Failure(
      `Only main may deploy to ${ENVIRONMENT}, and it allows more: run ${configureScript}, which limits it.`,
    );
  }
  const stored = ghGet(
    `repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}/variables/${CLIENT_ID_VARIABLE}`,
  );
  if (stored && !options.replace) {
    throw new Failure(
      `A release app is already stored (client ID ${stored.value}). --replace creates and stores a new one.`,
    );
  }
  return { login: user.login, previous: stored?.value };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(usage());
    return 2;
  }
  if (options.dryRun) {
    console.log(
      JSON.stringify(releaseAppManifest(options.name, 'http://127.0.0.1:<port>'), null, 2),
    );
    console.log(
      `\nA real run serves that to ${web}/organizations/${OWNER}/settings/apps/new, waits for the app to be installed on ${OWNER}/${REPO} only, then stores ${KEY_SECRET} and ${CLIENT_ID_VARIABLE} in the ${ENVIRONMENT} environment.`,
    );
    return 0;
  }
  const { login, previous } = preflight(options);
  console.log(`Signed in to GitHub as ${login}, an owner of ${OWNER}.`);
  const { app } = await createAppFromManifest({
    owner: OWNER,
    repo: REPO,
    permissions: PERMISSIONS,
    manifest: (base) => releaseAppManifest(options.name, base),
    title: 'Create the Slotlock release app',
    agent: 'slotlock-create-release-app',
    retry: 'Install it as above and run this again with --replace',
    open: options.open,
  });
  try {
    console.log(`Installed on ${OWNER}/${REPO} only, with ${listPermissions(PERMISSIONS)}.`);
    // The key first: the workflow uses the app only once the client ID is there too.
    ghSet(
      ['secret', 'set', KEY_SECRET, '--env', ENVIRONMENT, '--repo', `${OWNER}/${REPO}`],
      app.pem,
    );
    ghSet([
      'variable',
      'set',
      CLIENT_ID_VARIABLE,
      '--env',
      ENVIRONMENT,
      '--repo',
      `${OWNER}/${REPO}`,
      '--body',
      app.client_id,
    ]);
    console.log(
      `Stored ${KEY_SECRET} and ${CLIENT_ID_VARIABLE} in the ${ENVIRONMENT} environment.`,
    );
    console.log(
      `Done. Release a version now opens and merges release pull requests as ${app.slug}[bot], and their checks run without anyone approving them.`,
    );
    console.log(
      `The admin console uses this app with a private key of its own: generate a second one at ${web}/organizations/${OWNER}/settings/apps/${app.slug} (Private keys > Generate a private key), and give it to node scripts/configure-admin-console.mjs go-live as SLOTLOCK_ADMIN_CMS_APP_KEY_FILE.`,
    );
    if (previous) {
      console.log(
        `The app with client ID ${previous} is no longer used: delete it under ${web}/organizations/${OWNER}/settings/apps.`,
      );
    }
    return 0;
  } finally {
    app.pem = '';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`error: ${error instanceof Failure ? error.message : error?.stack || error}`);
      process.exit(1);
    },
  );
}
