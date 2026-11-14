#!/usr/bin/env node
// Deploys the hosted dashboard Worker (workers/dashboard) for .github/workflows/dashboard-deploy.yml,
// and checks a production Wrangler configuration before configure-github.sh stores it.
//
//   node scripts/deploy-dashboard.mjs              deploy (CI)
//   node scripts/deploy-dashboard.mjs --check FILE check FILE and say what is wrong with it
//
// A deploy:
//   1. checks the configuration (below) and writes it to workers/dashboard/wrangler.deploy.jsonc,
//      where its `main` (worker.ts) resolves;
//   2. asks Cloudflare for each Hyperdrive configuration it binds and stops when one caches queries
//      (a cached sign-out check keeps a copied session working; the docs' "caching disabled");
//      asks for the Worker's secrets (names only) and stops when a configured var has
//      a secret's name, which Cloudflare refuses, or a secret the Worker cannot start without is
//      missing;
//   3. notes the versions now deployed, then runs `wrangler deploy`;
//   4. checks the live dashboard: <SLOTLOCK_PUBLIC_URL>/dashboard answers 200 with the dashboard's
//      stylesheet, and an unsigned POST to /stripe/webhook answers below 500 (Stripe billing set up
//      without its webhook secret, or with a free-plan date, answers 503);
//   5. when that check fails, deploys the noted versions again (`wrangler versions deploy`), checks
//      again, and fails the run either way.
//
// The configuration is checked for: a name; `main` worker.ts; vars.SLOTLOCK_PUBLIC_URL an https
// origin (http on loopback only); nothing left from the example (example.com, "set-this-to"); no var named like a secret
// (…_SECRET, …_SECRETS, …_TOKEN, …_KEY, …_PASSWORD), since vars are plain text in Cloudflare's
// dashboard and in the deploy log; and no SLOTLOCK_FREE_PLAN_FROM, which makes billing answer 503.
//
// Environment:
//   SLOTLOCK_DASHBOARD_WRANGLER_CONFIG  the production configuration, JSON or JSONC (the dashboard
//                                       environment's variable)
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//                                       read by Wrangler
//   SLOTLOCK_DEPLOY_SHA                 the commit deployed, named in the version's message
//   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY  set by Actions: the dashboard URL, and a summary
// For tests: SLOTLOCK_WRANGLER (a stand-in for wrangler), CLOUDFLARE_API_BASE_URL (as for
// check-cloudflare-credentials.sh) and SLOTLOCK_DEPLOY_CHECK_WAIT_MS (the pause between checks of the
// live dashboard).
//
// Hyperdrive: GET /accounts/{account_id}/hyperdrive/configs/{hyperdrive_id}, whose result carries
// caching.disabled (https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/
// methods/get/), as scripts/configure-admin-console.mjs reads it. A token without Hyperdrive Read
// cannot see it; the deploy then warns and goes on.
// Wrangler's commands and flags were read from wrangler 4.152.0 (`--help`, and wrangler-dist/cli.js
// for what each prints with --json or --format json) on 2026-11-14.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = join(root, 'workers', 'dashboard');
const CONFIG_FILE = 'wrangler.deploy.jsonc';
const wranglerCommand = process.env.SLOTLOCK_WRANGLER
  ? [process.env.SLOTLOCK_WRANGLER]
  : [join(workerDir, 'node_modules', '.bin', 'wrangler')];
const WAIT_MS = Number(process.env.SLOTLOCK_DEPLOY_CHECK_WAIT_MS ?? 10_000);
const CHECKS = 6;
/** The Worker answers 503 without these (wrangler.jsonc, "Before the first deploy"). */
const REQUIRED_SECRETS = ['SLOTLOCK_GITHUB_CLIENT_ID', 'SLOTLOCK_GITHUB_CLIENT_SECRET', 'SLOTLOCK_SESSION_SECRET'];
const SECRET_NAME = /(_SECRETS?|_TOKEN|_KEY|_PASSWORD)$/;

class Failure extends Error {}

/** JSONC to a value: comments and trailing commas removed outside strings, then JSON.parse. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('a /* comment is never closed');
      i = end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** What is wrong with a production configuration, as sentences; empty when nothing is. */
