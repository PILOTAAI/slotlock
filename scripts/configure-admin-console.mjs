#!/usr/bin/env node
// Sets up the admin console (RFC 0006, Phase 0) for Slotlock Cloud through Cloudflare's, GitHub's
// and the database's own interfaces, so the owner runs one script instead of a checklist. Two
// commands, each safe to run again; --dry-run prints what either would do and changes nothing.
//
//   node scripts/configure-admin-console.mjs prepare [--dry-run]
//     Any time: it makes nothing reachable.
//     - The console's own database role: SLOTLOCK_ADMIN_DATABASE_URL's, or slotlock_admin_app,
//       created with a random password (sent as a SCRAM verifier, so no server log holds it). Then
//       `slotlock migrate`, which grants that role the admin functions and no table.
//     - A Hyperdrive configuration, slotlock-admin, that connects as that role, caching disabled.
//     - A Cloudflare Access application for the console's hostname, with a policy that lets in only
//       the addresses in SLOTLOCK_ADMIN_ACCESS_EMAILS. An application already there is kept as it is.
//     - workers/admin/wrangler.deploy.jsonc: wrangler.jsonc with those values. It holds no secret.
//
//   node scripts/configure-admin-console.mjs go-live [--dry-run] [--no-open]
//     From 12 December 2026, when PRIVACY.md's staff sections take effect; refused before then.
//     - Deploys the Worker, which answers 503 until its secrets are set.
//     - Sets the secrets it lacks with `wrangler secret bulk`, on stdin: a new session secret; the
//       console's GitHub OAuth app's client ID and secret; the console's key, from
//       `slotlock staff console-key`; and, if given, a restricted Stripe key.
//     - Creates the "Slotlock CMS" GitHub App (two clicks in the browser), unless CMS_APP_ID is set.
//       Its key goes to the Worker and to the cms environment, then CMS_APP_ID and
//       CMS_APP_INSTALLATION are set, and the Worker is deployed again with them.
//     - Adds each person in SLOTLOCK_ADMIN_OWNERS who is not staff yet as an Owner, and prints
//       their one-time code for their first passkey.
//
// What it cannot do, and says so at the end: create the GitHub OAuth app (GitHub has no API for
// one), and each Owner's passkey, which they make on their own device.
//
// Environment:
//   CLOUDFLARE_API_TOKEN       a token with Access: Apps and Policies Write; Access:
//                              Organizations, Identity Providers, and Groups Read; Hyperdrive
//                              Write; and Workers Scripts Write (Wrangler uses it too)
//   CLOUDFLARE_ACCOUNT_ID      the account the console runs in
//   DATABASE_URL               the serving role's URL, as for `slotlock migrate`
//   SLOTLOCK_MIGRATE_DATABASE_URL  the schema owner's URL
//   SLOTLOCK_ADMIN_HOSTNAME    prepare: the console's hostname (admin.slotlock.pylota.io)
//   SLOTLOCK_ADMIN_ACCESS_EMAILS   prepare: the addresses Access lets in, comma-separated
//   SLOTLOCK_ADMIN_DATABASE_URL    prepare, optional: the console role's URL, when it exists
//   SLOTLOCK_ADMIN_DATABASE_HOST   prepare, optional: host[:port] Hyperdrive reaches the database
//                              at, when that is not the schema owner's URL's
//   SLOTLOCK_ADMIN_SITE_PREVIEW_HOST  prepare, optional: the site preview Worker's host
//                              (slotlock-site-preview.<subdomain>.workers.dev), for
//                              SITE_PREVIEW_HOST and the editor's preview links
//   SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE  prepare, optional: the website's Cloudflare Web Analytics
//                              site tag (32 hex characters), for the Site and search page
//   SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT  prepare, optional: the account that site tag is in, when it
//                              is not CLOUDFLARE_ACCOUNT_ID. A later prepare without these two keeps
//                              what the config already has
//   SLOTLOCK_ADMIN_OWNERS      go-live: the first Owners' GitHub logins, comma-separated (two, so
//                              erasure can be approved)
//   SLOTLOCK_ADMIN_GITHUB_CLIENT_ID, SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET, SLOTLOCK_ADMIN_STRIPE_KEY,
//   SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN
//                              go-live: read from the environment when set, else asked for without
//                              echo. The Stripe key and the Web Analytics token (Account Analytics
//                              Read, asked for only when a site tag is set) may be left out
// It also needs gh logged in as an owner of PILOTAAI, `npm ci` in workers/admin (Wrangler) and
// `npm run build` here (the slotlock CLI). For tests: SLOTLOCK_CLI, SLOTLOCK_WRANGLER,
// SLOTLOCK_CLOUDFLARE_API_URL, SLOTLOCK_ADMIN_CONFIG, SLOTLOCK_ADMIN_ROLE,
// SLOTLOCK_ADMIN_SETUP_TODAY (a YYYY-MM-DD date in place of today), SLOTLOCK_CONFIGURE_GITHUB and
// those of scripts/github-app-manifest.mjs.
//
// Cloudflare endpoints and fields read from developers.cloudflare.com/api on 2026-11-12:
//   resources/zero_trust/subresources/access/subresources/applications/methods/create and list
//   resources/zero_trust/subresources/access/subresources/policies/methods/create
//   resources/zero_trust/subresources/organizations/methods/list (auth_domain)
//   resources/hyperdrive/subresources/configs/methods/create and edit (the password is write-only)
// Wrangler 4.152: `secret bulk` reads JSON from stdin; `secret list` prints JSON.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  Failure,
  createAppFromManifest,
  ghGet,
  ghSet,
  listPermissions,
  onlyMainDeploys,
  web,
} from './github-app-manifest.mjs';

