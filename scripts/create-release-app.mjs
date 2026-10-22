#!/usr/bin/env node
// Creates the GitHub App that "Release a version" (.github/workflows/release-version.yml) opens and
// merges release pull requests with. GitHub holds the checks of a pull request github-actions[bot]
// opens until a person approves them; the checks of a pull request an app opens run at once.
//
// An owner of the PILOTAAI organization runs it once, from a checkout of main:
//   node scripts/create-release-app.mjs             create the app, install it, store it
//   node scripts/create-release-app.mjs --replace   the same, when one is already stored
//   node scripts/create-release-app.mjs --dry-run   print the app's manifest; change nothing
// Options: --name <app name> (default "PILOTAAI Slotlock release"; GitHub app names are unique),
// --no-open (print the page's address instead of opening a browser).
//
// It serves a page on 127.0.0.1 that hands GitHub the app's manifest. You click "Create GitHub
// App", then install it on PILOTAAI/slotlock only. The app is private, has no webhook, and asks for
// contents: write and pull_requests: write and nothing else: it cannot change workflows, push past
// the "Protect main" ruleset or create release tags. Before storing anything, the script checks with
// a token of the new installation, revoked straight after, that the installation reaches exactly
// PILOTAAI/slotlock with exactly those permissions. Then it stores the private key as the release-app
// environment secret RELEASE_APP_PRIVATE_KEY (on gh's stdin: never on disk, in an argument or on the
// screen), and the client ID as the environment variable RELEASE_APP_CLIENT_ID. Only main can deploy
// to release-app (scripts/configure-github.sh), so only release-version.yml's job on main reads them.
//
// Needs Node.js 22.12 or newer, and gh logged in as an owner of the organization.
// Environment (for tests): SLOTLOCK_GITHUB_URL, SLOTLOCK_GITHUB_API_URL, SLOTLOCK_POLL_SECONDS (3),
// SLOTLOCK_WAIT_MINUTES (30), SLOTLOCK_CONFIGURE_GITHUB (the configure script to run).
//
// Endpoints and fields read from the GitHub docs on 2026-10-23:
//   https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//   https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app
//   https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
//   https://docs.github.com/en/rest/apps/installations (list repositories, revoke the token)
//   https://cli.github.com/manual/gh_secret_set and gh_variable_set (the value on stdin, --env)
import { spawn, spawnSync } from 'node:child_process';
import { createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'PILOTAAI';
const REPO = 'slotlock';
const ENVIRONMENT = 'release-app';
const KEY_SECRET = 'RELEASE_APP_PRIVATE_KEY';
const CLIENT_ID_VARIABLE = 'RELEASE_APP_CLIENT_ID';
const API_VERSION = '2026-03-10';
// What the app asks for. GitHub adds metadata: read to every app.
const PERMISSIONS = { contents: 'write', pull_requests: 'write' };
const DEFAULT_NAME = 'PILOTAAI Slotlock release';

const web = (process.env.SLOTLOCK_GITHUB_URL || 'https://github.com').replace(/\/+$/, '');
const api = (process.env.SLOTLOCK_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const pollMs = Number(process.env.SLOTLOCK_POLL_SECONDS || '3') * 1000;
const waitMs = Number(process.env.SLOTLOCK_WAIT_MINUTES || '30') * 60_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configureScript =
  process.env.SLOTLOCK_CONFIGURE_GITHUB || join(root, 'scripts', 'configure-github.sh');

/** A failure the script explains and exits 1 on. Its message never holds the private key. */
class Failure extends Error {}

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
      'Opens and merges Slotlock release pull requests for .github/workflows/release-version.yml.',
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

/** Runs gh. The input, when there is one, goes on stdin and never into a message. */
function gh(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: input ?? '',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Failure(`could not run gh: ${result.error.message}`);
  return result;
}

/** A GET through gh: the parsed body, or null on 404. Anything else fails. */
function ghGet(path) {
  const result = gh([
    'api',
    '--method',
    'GET',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    `X-GitHub-Api-Version: ${API_VERSION}`,
    path,
  ]);
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/\(HTTP 404\)/.test(result.stderr)) return null;
  throw new Failure(`gh api ${path} failed: ${result.stderr.trim()}`);
}

function ghSet(args, input) {
  const result = gh(args, input);
  if (result.status !== 0) {
    throw new Failure(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
  }
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
  let environment = ghGet(`repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}`);
  if (!environment) {
    console.log(`The ${ENVIRONMENT} environment does not exist: running ${configureScript}.`);
    const configured = spawnSync('bash', [configureScript], {
      stdio: 'inherit',
      env: { ...process.env, SKIP_SITE_SECRETS: '1' },
    });
    if (configured.status !== 0) throw new Failure(`${configureScript} failed.`);
    environment = ghGet(`repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}`);
    if (!environment) throw new Failure(`${configureScript} did not create ${ENVIRONMENT}.`);
  }
  const policy = environment.deployment_branch_policy;
  const branches = ghGet(
    `repos/${OWNER}/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies`,
  );
  const onlyMain =
    policy?.custom_branch_policies === true &&
    policy?.protected_branches === false &&
    branches?.branch_policies?.length === 1 &&
    branches.branch_policies[0].name === 'main' &&
    (branches.branch_policies[0].type ?? 'branch') === 'branch';
  if (!onlyMain) {
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

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function page(title, body, nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}${nonce ? `<script nonce="${nonce}">document.forms[0].submit();</script>` : ''}</body></html>`;
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function samePermissions(granted) {
  const { metadata, ...rest } = granted ?? {};
  if (metadata !== undefined && metadata !== 'read') return false;
  const keys = Object.keys(rest).sort();
  return (
    keys.join() === Object.keys(PERMISSIONS).sort().join() &&
    keys.every((key) => rest[key] === PERMISSIONS[key])
  );
}

function describePermissions(granted) {
  return Object.entries(granted ?? {})
    .map(([name, level]) => `${name}: ${level}`)
    .join(', ');
}

/** The app's JWT (RS256, ten minutes at most, issued a minute early for clock drift). */
function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.client_id })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(app.pem).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function githubApi(path, { method = 'GET', token } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'slotlock-create-release-app',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${api}${path}`, { method, headers });
  } catch (error) {
    throw new Failure(`could not reach ${api}: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Exchanges the manifest code for the new app, and checks it is what the manifest asked for. */
async function convert(code) {
  const { status, body } = await githubApi(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
    },
  );
  if (status !== 201 || !body) {
    throw new Failure(
      `GitHub did not create the app from its code (HTTP ${status}${body?.message ? `: ${body.message}` : ''}).`,
    );
  }
  const app = {
    id: body.id,
    slug: body.slug,
    client_id: body.client_id,
    pem: body.pem,
    owner: body.owner?.login,
    permissions: body.permissions,
  };
  const settings = app.slug
    ? `${web}/organizations/${OWNER}/settings/apps/${app.slug}/advanced`
    : `${web}/organizations/${OWNER}/settings/apps`;
  const problems = [];
  if (typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug)) problems.push('no app slug');
  if (typeof app.client_id !== 'string' || app.client_id === '') problems.push('no client ID');
  if (typeof app.pem !== 'string' || !app.pem.includes('PRIVATE KEY-----')) {
    problems.push('no private key');
  }
  if (String(app.owner).toLowerCase() !== OWNER.toLowerCase()) {
    problems.push(`it belongs to ${app.owner}, not ${OWNER}`);
  }
  if (!samePermissions(app.permissions)) {
    problems.push(`it was given ${describePermissions(app.permissions)}`);
  }
  if (problems.length > 0) {
    throw new Failure(
      `The app GitHub created is not the one the manifest asked for (${problems.join('; ')}). Nothing was stored. Delete it: ${settings}`,
    );
  }
  return { ...app, settings };
}

/** Whether the installation reaches exactly this repository with exactly the app's permissions. */
async function checkInstallation(app, installationId) {
  const minted = await githubApi(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt(app),
  });
  if (minted.status !== 201 || !minted.body?.token) {
    throw new Failure(`GitHub would not mint an installation token (HTTP ${minted.status}).`);
  }
  const token = minted.body.token;
  try {
    if (!samePermissions(minted.body.permissions)) {
      throw new Failure(
        `The installation has ${describePermissions(minted.body.permissions)}, not contents: write and pull_requests: write. Delete the app and run this again: ${app.settings}`,
      );
    }
    const listed = await githubApi('/installation/repositories?per_page=100', { token });
    if (listed.status !== 200 || !listed.body) {
      throw new Failure(
        `GitHub would not list the installation's repositories (HTTP ${listed.status}).`,
      );
    }
    const names = (listed.body.repositories ?? []).map((repository) => repository.full_name);
    const exact =
      minted.body.repository_selection === 'selected' &&
      listed.body.total_count === 1 &&
      names.length === 1 &&
      String(names[0]).toLowerCase() === `${OWNER}/${REPO}`.toLowerCase();
    if (exact) return { ok: true };
    const reach =
      minted.body.repository_selection === 'all'
        ? `every repository in ${OWNER}`
        : `${listed.body.total_count} repositories (${names.join(', ')})`;
    return {
      ok: false,
      problem: `The installation reaches ${reach}. Limit it to ${REPO}: ${web}/organizations/${OWNER}/settings/installations/${installationId} > Only select repositories > ${REPO} > Save.`,
    };
  } finally {
    // The check's token is not needed again: revoke it now rather than let it live for an hour.
    await githubApi('/installation/token', { method: 'DELETE', token });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address is printed too.
  }
}