export function configProblems(text) {
  let config;
  try {
    config = parseJsonc(text);
  } catch (error) {
    return [`It is not JSON or JSONC: ${error.message}.`];
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['It is not a JSON object.'];
  const problems = [];
  if (typeof config.name !== 'string' || !config.name) problems.push('It has no "name" (the Worker\'s name).');
  if (config.main !== undefined && config.main !== 'worker.ts' && config.main !== './worker.ts') {
    problems.push('"main" must be worker.ts: the deploy writes the configuration into workers/dashboard.');
  }
  const vars = config.vars && typeof config.vars === 'object' ? config.vars : {};
  let publicUrl;
  try {
    publicUrl = new URL(vars.SLOTLOCK_PUBLIC_URL);
  } catch {
    publicUrl = undefined;
  }
  // http only on loopback, as readServerUrl allows (src/config.ts): a local check of this script.
  const loopback = publicUrl && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (!publicUrl || !(publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && loopback))) {
    problems.push('vars.SLOTLOCK_PUBLIC_URL must be the dashboard\'s https origin.');
  }
  const flat = JSON.stringify(config);
  if (/example\.com|set-this-to/.test(flat)) {
    problems.push('It still holds values from the example (example.com or "set-this-to…"): replace what wrangler.jsonc marks as yours.');
  }
  const secretLike = Object.keys(vars).filter((name) => SECRET_NAME.test(name));
  if (secretLike.length) {
    problems.push(
      `vars ${secretLike.join(', ')} ${secretLike.length === 1 ? 'is' : 'are'} named like a secret: vars are plain text in ` +
        'Cloudflare\'s dashboard and in the deploy log. Store a secret with `wrangler secret put` and remove it from vars.',
    );
  }
  if ('SLOTLOCK_FREE_PLAN_FROM' in vars) {
    problems.push('vars.SLOTLOCK_FREE_PLAN_FROM makes billing answer 503: remove it.');
  }
  return problems;
}

