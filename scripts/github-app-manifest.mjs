// The release app, this repository's one GitHub App, and what scripts/create-release-app.mjs
// (which creates it) and scripts/configure-admin-console.mjs (which gives the admin console a key of
// it) share.
//
// Creating it from a manifest serves a page on 127.0.0.1 that hands GitHub the manifest; the person
// clicks "Create GitHub App", then installs it on the one repository. Before anything is stored:
//   - the app GitHub created must belong to the owner and hold exactly the manifest's permissions;
//   - a short-lived installation token (revoked straight after) must reach exactly that repository,
//     with exactly those permissions.
// Adopting it (checkAdoptedApp), with a private key of its own, checks the same of the app as it is,
// and says what the owner changes on GitHub when it is not so: its permissions in the app's
// settings, then the installation's review request for them.
// The private key stays in memory: the caller stores it through gh's or Wrangler's stdin, never on
// disk, in an argument or on screen.
//
// Environment (for tests): SLOTLOCK_GITHUB_URL, SLOTLOCK_GITHUB_API_URL, SLOTLOCK_POLL_SECONDS (3),
// SLOTLOCK_WAIT_MINUTES (30).
//
// Read from the GitHub docs on 2026-11-14: GET /app (the authenticated app: id, slug, client_id,
// owner, permissions), the installation's permissions and app_id in "Get a repository installation
// for the authenticated app", the JWT's `iss` as the client ID ("Use of the client ID is
// recommended"), and "Changing the permissions of a GitHub App" (Permissions & events; an
// installation keeps its permissions until the new ones are approved).
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

export const API_VERSION = '2026-03-10';