const OWNER = 'PILOTAAI';
const REPO = 'slotlock';
/** PRIVACY.md's staff sections take effect on this day; the console serves no one before it. */
const GO_LIVE = '2026-12-12';
const HYPERDRIVE_NAME = 'slotlock-admin';
const ACCESS_APP_NAME = 'Slotlock admin console';
const ACCESS_POLICY_NAME = 'Slotlock staff (admin console)';
/** An Access session lasts as long as the console's own, after its passkey. */
const SESSION = '8h';
const CMS_ENVIRONMENT = 'cms';
const CMS_APP_NAME = 'PILOTAAI Slotlock CMS';
// As workers/admin/wrangler.jsonc lists them. GitHub adds metadata: read to every app.
const CMS_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'read',
};
const DEFAULT_ROLE = 'slotlock_admin_app';
const MAX_EMAILS = 50;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(root, 'workers', 'admin', 'wrangler.jsonc');
const configPath =
  process.env.SLOTLOCK_ADMIN_CONFIG || join(root, 'workers', 'admin', 'wrangler.deploy.jsonc');
const cloudflareApi = (
  process.env.SLOTLOCK_CLOUDFLARE_API_URL || 'https://api.cloudflare.com/client/v4'
).replace(/\/+$/, '');
const cliCommand = process.env.SLOTLOCK_CLI
  ? [process.env.SLOTLOCK_CLI]
  : [process.execPath, join(root, 'dist', 'cli.js')];
const wranglerCommand = process.env.SLOTLOCK_WRANGLER
  ? [process.env.SLOTLOCK_WRANGLER]
  : [join(root, 'workers', 'admin', 'node_modules', '.bin', 'wrangler')];
const configureScript =
  process.env.SLOTLOCK_CONFIGURE_GITHUB || join(root, 'scripts', 'configure-github.sh');

function usage() {
  return 'usage: node scripts/configure-admin-console.mjs prepare|go-live [--dry-run] [--no-open]';
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== 'prepare' && command !== 'go-live') return null;
  const options = { command, dryRun: false, open: true };
  for (const argument of rest) {
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-open' && command === 'go-live') options.open = false;
    else return null;
  }
  return options;
}

// ---------- Inputs ----------

function optional(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function need(name, what) {
  const value = optional(name);
  if (!value) throw new Failure(`${name} is required: ${what}.`);
  return value;
}

const HYPERDRIVE_ID = /^[0-9a-f]{32}$/;
const AUDIENCE = /^[0-9a-f]{16,128}$/;
const GITHUB_ID = /^[1-9][0-9]{0,15}$/;
/** A Cloudflare account id or a Web Analytics site tag. */
const HEX32 = /^[0-9a-f]{32}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The example config's own hostnames, never a deployment's. */
function isExampleHost(host) {
  return host === 'example.com' || host.endsWith('.example.com');
}

function readHost(name, value) {
  const host = value.toLowerCase();
  if (!HOST.test(host) || isExampleHost(host)) {
    throw new Failure(`${name} must be a hostname, such as admin.slotlock.pylota.io.`);
  }
  return host;
}

function readEmails(value) {
  const emails = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0 || emails.length > MAX_EMAILS) {
    throw new Failure(`SLOTLOCK_ADMIN_ACCESS_EMAILS must list 1 to ${MAX_EMAILS} addresses.`);
  }
  for (const email of emails) {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) {
      throw new Failure(`SLOTLOCK_ADMIN_ACCESS_EMAILS holds something that is not an address.`);
    }
  }
  return emails;
}

function readLogins(value) {
  const logins = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (logins.length === 0 || logins.some((login) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login))) {
    throw new Failure('SLOTLOCK_ADMIN_OWNERS must list GitHub logins, comma-separated.');
  }
  return logins;
}

function readDatabaseUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Failure(`${name} is not a URL.`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || !url.username) {
    throw new Failure(`${name} must be a postgres:// URL with a user and a host.`);
  }
  return url;
}

/** Asks for a value without echoing it; only from a terminal. Empty is allowed when optional. */
async function askHidden(question, { optional: allowEmpty = false } = {}) {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Failure('Stopped.'));
            return;
          }
          if (character === '\r' || character === '\n') {
            if (value === '' && !allowEmpty) continue;
            process.stdin.off('data', onData);
            process.stdout.write('\n');
            resolve(value);
            return;
          }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character >= ' ') value += character;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/** A secret from the environment, or asked for. Never printed, never an argument. */
async function secret(name, question, { optional: allowEmpty = false } = {}) {
  const given = process.env[name];
  if (given !== undefined) return given.trim();
  const asked = await askHidden(question, { optional: allowEmpty });
  if (asked === null) {
    if (allowEmpty) return '';
    throw new Failure(`Set ${name}, or run this in a terminal to be asked for it.`);
  }
  return asked.trim();
}

// ---------- Commands it runs ----------