function publicUrlOf(text) {
  const url = parseJsonc(text).vars.SLOTLOCK_PUBLIC_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

function wrangler(args, { capture = true } = {}) {
  const [file, ...prefix] = wranglerCommand;
  const result = spawnSync(file, [...prefix, ...args, '--config', CONFIG_FILE], {
    cwd: workerDir,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Failure(`could not run wrangler: ${result.error.message}`);
  if (!capture && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const reason = (result.stderr ?? '').trim().split('\n').slice(-4).join(' ').slice(0, 800);
    const command = args.slice(0, 2).filter((arg) => !arg.startsWith('-')).join(' ');
    throw new Failure(`wrangler ${command} failed${reason ? `: ${reason}` : ''}`);
  }
  return result.stdout ?? '';
}

/** The JSON value in a command's output: from its first `open` character to its last `close`. */
function jsonIn(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) throw new Failure('wrangler printed no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** The versions serving now, as `wrangler versions deploy` specs ("<id>@<percentage>"). */
function deployedVersions() {
  const deployment = jsonIn(wrangler(['deployments', 'status', '--json']), '{', '}');
  return (deployment.versions ?? []).map((v) => `${v.version_id}@${v.percentage}`);
}

/** Stops when a Hyperdrive configuration the Worker binds caches queries. */
async function checkHyperdrive(config) {
  const api = process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4';
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  for (const binding of Array.isArray(config.hyperdrive) ? config.hyperdrive : []) {
    let answer;
    try {
      const response = await fetch(`${api}/accounts/${encodeURIComponent(account)}/hyperdrive/configs/${encodeURIComponent(binding.id)}`, {
        headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(20_000),
      });
      answer = { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
      answer = { status: 0, body: null, error: error.cause?.code ?? error.message };
    }
    if (answer.status !== 200 || answer.body?.success !== true) {
      warn(
        `Could not read the Hyperdrive configuration of ${binding.binding} (${answer.status || answer.error}), so its ` +
          'caching was not checked. Give the token Hyperdrive Read to have every deploy check it.',
      );
      continue;
    }
    if (answer.body.result?.caching?.disabled !== true) {
      throw new Failure(
        `The Hyperdrive configuration of ${binding.binding} caches queries: a cached sign-out check keeps a copied ` +
          `session working. Disable its caching (npx wrangler hyperdrive update ${binding.id} --caching-disabled) and deploy again.`,
      );
    }
    console.log(`Hyperdrive ${binding.binding}: caching disabled.`);
  }
}

async function status(url, init) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    return { code: response.status, body: await response.text() };
  } catch (error) {
    return { code: 0, body: '', error: error.cause?.code ?? error.message };
  }
}

/** Checks the live dashboard up to CHECKS times; resolves to the last result. */
async function checkLive(base) {
  let last;
  for (let attempt = 1; attempt <= CHECKS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    const page = await status(new URL('dashboard', base));
    const webhook = await status(new URL('stripe/webhook', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const pageOk = page.code === 200 && page.body.includes('/style.css?v=');
    const webhookOk = webhook.code > 0 && webhook.code < 500;
    last = {
      ok: pageOk && webhookOk,
      text:
        `GET /dashboard ${page.code || page.error}${page.code === 200 && !pageOk ? ' (not the dashboard page)' : ''}, ` +
        `unsigned POST /stripe/webhook ${webhook.code || webhook.error}`,
    };
    console.log(`check ${attempt} of ${CHECKS}: ${last.text}`);
    if (last.ok) return last;
  }
  return last;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function warn(message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Dashboard deploy::${message.replace(/\n/g, ' ')}`);
  else console.error(`warning: ${message}`);
}

function fail(message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Dashboard deploy::${message.replace(/\n/g, ' ')}`);
  else console.error(`error: ${message}`);
  process.exitCode = 1;
}

async function deploy() {
  const text = process.env.SLOTLOCK_DASHBOARD_WRANGLER_CONFIG ?? '';
  if (!text.trim()) {
    throw new Failure(
      'SLOTLOCK_DASHBOARD_WRANGLER_CONFIG is empty: store the production configuration with ' +
        'scripts/configure-github.sh --dashboard-deploy <file>.',
    );
  }
  const problems = configProblems(text);
  if (problems.length) throw new Failure(`SLOTLOCK_DASHBOARD_WRANGLER_CONFIG: ${problems.join(' ')}`);
  writeFileSync(join(workerDir, CONFIG_FILE), text, { mode: 0o600 });
  const config = parseJsonc(text);
  const base = publicUrlOf(text);
  output('url', new URL('dashboard', base).href);

  await checkHyperdrive(config);
  const secrets = jsonIn(wrangler(['secret', 'list', '--format', 'json']), '[', ']').map((s) => s.name);
  const clash = Object.keys(config.vars ?? {}).filter((name) => secrets.includes(name));
  if (clash.length) {
    throw new Failure(
      `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} both a var in the configuration and a secret on the ` +
        `Worker ${config.name}, which Cloudflare refuses. Remove ${clash.length === 1 ? 'it' : 'them'} from vars ` +
        '(scripts/configure-stripe.mjs stores the Stripe values as secrets) and store the configuration again.',
    );
  }
  const missing = REQUIRED_SECRETS.filter((name) => !secrets.includes(name));
  if (missing.length) throw new Failure(`The Worker ${config.name} has no ${missing.join(', ')}: it would answer 503.`);

  const before = deployedVersions();
  const sha = process.env.SLOTLOCK_DEPLOY_SHA ?? '';
  wrangler(['deploy', '--message', `main ${sha.slice(0, 12)}`.trim()], { capture: false });
  const after = deployedVersions();
  const live = await checkLive(base);
  if (live.ok) {
    console.log(`The dashboard is live at ${new URL('dashboard', base).href}: ${live.text}.`);
    summary([
      `### Dashboard deployed`,
      '',
      `- Commit: \`${sha || 'unknown'}\``,
      `- Version: \`${after.join(', ')}\` (was \`${before.join(', ') || 'none'}\`)`,
      `- Live check: ${live.text}`,
    ]);
    return;
  }
  if (!before.length) throw new Failure(`The live dashboard check failed (${live.text}) and there is no earlier version to go back to.`);
  console.log(`The live dashboard check failed (${live.text}). Deploying ${before.join(' ')} again.`);
  wrangler(['versions', 'deploy', ...before, '--yes', '--message', `Rollback: main ${sha.slice(0, 12)} failed its live check`], {
    capture: false,
  });
  const again = await checkLive(base);
  summary([
    `### Dashboard deploy rolled back`,
    '',
    `- Commit: \`${sha || 'unknown'}\` failed its live check: ${live.text}`,
    `- Back on \`${before.join(', ')}\`: ${again.ok ? 'it passes' : 'it fails too'} (${again.text})`,
  ]);
  throw new Failure(
    `The live dashboard check failed after deploying ${sha.slice(0, 12) || 'this commit'} (${live.text}). ` +
      `It was rolled back to ${before.join(', ')}, which ${again.ok ? 'passes the check' : `fails it too (${again.text})`}.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    if (!args[1]) throw new Failure('usage: node scripts/deploy-dashboard.mjs --check <wrangler configuration>');
    const problems = configProblems(readFileSync(args[1], 'utf8'));
    if (problems.length) throw new Failure(`${args[1]}: ${problems.join(' ')}`);
    console.log(`${args[1]} looks like a production configuration for the dashboard Worker.`);
    return;
  }
  if (args.length) throw new Failure(`unexpected ${args.join(' ')}`);
  await deploy();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    if (error instanceof Failure) fail(error.message);
    else {
      fail(error.stack ?? String(error));
    }
  });
}