export const web = (process.env.SLOTLOCK_GITHUB_URL || 'https://github.com').replace(/\/+$/, '');
const api = (process.env.SLOTLOCK_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const pollMs = Number(process.env.SLOTLOCK_POLL_SECONDS || '3') * 1000;
export const waitMs = Number(process.env.SLOTLOCK_WAIT_MINUTES || '30') * 60_000;

/** A failure the script explains and exits 1 on. Its message never holds a private key. */
export class Failure extends Error {}

/**
 * The release app (scripts/create-release-app.mjs): the one GitHub App, installed on this repository
 * only. Its permissions are what its users need between them, and each mints tokens with only its own
 * part:
 *   - Release a version (release-version.yml): contents and pull requests write;
 *   - the CMS schedule (cms-schedule.yml), with the same key in the same environment: contents and
 *     pull requests write, checks read;
 *   - the admin console (workers/admin), with a private key of its own, revocable alone: contents,
 *     pull requests and issues write (posts, the status page's incidents), actions, checks and
 *     commit statuses read (deploys, a post's checks).
 * GitHub adds metadata: read to every app.
 */
export const RELEASE_APP = Object.freeze({
  name: 'PILOTAAI Slotlock release',
  environment: 'release-app',
  keySecret: 'RELEASE_APP_PRIVATE_KEY',
  clientIdVariable: 'RELEASE_APP_CLIENT_ID',
  permissions: Object.freeze({
    actions: 'read',
    checks: 'read',
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    statuses: 'read',
  }),
});

/** Runs gh. The input, when there is one, goes on stdin and never into a message. */
export function gh(args, input) {
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
export function ghGet(path) {
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

export function ghSet(args, input) {
  const result = gh(args, input);
  if (result.status !== 0) {
    throw new Failure(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
  }
}

/**
 * Whether only main may deploy to the repository's environment: the custom branch policy main,
 * and nothing else.
 */
export function onlyMainDeploys(owner, repo, name) {
  const environment = ghGet(`repos/${owner}/${repo}/environments/${name}`);
  if (!environment) return null;
  const policy = environment.deployment_branch_policy;
  const branches = ghGet(`repos/${owner}/${repo}/environments/${name}/deployment-branch-policies`);
  return (
    policy?.custom_branch_policies === true &&
    policy?.protected_branches === false &&
    branches?.branch_policies?.length === 1 &&
    branches.branch_policies[0].name === 'main' &&
    (branches.branch_policies[0].type ?? 'branch') === 'branch'
  );
}

export function escapeHtml(text) {
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

/** Exactly the wanted permissions, plus the metadata: read GitHub gives every app. */
function samePermissions(granted, wanted) {
  const { metadata, ...rest } = granted ?? {};
  if (metadata !== undefined && metadata !== 'read') return false;
  const keys = Object.keys(rest).sort();
  return (
    keys.join() === Object.keys(wanted).sort().join() &&
    keys.every((key) => rest[key] === wanted[key])
  );
}

function describePermissions(granted) {
  return Object.entries(granted ?? {})
    .map(([name, level]) => `${name}: ${level}`)
    .join(', ');
}

/** The permissions as a sentence: "contents: write and pull_requests: write". */
export function listPermissions(wanted) {
  const parts = Object.entries(wanted).map(([name, level]) => `${name}: ${level}`);
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** The app's JWT (RS256, ten minutes at most, issued a minute early for clock drift). */
function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.client_id })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(app.pem).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function githubApi(path, { method = 'GET', token, agent }) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': agent,
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
async function convert(code, spec) {
  const { status, body } = await githubApi(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: 'POST', agent: spec.agent },
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
    ? `${web}/organizations/${spec.owner}/settings/apps/${app.slug}/advanced`
    : `${web}/organizations/${spec.owner}/settings/apps`;
  const problems = [];
  if (typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug)) problems.push('no app slug');
  if (!Number.isSafeInteger(app.id) || app.id < 1) problems.push('no app ID');
  if (typeof app.client_id !== 'string' || app.client_id === '') problems.push('no client ID');
  if (typeof app.pem !== 'string' || !app.pem.includes('PRIVATE KEY-----')) {
    problems.push('no private key');
  }
  if (String(app.owner).toLowerCase() !== spec.owner.toLowerCase()) {
    problems.push(`it belongs to ${app.owner}, not ${spec.owner}`);
  }
  if (!samePermissions(app.permissions, spec.permissions)) {
    problems.push(`it was given ${describePermissions(app.permissions)}`);
  }
  if (problems.length > 0) {
    throw new Failure(
      `The app GitHub created is not the one the manifest asked for (${problems.join('; ')}). Nothing was stored. Delete it: ${settings}`,
    );
  }
  return { ...app, settings };
}

/** Mints a short-lived installation token, hands `use` GitHub's answer, and revokes it straight after. */
async function withInstallationToken(app, installationId, spec, use) {
  const minted = await githubApi(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt(app),
    agent: spec.agent,
  });
  if (minted.status !== 201 || !minted.body?.token) {
    throw new Failure(`GitHub would not mint an installation token (HTTP ${minted.status}).`);
  }
  try {
    return await use(minted.body);
  } finally {
    // Revoke the check's token now rather than let it live for an hour.
    await githubApi('/installation/token', { method: 'DELETE', token: minted.body.token, agent: spec.agent });
  }
}

/** Whether the installation reaches exactly this repository with exactly the app's permissions. */
function checkInstallation(app, installationId, spec) {
  return withInstallationToken(app, installationId, spec, (minted) => {
    if (!samePermissions(minted.permissions, spec.permissions)) {
      throw new Failure(
        `The installation has ${describePermissions(minted.permissions)}, not ${listPermissions(spec.permissions)}. Delete the app and run this again: ${app.settings}`,
      );
    }
    return reachesOnly(minted, installationId, spec);
  });
}

/** Whether an installation token's installation reaches exactly the repository, and if not, how to limit it. */
async function reachesOnly(minted, installationId, spec) {
  const listed = await githubApi('/installation/repositories?per_page=100', {
    token: minted.token,
    agent: spec.agent,
  });
  if (listed.status !== 200 || !listed.body) {
    throw new Failure(`GitHub would not list the installation's repositories (HTTP ${listed.status}).`);
  }
  const names = (listed.body.repositories ?? []).map((repository) => repository.full_name);
  const exact =
    minted.repository_selection === 'selected' &&
    listed.body.total_count === 1 &&
    names.length === 1 &&
    String(names[0]).toLowerCase() === `${spec.owner}/${spec.repo}`.toLowerCase();
  if (exact) return { ok: true };
  const reach =
    minted.repository_selection === 'all'
      ? `every repository in ${spec.owner}`
      : `${listed.body.total_count} repositories (${names.join(', ')})`;
  return {
    ok: false,
    problem: `The installation reaches ${reach}. Limit it to ${spec.repo}: ${web}/organizations/${spec.owner}/settings/installations/${installationId} > Only select repositories > ${spec.repo} > Save.`,
  };
}

/** A repository permission as an app's Permissions & events page names it ("Pull requests"). */
function permissionName(name) {
  if (name === 'statuses') return 'Commit statuses';
  const words = name.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
const LEVEL_NAMES = { read: 'Read-only', write: 'Read and write' };
const LEVEL_RANK = { read: 1, write: 2, admin: 3 };

/** What to set on the settings page for granted to become wanted: each permission at another level, or one too many. */
function permissionChanges(granted, wanted) {
  const changes = [];
  for (const [name, level] of Object.entries(wanted)) {
    if (granted?.[name] !== level) changes.push(`${permissionName(name)}: ${LEVEL_NAMES[level] ?? level}`);
  }
  for (const [name, level] of Object.entries(granted ?? {})) {
    if (name in wanted || (name === 'metadata' && level === 'read')) continue;
    changes.push(`${permissionName(name)}: No access`);
  }
  return changes;
}

/**
 * Whether an installation lacks a wanted permission, or has it at a lower level: only then does an
 * owner have to approve the app's new permissions for it. A removed one takes effect at once.
 */
function lacksPermissions(granted, wanted) {
  return Object.entries(wanted).some(([name, level]) => (LEVEL_RANK[granted?.[name]] ?? 0) < (LEVEL_RANK[level] ?? 0));
}

/**
 * Checks an app that already exists, signing in as it with one of its private keys: that it belongs
 * to the owner, asks for exactly these permissions, and that its installation on the repository has
 * accepted them and reaches that repository alone.
 *
 * spec: { owner, repo, clientId, pem, permissions, agent }
 * Returns { app: { id, slug, client_id }, installationId, steps }. `steps` is empty when the app can
 * be used as it is; otherwise it is what an owner of the organization does on GitHub, in order. A key
 * GitHub refuses, or an app another account owns, fails.
 */
export async function checkAdoptedApp(spec) {
  const signer = { client_id: spec.clientId, pem: spec.pem };
  const self = await githubApi('/app', { token: appJwt(signer), agent: spec.agent });
  if (self.status !== 200 || !self.body) {
    throw new Failure(
      `GitHub refused the key for the app with client ID ${spec.clientId} (HTTP ${self.status}): it is not a private key of that app, or it was deleted.`,
    );
  }
  const app = { id: self.body.id, slug: self.body.slug, client_id: self.body.client_id };
  if (
    !Number.isSafeInteger(app.id) ||
    typeof app.slug !== 'string' ||
    !/^[a-z0-9-]+$/.test(app.slug) ||
    app.client_id !== spec.clientId
  ) {
    throw new Failure(`GitHub did not answer as the app with client ID ${spec.clientId}.`);
  }
  if (String(self.body.owner?.login).toLowerCase() !== spec.owner.toLowerCase()) {
    throw new Failure(`The app ${app.slug} belongs to ${self.body.owner?.login}, not ${spec.owner}.`);
  }
  const steps = [];
  const changes = permissionChanges(self.body.permissions, spec.permissions);
  if (changes.length > 0) {
    steps.push(
      `Set its permissions: ${web}/organizations/${spec.owner}/settings/apps/${app.slug}/permissions > Repository permissions > ${changes.join('; ')} > Save changes.`,
    );
  }
  const found = await githubApi(`/repos/${spec.owner}/${spec.repo}/installation`, {
    token: appJwt(signer),
    agent: spec.agent,
  });
  if (found.status === 404) {
    steps.push(
      `Install it on ${spec.repo} only: ${web}/apps/${app.slug}/installations/new (Only select repositories > ${spec.repo} > Install).`,
    );
    return { app, installationId: null, steps };
  }
  if (found.status !== 200 || !Number.isSafeInteger(found.body?.id) || found.body?.app_id !== app.id) {
    throw new Failure(`GitHub answered HTTP ${found.status} for the app's installation on ${spec.repo}.`);
  }
  const installationId = found.body.id;
  // An installation keeps the permissions it accepted until an owner approves the app's new ones.
  if (lacksPermissions(found.body.permissions, spec.permissions)) {
    steps.push(
      `${changes.length > 0 ? 'Then accept them' : 'Accept its new permissions'} for the installation: ${web}/organizations/${spec.owner}/settings/installations/${installationId} > Review request > Accept new permissions.`,
    );
  }
  const reach = await withInstallationToken(signer, installationId, spec, (minted) =>
    reachesOnly(minted, installationId, spec),
  );
  if (!reach.ok) steps.push(reach.problem);
  return { app, installationId, steps };
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
async function serve(spec) {
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
      const action = `${web}/organizations/${spec.owner}/settings/apps/new?state=${state}`;
      const manifest = JSON.stringify(spec.manifest(base));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(web).origin}; frame-ancestors 'none'`,
      });
      response.end(
        page(
          spec.title,
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
        const app = await convert(url.searchParams.get('code') ?? '', spec);
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
async function waitForInstallation(app, installed, spec) {
  const deadline = Date.now() + waitMs;
  let reported = '';
  for (;;) {
    let id = installed.id;
    if (!id) {
      const found = await githubApi(`/repos/${spec.owner}/${spec.repo}/installation`, {
        token: appJwt(app),
        agent: spec.agent,
      });
      if (found.status === 200 && Number.isSafeInteger(found.body?.id)) id = found.body.id;
      else if (found.status !== 404) {
        throw new Failure(
          `GitHub answered HTTP ${found.status} for the app's installation on ${spec.repo}.`,
        );
      }
    }
    if (id) {
      const check = await checkInstallation(app, id, spec);
      if (check.ok) return id;
      if (check.problem !== reported) {
        console.log(check.problem);
        reported = check.problem;
      }
    } else if (reported === '') {
      reported = 'waiting';
      console.log(
        `Install the app on ${spec.owner}/${spec.repo} only: ${web}/apps/${app.slug}/installations/new (Only select repositories > ${spec.repo} > Install).`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Failure(
        `The app ${app.slug} is not installed on exactly ${spec.owner}/${spec.repo}. Nothing was stored. ${spec.retry}, or delete it: ${app.settings}`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Creates the app from its manifest through the person's browser, and waits until it is installed
 * on exactly the repository with exactly its permissions.
 *
 * spec: { owner, repo, permissions, manifest(base), title (the page's), agent (User-Agent),
 *         retry (what to do when the installation never narrows), open (whether to open a browser) }
 * Returns { app: { id, slug, client_id, pem, settings }, installationId }. The caller clears
 * app.pem once it has stored it.
 */
export async function createAppFromManifest(spec) {
  const local = await serve(spec);
  try {
    console.log(
      `Open ${local.base}/ and click "Create GitHub App for ${spec.owner}" on the page it leads to.`,
    );
    if (spec.open) openBrowser(`${local.base}/`);
    const app = await waitFor(
      local.appCreated,
      waitMs,
      'No app was created in time. Run this again when you are ready.',
    );
    console.log(`Created ${app.slug} (client ID ${app.client_id}).`);
    try {
      const installationId = await waitForInstallation(app, local.installed, spec);
      return { app, installationId };
    } catch (error) {
      app.pem = '';
      throw error;
    }
  } finally {
    local.close();
  }
}