/** Serves the manifest page and GitHub's two redirects, and resolves once the app exists. */
async function serve(options) {
  const state = randomBytes(32).toString('hex');
  let base = '';
  let created = null;
  let resolveCreated;
  let rejectCreated;
  const appCreated = new Promise((resolve, reject) => {
    resolveCreated = resolve;
    rejectCreated = reject;
  });
  const installed = { id: null };

  const server = createServer(async (request, response) => {
    const send = (status, title, body = '', headers = {}) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        ...headers,
      });
      response.end(page(title, body));
    };
    // Only this machine's browser, addressing this server by the address printed below.
    if (request.headers.host !== new URL(base).host) {
      send(421, 'Wrong address');
      return;
    }
    if (request.method !== 'GET') {
      send(405, 'Not allowed', '', { allow: 'GET' });
      return;
    }
    const url = new URL(request.url ?? '/', base);
    if (url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      const action = `${web}/organizations/${OWNER}/settings/apps/new?state=${state}`;
      const manifest = JSON.stringify(releaseAppManifest(options.name, base));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(web).origin}; frame-ancestors 'none'`,
      });
      response.end(
        page(
          'Create the Slotlock release app',
          `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button type="submit">Continue to GitHub</button></form>`,
          nonce,
        ),
      );
      return;
    }
    if (url.pathname === '/created') {
      if (!sameText(url.searchParams.get('state') ?? '', state)) {
        send(400, 'This request did not come from this script');
        return;
      }
      if (created) {
        send(409, 'The app was already created', '<p>Go back to the terminal.</p>');
        return;
      }
      created = 'pending';
      try {
        const app = await convert(url.searchParams.get('code') ?? '');
        created = app;
        resolveCreated(app);
        response.writeHead(302, {
          location: `${web}/apps/${app.slug}/installations/new`,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        response.end();
      } catch (error) {
        // Give up only once the browser has its answer: the script exits straight after.
        response.once('finish', () => rejectCreated(error));
        send(500, 'The app could not be set up', '<p>The terminal says why.</p>');
      }
      return;
    }
    if (url.pathname === '/installed') {
      const id = Number(url.searchParams.get('installation_id'));
      if (Number.isSafeInteger(id) && id > 0) installed.id = id;
      send(
        200,
        'Installed',
        '<p>Go back to the terminal: it checks the installation and stores the app.</p>',
      );
      return;
    }
    send(404, 'Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, appCreated, installed, close: () => server.close() };
}

async function waitFor(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failure(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until the app is installed on exactly this repository, and returns the installation. */
async function waitForInstallation(app, installed) {
  const deadline = Date.now() + waitMs;
  let reported = '';
  for (;;) {
    let id = installed.id;
    if (!id) {
      const found = await githubApi(`/repos/${OWNER}/${REPO}/installation`, { token: appJwt(app) });
      if (found.status === 200 && Number.isSafeInteger(found.body?.id)) id = found.body.id;
      else if (found.status !== 404) {
        throw new Failure(
          `GitHub answered HTTP ${found.status} for the app's installation on ${REPO}.`,
        );
      }
    }
    if (id) {
      const check = await checkInstallation(app, id);
      if (check.ok) return id;
      if (check.problem !== reported) {
        console.log(check.problem);
        reported = check.problem;
      }
    } else if (reported === '') {
      reported = 'waiting';
      console.log(
        `Install the app on ${OWNER}/${REPO} only: ${web}/apps/${app.slug}/installations/new (Only select repositories > ${REPO} > Install).`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Failure(
        `The app ${app.slug} is not installed on exactly ${OWNER}/${REPO}. Nothing was stored. Install it as above and run this again with --replace, or delete it: ${app.settings}`,
      );
    }
    await sleep(pollMs);
  }
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
  const local = await serve(options);
  let app = null;
  try {
    console.log(`Signed in to GitHub as ${login}, an owner of ${OWNER}.`);
    console.log(
      `Open ${local.base}/ and click "Create GitHub App for ${OWNER}" on the page it leads to.`,
    );
    if (options.open) openBrowser(`${local.base}/`);
    app = await waitFor(
      local.appCreated,
      waitMs,
      'No app was created in time. Run this again when you are ready.',
    );
    console.log(`Created ${app.slug} (client ID ${app.client_id}).`);
    await waitForInstallation(app, local.installed);
    console.log(
      `Installed on ${OWNER}/${REPO} only, with contents: write and pull_requests: write.`,
    );
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
    if (previous) {
      console.log(
        `The app with client ID ${previous} is no longer used: delete it under ${web}/organizations/${OWNER}/settings/apps.`,
      );
    }
    return 0;
  } finally {
    local.close();
    if (app) app.pem = '';
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