/** Runs a command with its input on stdin. Output is captured or shown; it never echoes the input. */
function run(command, args, { env = {}, input, capture = false, what }) {
  const [file, ...prefix] = command;
  const result = spawnSync(file, [...prefix, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    input: input ?? '',
    encoding: 'utf8',
    stdio: ['pipe', capture ? 'pipe' : 'inherit', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Failure(`could not run ${what}: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = (result.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 600);
    throw new Failure(`${what} failed${reason ? `: ${reason}` : ''}.`);
  }
  if (!capture && result.stderr) process.stderr.write(result.stderr);
  return result.stdout ?? '';
}

function slotlock(args, env, options = {}) {
  return run(cliCommand, args, { env, what: `slotlock ${args.join(' ')}`, ...options });
}

function wrangler(args, options = {}) {
  return run(wranglerCommand, args, { what: `wrangler ${args[0]} ${args[1] ?? ''}`.trim(), ...options });
}

/** The JSON lines a slotlock command printed that carry `field`: its output, not its log. */
function lines(text, field) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null && field in value);
}

/** The JSON array Wrangler printed, after whatever banner it printed first. */
function jsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Failure('wrangler secret list printed no list.');
  return JSON.parse(text.slice(start, end + 1));
}

/** The slotlock CLI and Wrangler are where this script runs them from. */
function checkTools() {
  if (!process.env.SLOTLOCK_CLI && !existsSync(cliCommand[1])) {
    throw new Failure('The slotlock CLI is not built: run "npm ci && npm run build" here first.');
  }
  if (!process.env.SLOTLOCK_WRANGLER && !existsSync(wranglerCommand[0])) {
    throw new Failure('Wrangler is not installed for the console: run "npm ci" in workers/admin first.');
  }
}

// ---------- Cloudflare ----------

async function cloudflare(method, path, body) {
  let response;
  try {
    response = await fetch(`${cloudflareApi}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN?.trim()}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Failure(`could not reach ${cloudflareApi}: ${error.message}`);
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok || parsed?.success !== true) {
    const reasons = (parsed?.errors ?? []).map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim());
    // The request's body may hold a password: name the call, never what was sent.
    throw new Failure(
      `Cloudflare refused ${method} ${path.split('?')[0]} (HTTP ${response.status}${reasons.length ? `: ${reasons.join('; ')}` : ''}).`,
    );
  }
  return parsed.result;
}

// ---------- Database ----------

/** A SCRAM-SHA-256 verifier, as PostgreSQL stores one: the password itself never reaches it. */
function scramVerifier(password) {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The console's role: the one SLOTLOCK_ADMIN_DATABASE_URL names, or a new one. */
async function consoleRole(ownerUrl) {
  const given = optional('SLOTLOCK_ADMIN_DATABASE_URL');
  if (given) {
    const url = readDatabaseUrl('SLOTLOCK_ADMIN_DATABASE_URL', given);
    if (!url.password) throw new Failure('SLOTLOCK_ADMIN_DATABASE_URL needs the role\'s password: Hyperdrive connects with it.');
    return { name: decodeURIComponent(url.username), password: decodeURIComponent(url.password), url, created: false };
  }
  const name = process.env.SLOTLOCK_ADMIN_ROLE?.trim() || DEFAULT_ROLE;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Failure('SLOTLOCK_ADMIN_ROLE must be a lowercase role name.');
  const sql = postgres(ownerUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const [exists] = await sql`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${name}`;
    if (exists) {
      throw new Failure(
        `The role ${name} exists already. Set SLOTLOCK_ADMIN_DATABASE_URL to its URL (the one your releases give slotlock migrate) and run prepare again; this script will not change a password something else may use.`,
      );
    }
    const password = randomBytes(32).toString('base64url');
    try {
      await sql.unsafe(
        `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${scramVerifier(password)}'`,
      );
    } catch (error) {
      if (error?.code === '42501') {
        throw new Failure(
          `The schema owner may not create roles. Create the console's yourself (CREATE ROLE ${name} LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS), set SLOTLOCK_ADMIN_DATABASE_URL to its URL, and run prepare again.`,
        );
      }
      throw error;
    }
    const url = new URL(ownerUrl.toString());
    url.username = name;
    url.password = password;
    return { name, password, url, created: true };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The host and port Hyperdrive connects to: SLOTLOCK_ADMIN_DATABASE_HOST, or the URL's. Never this machine. */
function originAddress(url) {
  const override = optional('SLOTLOCK_ADMIN_DATABASE_HOST');
  const [host, port] = override ? override.split(/:(?=\d+$)/) : [url.hostname, url.port];
  if (!host || /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host)) {
    throw new Failure(
      `Hyperdrive cannot reach ${host || 'that host'}: set SLOTLOCK_ADMIN_DATABASE_HOST to the host[:port] Cloudflare connects to.`,
    );
  }
  return { host, port: Number(port || 5432) };
}

/** Where Hyperdrive connects, as the console's role. */
function origin(role) {
  const { host, port } = originAddress(role.url);
  return {
    scheme: 'postgres',
    host,
    port,
    database: decodeURIComponent(role.url.pathname.replace(/^\//, '')) || 'postgres',
    user: role.name,
  };
}

// ---------- prepare ----------

async function ensureHyperdrive(account, role) {
  const wanted = origin(role);
  const configs = await cloudflare('GET', `/accounts/${account}/hyperdrive/configs`);
  const found = (configs ?? []).find((config) => config.name === HYPERDRIVE_NAME);
  let config;
  if (found) {
    const same = found.origin?.host === wanted.host && Number(found.origin?.port) === wanted.port;
    if (!same) {
      throw new Failure(
        `The Hyperdrive configuration ${HYPERDRIVE_NAME} connects to ${found.origin?.host}:${found.origin?.port}, not ${wanted.host}:${wanted.port}. Delete it in the Cloudflare dashboard, or set SLOTLOCK_ADMIN_DATABASE_HOST, and run prepare again.`,
      );
    }
    // Keeps it in step with the role: its user, database and password, and no cache.
    config = await cloudflare('PATCH', `/accounts/${account}/hyperdrive/configs/${found.id}`, {
      origin: { scheme: wanted.scheme, database: wanted.database, user: wanted.user, password: role.password },
      caching: { disabled: true },
    });
  } else {
    config = await cloudflare('POST', `/accounts/${account}/hyperdrive/configs`, {
      name: HYPERDRIVE_NAME,
      origin: { ...wanted, password: role.password },
      caching: { disabled: true },
    });
  }
  if (!HYPERDRIVE_ID.test(config?.id ?? '') || config.origin?.user !== role.name || config.caching?.disabled !== true) {
    throw new Failure(
      `Hyperdrive answered without connecting as ${role.name} with caching disabled: check ${HYPERDRIVE_NAME} in the Cloudflare dashboard.`,
    );
  }
  return { id: config.id, created: !found };
}

async function ensureAccess(account, hostname, emails) {
  const organization = await cloudflare('GET', `/accounts/${account}/access/organizations`);
  const teamDomain = String(organization?.auth_domain ?? '').toLowerCase();
  if (!HOST.test(teamDomain)) {
    throw new Failure('This account has no Cloudflare Zero Trust organization yet: set one up (its team domain), then run prepare again.');
  }
  const apps = await cloudflare(
    'GET',
    `/accounts/${account}/access/apps?domain=${encodeURIComponent(hostname)}&exact=true`,
  );
  const existing = (apps ?? []).find((app) => String(app.domain).toLowerCase() === hostname);
  if (existing) {
    if (!AUDIENCE.test(existing.aud ?? '')) {
      throw new Failure(`The Access application for ${hostname} has no Audience tag the console can check.`);
    }
    return { teamDomain, aud: existing.aud, created: false };
  }
  const include = emails.map((email) => ({ email: { email } }));
  const policies = await cloudflare('GET', `/accounts/${account}/access/policies`);
  let policy = (policies ?? []).find((item) => item.name === ACCESS_POLICY_NAME);
  if (!policy) {
    policy = await cloudflare('POST', `/accounts/${account}/access/policies`, {
      name: ACCESS_POLICY_NAME,
      decision: 'allow',
      include,
      session_duration: SESSION,
    });
  }
  const app = await cloudflare('POST', `/accounts/${account}/access/apps`, {
    name: ACCESS_APP_NAME,
    domain: hostname,
    type: 'self_hosted',
    session_duration: SESSION,
    app_launcher_visible: false,
    policies: [{ id: policy.id, precedence: 1 }],
  });
  if (!AUDIENCE.test(app?.aud ?? '')) {
    throw new Failure(`Cloudflare created the Access application for ${hostname} without an Audience tag.`);
  }
  // Without its policy, Access lets no one in: safe, but the console would be unusable.
  if (!(app.policies ?? []).some((attached) => (attached?.id ?? attached) === policy.id)) {
    throw new Failure(
      `Cloudflare created the Access application for ${hostname} without the policy "${ACCESS_POLICY_NAME}": attach it in the Zero Trust dashboard, then run prepare again.`,
    );
  }
  return { teamDomain, aud: app.aud, created: true };
}

/** A repository variable's value, or undefined. */
function repositoryVariable(name) {
  return ghGet(`repos/${OWNER}/${REPO}/actions/variables/${name}`)?.value || undefined;
}

/**
 * What Cloudflare and GitHub answered, checked against the shape each value has before any of it
 * goes in the file: a value of any other shape stops the script.
 */
function checkValues(values) {
  const shapes = [
    ['the hostname', values.hostname, HOST, false],
    ["Hyperdrive's configuration id", values.hyperdrive, HYPERDRIVE_ID, false],
    ["Access's team domain", values.teamDomain, HOST, false],
    ["the Access application's Audience tag", values.aud, AUDIENCE, false],
    ["the CMS App's id", values.cmsAppId, GITHUB_ID, true],
    ["the CMS App's installation id", values.cmsInstallation, GITHUB_ID, true],
    ['the site preview host', values.previewHost, HOST, true],
    ['the Web Analytics site tag', values.analyticsSite, HEX32, true],
    ["the Web Analytics site's account", values.analyticsAccount, HEX32, true],
  ];
  if (Boolean(values.analyticsSite) !== Boolean(values.analyticsAccount)) {
    throw new Failure(`Web Analytics needs both its site tag and its account, so ${configPath} was not written.`);
  }
  for (const [what, value, shape, optional] of shapes) {
    if (optional && (value === undefined || value === '')) continue;
    if (typeof value !== 'string' || !shape.test(value) || isExampleHost(value)) {
      throw new Failure(`${what} is not what one looks like, so ${configPath} was not written.`);
    }
  }
}

/** wrangler.jsonc with this deployment's values: each placeholder must be found exactly once. */
function writeConfig(values) {
  checkValues(values);
  let text = readFileSync(template, 'utf8');
  const set = (pattern, replacement, what) => {
    const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
    if (matches.length !== 1) throw new Failure(`workers/admin/wrangler.jsonc no longer has ${what}: update this script.`);
    text = text.replace(pattern, replacement);
  };
  const variable = (name, value) =>
    set(new RegExp(`"${name}": "[^"]*"`), `"${name}": ${JSON.stringify(value)}`, name);
  set(/"pattern": "admin\.example\.com"/, `"pattern": ${JSON.stringify(values.hostname)}`, 'its route');
  set(
    /"id": "set-this-to-the-admin-hyperdrive-configuration-id"/,
    `"id": ${JSON.stringify(values.hyperdrive)}`,
    'its Hyperdrive id',
  );
  variable('SLOTLOCK_ADMIN_PUBLIC_URL', `https://${values.hostname}`);
  variable('SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN', values.teamDomain);
  variable('SLOTLOCK_ADMIN_ACCESS_AUD', values.aud);
  variable('SLOTLOCK_ADMIN_CMS_APP_ID', values.cmsAppId ?? '');
  variable('SLOTLOCK_ADMIN_CMS_INSTALLATION', values.cmsInstallation ?? '');
  variable('SLOTLOCK_ADMIN_PREVIEW_HOST', values.previewHost ?? '');
  variable('SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT', values.analyticsAccount ?? '');
  variable('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE', values.analyticsSite ?? '');
  const header =
    '// Written by scripts/configure-admin-console.mjs from wrangler.jsonc, for this deployment. It\n' +
    '// holds no secret; run `configure-admin-console.mjs prepare` again to write it afresh.\n';
  writeFileSync(configPath, header + text);
}

/**
 * Web Analytics for the Site and search page: the site tag given, in the account given or the one the
 * console runs in; or, when none is given, what the config already has, so a later prepare keeps it.
 */
function webAnalytics(account) {
  const site = optional('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE')?.toLowerCase();
  if (site) {
    const inAccount = (optional('SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT') ?? account).toLowerCase();
    if (!HEX32.test(site)) throw new Failure('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE must be the site tag: 32 hex characters.');
    if (!HEX32.test(inAccount)) {
      throw new Failure('The Web Analytics account (SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT, or CLOUDFLARE_ACCOUNT_ID) must be 32 hex characters.');
    }
    return { site, account: inAccount, kept: false };
  }
  if (!existsSync(configPath)) return { site: undefined, account: undefined, kept: false };
  const text = readFileSync(configPath, 'utf8');
  const value = (name) => new RegExp(`"${name}": "([0-9a-f]{32})"`).exec(text)?.[1];
  const kept = { site: value('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE'), account: value('SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT') };
  return kept.site && kept.account ? { ...kept, kept: true } : { site: undefined, account: undefined, kept: false };
}

/** The values a written config holds, to deploy with or to rewrite. */
function readConfig() {
  if (!existsSync(configPath)) {
    throw new Failure(`${configPath} does not exist: run "node scripts/configure-admin-console.mjs prepare" first.`);
  }
  const text = readFileSync(configPath, 'utf8');
  const value = (name) => new RegExp(`"${name}": "([^"]*)"`).exec(text)?.[1] ?? '';
  const config = {
    text,
    publicUrl: value('SLOTLOCK_ADMIN_PUBLIC_URL'),
    hostname: new URL(value('SLOTLOCK_ADMIN_PUBLIC_URL') || 'https://unset.invalid').hostname,
    hyperdrive: /"id": "([^"]*)"/.exec(text)?.[1] ?? '',
    teamDomain: value('SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN'),
    aud: value('SLOTLOCK_ADMIN_ACCESS_AUD'),
    cmsAppId: value('SLOTLOCK_ADMIN_CMS_APP_ID'),
    cmsInstallation: value('SLOTLOCK_ADMIN_CMS_INSTALLATION'),
    previewHost: value('SLOTLOCK_ADMIN_PREVIEW_HOST'),
    analyticsAccount: value('SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT'),
    analyticsSite: value('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE'),
  };
  const placeholder =
    !HYPERDRIVE_ID.test(config.hyperdrive) ||
    !AUDIENCE.test(config.aud) ||
    !HOST.test(config.teamDomain) ||
    config.hostname === 'unset.invalid' ||
    isExampleHost(config.hostname);
  if (placeholder) throw new Failure(`${configPath} still has placeholders: run prepare again.`);
  return config;
}

async function prepare(options) {
  const hostname = readHost('SLOTLOCK_ADMIN_HOSTNAME', need('SLOTLOCK_ADMIN_HOSTNAME', "the console's hostname"));
  const emails = readEmails(need('SLOTLOCK_ADMIN_ACCESS_EMAILS', 'the addresses Cloudflare Access lets in'));
  const servingUrl = readDatabaseUrl('DATABASE_URL', need('DATABASE_URL', "the serving role's URL"));
  const ownerUrl = readDatabaseUrl(
    'SLOTLOCK_MIGRATE_DATABASE_URL',
    need('SLOTLOCK_MIGRATE_DATABASE_URL', "the schema owner's URL"),
  );
  const account = need('CLOUDFLARE_ACCOUNT_ID', 'the Cloudflare account the console runs in');
  need('CLOUDFLARE_API_TOKEN', 'a Cloudflare API token (see the top of this script)');
  const previewInput = optional('SLOTLOCK_ADMIN_SITE_PREVIEW_HOST');
  const previewHost = previewInput ? readHost('SLOTLOCK_ADMIN_SITE_PREVIEW_HOST', previewInput) : undefined;
  const analytics = webAnalytics(account);

  // Refused before anything, dry run included: Cloudflare cannot connect to this machine.
  const given = optional('SLOTLOCK_ADMIN_DATABASE_URL');
  const roleUrl = given ? readDatabaseUrl('SLOTLOCK_ADMIN_DATABASE_URL', given) : ownerUrl;
  const address = originAddress(roleUrl);

  if (options.dryRun) {
    const roleName = given
      ? decodeURIComponent(roleUrl.username)
      : process.env.SLOTLOCK_ADMIN_ROLE?.trim() || DEFAULT_ROLE;
    const database = decodeURIComponent(roleUrl.pathname.replace(/^\//, '')) || 'postgres';
    console.log(
      [
        'prepare would:',
        given
          ? `  1. use the role ${roleName} that SLOTLOCK_ADMIN_DATABASE_URL names as the console's database role`
          : `  1. create the role ${roleName} as the console's database role, with a random password, and show its URL once.\n     If ${roleName} exists already, it stops instead: set SLOTLOCK_ADMIN_DATABASE_URL to that role's URL.`,
        `     Then run slotlock migrate, which grants ${roleName} the admin functions and no table.`,
        `  2. create or update the Hyperdrive configuration ${HYPERDRIVE_NAME}: ${roleName} at ${address.host}:${address.port}, database ${database}, caching disabled`,
        `  3. create the Access application "${ACCESS_APP_NAME}" for ${hostname}, letting in only:`,
        ...emails.map((email) => `       ${email}`),
        '     An Access application already there for that hostname is kept as it is, with its own policies.',
        previewHost ? `  4. set the repository variable SITE_PREVIEW_HOST to ${previewHost}` : '  4. leave SITE_PREVIEW_HOST as it is',
        `  5. write ${configPath}`,
        analytics.site
          ? `     with Web Analytics for the site tag ${analytics.site} in the account ${analytics.account}${analytics.kept ? ' (kept from the config already there)' : ''}`
          : '     without Web Analytics (set SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE to add it)',
        'Nothing was changed.',
      ].join('\n'),
    );
    return 0;
  }

  checkTools();
  console.log(`1. The console's database role`);
  const role = await consoleRole(ownerUrl);
  console.log(role.created ? `   Created ${role.name}.` : `   Using ${role.name}.`);
  slotlock(['migrate'], {
    DATABASE_URL: servingUrl.toString(),
    SLOTLOCK_MIGRATE_DATABASE_URL: ownerUrl.toString(),
    SLOTLOCK_ADMIN_DATABASE_URL: role.url.toString(),
  });
  console.log(`   slotlock migrate granted ${role.name} the admin functions.`);

  console.log('2. Hyperdrive');
  const hyperdrive = await ensureHyperdrive(account, role);
  console.log(`   ${hyperdrive.created ? 'Created' : 'Updated'} ${HYPERDRIVE_NAME} (${hyperdrive.id}), as ${role.name}, caching disabled.`);

  console.log('3. Cloudflare Access');
  const access = await ensureAccess(account, hostname, emails);
  console.log(
    access.created
      ? `   Created ${ACCESS_APP_NAME} for ${hostname}, with the policy "${ACCESS_POLICY_NAME}" (${emails.length} address${emails.length === 1 ? '' : 'es'}).`
      : `   Kept the Access application already there for ${hostname}; its policies are yours to manage in the Zero Trust dashboard.`,
  );

  console.log('4. GitHub');
  if (previewHost) {
    ghSet(['variable', 'set', 'SITE_PREVIEW_HOST', '--repo', `${OWNER}/${REPO}`, '--body', previewHost]);
    console.log(`   Set SITE_PREVIEW_HOST to ${previewHost}.`);
  }
  const values = {
    hostname,
    hyperdrive: hyperdrive.id,
    teamDomain: access.teamDomain,
    aud: access.aud,
    previewHost: previewHost ?? repositoryVariable('SITE_PREVIEW_HOST'),
    cmsAppId: repositoryVariable('CMS_APP_ID'),
    cmsInstallation: repositoryVariable('CMS_APP_INSTALLATION'),
    analyticsSite: analytics.site,
    analyticsAccount: analytics.account,
  };

  console.log('5. The Worker\'s configuration');
  writeConfig(values);
  console.log(`   Wrote ${configPath}.`);
  if (analytics.site) {
    console.log(`   Web Analytics: the site tag ${analytics.site}, in the account ${analytics.account}. go-live asks for its token.`);
  }

  console.log(`\nPrepared. Nothing serves yet: "go-live" deploys the console, from ${GO_LIVE}.`);
  if (role.created) {
    // Shown once, like `slotlock staff console-key`: releases need it, and nothing here keeps it.
    console.log(
      `\nThe console role's URL, shown only now. Store it where your releases set SLOTLOCK_MIGRATE_DATABASE_URL, as SLOTLOCK_ADMIN_DATABASE_URL, so each release's migrate grants the console its new functions:\n  ${role.url.toString()}`,
    );
  }
  return 0;
}

// ---------- go-live ----------

function today() {
  const given = process.env.SLOTLOCK_ADMIN_SETUP_TODAY?.trim();
  if (given && /^\d{4}-\d{2}-\d{2}$/.test(given)) return given;
  return new Date().toISOString().slice(0, 10);
}

/** The cms environment exists and only main deploys to it. */
function cmsEnvironment() {
  let only = onlyMainDeploys(OWNER, REPO, CMS_ENVIRONMENT);
  if (only === null) {
    console.log(`The ${CMS_ENVIRONMENT} environment does not exist: running ${configureScript}.`);
    const configured = spawnSync('bash', [configureScript], {
      stdio: 'inherit',
      env: { ...process.env, SKIP_SITE_SECRETS: '1' },
    });
    if (configured.status !== 0) throw new Failure(`${configureScript} failed.`);
    only = onlyMainDeploys(OWNER, REPO, CMS_ENVIRONMENT);
  }
  if (!only) {
    throw new Failure(
      `Only main may deploy to ${CMS_ENVIRONMENT}, and it ${only === null ? 'does not exist' : 'allows more'}: run ${configureScript}, which limits it.`,
    );
  }
}

export function cmsAppManifest(base) {
  return {
    name: CMS_APP_NAME,
    url: `https://github.com/${OWNER}/${REPO}`,
    description:
      "Saves, schedules and publishes the blog's posts for the Slotlock admin console, and keeps its status page (RFC 0006).",
    hook_attributes: { url: 'https://slotlock.pylota.io/', active: false },
    redirect_url: `${base}/created`,
    setup_url: `${base}/installed`,
    public: false,
    default_permissions: CMS_PERMISSIONS,
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

async function goLive(options) {
  const date = today();
  const config = readConfig();
  const owners = readLogins(need('SLOTLOCK_ADMIN_OWNERS', "the first Owners' GitHub logins"));
  const servingUrl = need('DATABASE_URL', "the serving role's URL");
  const ownerUrl = need('SLOTLOCK_MIGRATE_DATABASE_URL', "the schema owner's URL");
  need('CLOUDFLARE_ACCOUNT_ID', 'the Cloudflare account the console runs in');
  need('CLOUDFLARE_API_TOKEN', 'a Cloudflare API token (see the top of this script)');
  const database = { DATABASE_URL: servingUrl, SLOTLOCK_MIGRATE_DATABASE_URL: ownerUrl };

  if (options.dryRun) {
    console.log(
      [
        date < GO_LIVE ? `go-live is refused until ${GO_LIVE} (today is ${date}). From then it would:` : 'go-live would:',
        `  Before it runs: create the console's own GitHub OAuth app at ${web}/organizations/${OWNER}/settings/applications/new,`,
        `  with the callback https://${config.hostname}/callback. go-live asks for its client ID and secret.`,
        `  1. deploy the Worker with ${configPath} to https://${config.hostname}.`,
        '     It answers 503 to everyone until step 2 is done.',
        '  2. set each of these secrets the Worker lacks, on stdin, never shown; one already set is left as it is:',
        '       SLOTLOCK_ADMIN_SESSION_SECRET        made at random',
        '       SLOTLOCK_ADMIN_GITHUB_CLIENT_ID      asked for, or taken from that variable',
        '       SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET  asked for without echo, or taken from that variable',
        '       SLOTLOCK_ADMIN_CONSOLE_KEY           from slotlock staff console-key, as the schema owner',
        '       SLOTLOCK_ADMIN_STRIPE_KEY            a restricted Stripe key, if you give one',
        ...(config.analyticsSite
          ? ['       SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN      a token with Account Analytics Read, for Web Analytics, if you give one']
          : []),
        `  3. unless the repository variable CMS_APP_ID is set: create the "${CMS_APP_NAME}" GitHub App`,
        `     (you click Create, then Install, on ${OWNER}/${REPO} only), store its key in the Worker and the`,
        `     ${CMS_ENVIRONMENT} environment, set CMS_APP_ID and CMS_APP_INSTALLATION, and deploy again`,
        `  4. add as Owners those of ${owners.join(', ')} who are not staff yet (each must be a GitHub user),`,
        '     and print each one\'s one-time code for their first passkey',
        ...(owners.length < 2 ? ['     Erasing an account needs a second Owner to approve: name two when you can.'] : []),
        'Nothing was changed.',
      ].join('\n'),
    );
    return 0;
  }
  if (date < GO_LIVE) {
    throw new Failure(
      `go-live is refused until ${GO_LIVE}, when PRIVACY.md's sections about staff take effect (today is ${date}). "prepare" can run now.`,
    );
  }

  // Everything that can fail on input first, before anything is deployed.
  checkTools();
  const user = ghGet('user');
  if (!user?.login) throw new Failure('gh is not logged in (gh auth login).');
  const people = owners.map((login) => {
    const found = ghGet(`users/${login}`);
    if (!found || found.type !== 'User' || !Number.isSafeInteger(found.id)) {
      throw new Failure(`${login} is not a GitHub user.`);
    }
    return { login: found.login, ref: `github:${found.id}` };
  });
  if (people.length < 2) {
    console.log('Note: erasing an account needs a second Owner to approve. Add one when you can.');
  }
  const cmsAppId = repositoryVariable('CMS_APP_ID');
  if (!cmsAppId) {
    const membership = ghGet(`user/memberships/orgs/${OWNER}`);
    if (membership?.role !== 'admin' || membership?.state !== 'active') {
      throw new Failure(`${user.login} is not an owner of ${OWNER}. Creating the CMS App for the organization needs one.`);
    }
    cmsEnvironment();
  }

  console.log(`1. Deploying the console to https://${config.hostname}`);
  wrangler(['deploy', '--config', configPath]);

  console.log('2. Its secrets');
  const listed = jsonArray(wrangler(['secret', 'list', '--config', configPath, '--format', 'json'], { capture: true }));
  const present = new Set(listed.map((item) => item.name));
  const secrets = {};
  if (!present.has('SLOTLOCK_ADMIN_SESSION_SECRET')) {
    secrets.SLOTLOCK_ADMIN_SESSION_SECRET = randomBytes(32).toString('hex');
  }
  if (!present.has('SLOTLOCK_ADMIN_GITHUB_CLIENT_ID') || !present.has('SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET')) {
    console.log(
      `   The console's own GitHub OAuth app (GitHub has no API to create one): ${web}/organizations/${OWNER}/settings/applications/new, with the callback https://${config.hostname}/callback.`,
    );
    const clientId = await secret('SLOTLOCK_ADMIN_GITHUB_CLIENT_ID', '   Its Client ID: ');
    const clientSecret = await secret('SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET', '   A client secret of it: ');
    if (!/^[A-Za-z0-9._-]{8,100}$/.test(clientId) || clientSecret.length < 20) {
      throw new Failure("That is not a GitHub OAuth app's client ID and secret. Nothing was set.");
    }
    secrets.SLOTLOCK_ADMIN_GITHUB_CLIENT_ID = clientId;
    secrets.SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET = clientSecret;
  }
  if (!present.has('SLOTLOCK_ADMIN_CONSOLE_KEY')) {
    // Replaces any earlier key and ends every staff session: only when the Worker has none.
    const [printed] = lines(slotlock(['staff', 'console-key'], database, { capture: true }), 'console_key');
    if (typeof printed?.console_key !== 'string' || printed.console_key.length < 32) {
      throw new Failure('slotlock staff console-key printed no key.');
    }
    secrets.SLOTLOCK_ADMIN_CONSOLE_KEY = printed.console_key;
  }
  if (!present.has('SLOTLOCK_ADMIN_STRIPE_KEY')) {
    const stripe = await secret(
      'SLOTLOCK_ADMIN_STRIPE_KEY',
      '   A restricted Stripe key (rk_live_…, Read on Subscriptions and Invoices), or Enter for none: ',
      { optional: true },
    );
    if (stripe && !/^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(stripe)) {
      throw new Failure('A Stripe key for the console must be a restricted key (rk_live_…). Nothing was set.');
    }
    if (stripe) secrets.SLOTLOCK_ADMIN_STRIPE_KEY = stripe;
  }
  if (config.analyticsSite && !present.has('SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN')) {
    const token = await secret(
      'SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN',
      '   A Cloudflare API token with Account Analytics Read and nothing else, for Web Analytics, or Enter for none: ',
      { optional: true },
    );
    if (token && !/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
      throw new Failure('That is not a Cloudflare API token. Nothing was set.');
    }
    if (token) secrets.SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN = token;
  }
  const names = Object.keys(secrets);
  if (names.length > 0) {
    wrangler(['secret', 'bulk', '--config', configPath], { input: JSON.stringify(secrets), capture: true });
  }
  for (const name of Object.keys(secrets)) secrets[name] = '';
  console.log(names.length > 0 ? `   Set ${names.join(', ')}.` : '   Every secret was already set.');

  console.log('3. The Slotlock CMS GitHub App');
  if (cmsAppId) {
    const installation = repositoryVariable('CMS_APP_INSTALLATION') ?? '';
    console.log(`   Kept the CMS App ${cmsAppId} (CMS_APP_ID is set).`);
    if (!present.has('SLOTLOCK_ADMIN_CMS_APP_KEY')) {
      console.log(
        `   The console has no key for it: make a private key in the App's settings and give it with "npx wrangler secret put SLOTLOCK_ADMIN_CMS_APP_KEY --config ${configPath}" (from workers/admin).`,
      );
    }
    if (config.cmsAppId !== cmsAppId || config.cmsInstallation !== installation) {
      writeConfig({ ...config, cmsAppId, cmsInstallation: installation });
      wrangler(['deploy', '--config', configPath]);
    }
  } else {
    const { app, installationId } = await createAppFromManifest({
      owner: OWNER,
      repo: REPO,
      permissions: CMS_PERMISSIONS,
      manifest: cmsAppManifest,
      title: 'Create the Slotlock CMS app',
      agent: 'slotlock-configure-admin-console',
      retry: 'Install it as above and run go-live again (CMS_APP_ID is still unset)',
      open: options.open,
    });
    try {
      console.log(`   Installed on ${OWNER}/${REPO} only, with ${listPermissions(CMS_PERMISSIONS)}.`);
      // The key first, in both places; the variables last, since they turn the scheduled job on.
      wrangler(['secret', 'bulk', '--config', configPath], {
        input: JSON.stringify({ SLOTLOCK_ADMIN_CMS_APP_KEY: app.pem }),
        capture: true,
      });
      ghSet(['secret', 'set', 'CMS_APP_KEY', '--env', CMS_ENVIRONMENT, '--repo', `${OWNER}/${REPO}`], app.pem);
      ghSet(['variable', 'set', 'CMS_APP_ID', '--repo', `${OWNER}/${REPO}`, '--body', String(app.id)]);
      ghSet(['variable', 'set', 'CMS_APP_INSTALLATION', '--repo', `${OWNER}/${REPO}`, '--body', String(installationId)]);
    } finally {
      app.pem = '';
    }
    console.log(`   Stored its key in the Worker and the ${CMS_ENVIRONMENT} environment, and set CMS_APP_ID and CMS_APP_INSTALLATION.`);
    writeConfig({ ...config, cmsAppId: String(app.id), cmsInstallation: String(installationId) });
    wrangler(['deploy', '--config', configPath]);
  }

  console.log('4. The first Owners');
  const staff = lines(slotlock(['staff', 'list'], database, { capture: true }), 'staff_ref');
  const active = new Set(staff.filter((member) => member.status === 'active').map((member) => member.staff_ref));
  const codes = [];
  for (const person of people) {
    if (active.has(person.ref)) {
      console.log(`   ${person.login} is staff already.`);
      continue;
    }
    const [added] = lines(slotlock(['staff', 'add', person.ref, 'owner'], database, { capture: true }), 'enrollment_code');
    if (typeof added?.enrollment_code !== 'string') throw new Failure(`slotlock staff add printed no code for ${person.login}.`);
    codes.push({ login: person.login, code: added.enrollment_code, expires: added.expires_at });
  }

  console.log(`\nThe console is live at https://${config.hostname}.`);
  if (codes.length > 0) {
    console.log(
      'Give each new Owner their one-time code privately. They sign in with GitHub and enter it to make their passkey; it works once:',
    );
    for (const { login, code, expires } of codes) console.log(`  ${login}: ${code} (until ${expires})`);
  }
  console.log(
    [
      'Still yours to do, when you want them:',
      '  - the Site and search page: SLOTLOCK_ADMIN_SEARCH_CONSOLE_KEY and SLOTLOCK_ADMIN_BING_KEY (workers/admin/wrangler.jsonc says what each is);',
      ...(config.analyticsSite
        ? []
        : ['  - Web Analytics on that page: run prepare again with SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE, then go-live for its token;']),
      '  - CMS previews: deploy site/wrangler.preview.jsonc once, and give the site-preview environment its Cloudflare token;',
      '  - record the staff log\'s head now and then (slotlock staff verify-log).',
    ].join('\n'),
  );
  return 0;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(usage());
    return 2;
  }
  return options.command === 'prepare' ? prepare(options) : goLive(options);
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
