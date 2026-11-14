// scripts/deploy-dashboard.mjs against stand-ins for wrangler, for Cloudflare's API and for the live
// dashboard: it deploys and checks the live site; it rolls back to the versions that were live when
// that check fails; and it stops before deploying a configuration that would break the dashboard
// (a var with a secret's name, a missing secret, Hyperdrive caching, values left from the example).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'deploy-dashboard.mjs');
const written = join(root, 'workers', 'dashboard', 'wrangler.deploy.jsonc');
const HYPERDRIVE = '0123456789abcdef0123456789abcdef';
const SECRETS = ['SLOTLOCK_GITHUB_CLIENT_ID', 'SLOTLOCK_GITHUB_CLIENT_SECRET', 'SLOTLOCK_SESSION_SECRET', 'STRIPE_SECRET_KEY'];

// The fake wrangler keeps the deployed versions in a file, as Cloudflare would: `deploy` makes v2 live,
// `versions deploy <spec>` makes those live again.
const wrangler = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'wrangler.log'), args.join(' ') + '\\n');
const live = path.join(dir, 'live.json');
if (!fs.existsSync(live)) fs.writeFileSync(live, JSON.stringify([{ version_id: 'v1-old', percentage: 100 }]));
const config = args[args.indexOf('--config') + 1];
if (!fs.existsSync(path.join(process.cwd(), config))) { console.error('no config ' + config); process.exit(9); }
if (args[0] === 'secret' && args[1] === 'list') {
  console.log(JSON.stringify(JSON.parse(process.env.FAKE_SECRETS).map((name) => ({ name, type: 'secret_text' })), null, '  '));
} else if (args[0] === 'deployments' && args[1] === 'status') {
  console.log(JSON.stringify({ id: 'd', author_email: 'someone@example.test', versions: JSON.parse(fs.readFileSync(live, 'utf8')) }, null, 2));
} else if (args[0] === 'deploy') {
  if (process.env.FAKE_DEPLOY_FAILS) { console.error('✘ [ERROR] A request to the Cloudflare API failed.'); process.exit(1); }
  fs.writeFileSync(live, JSON.stringify([{ version_id: 'v2-new', percentage: 100 }]));
  console.log('Uploaded slotlock-dashboard\\nDeployed slotlock-dashboard triggers\\nCurrent Version ID: v2-new');
} else if (args[0] === 'versions' && args[1] === 'deploy') {
  const specs = args.slice(2, args.indexOf('--yes'));
  fs.writeFileSync(live, JSON.stringify(specs.map((spec) => ({ version_id: spec.split('@')[0], percentage: Number(spec.split('@')[1]) }))));
  console.log('Deployed ' + specs.join(' '));
} else { console.error('unexpected wrangler ' + args.join(' ')); process.exit(99); }
`;

let server: Server;
let base = '';
let fakeDir = '';
/** What the live dashboard answers, by the version that is live. */
let healthyVersions = new Set(['v1-old', 'v2-new']);
let hyperdrive: { status: number; body: unknown } = { status: 200, body: { success: true, result: { id: HYPERDRIVE, caching: { disabled: true } } } };
const scratch: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    if (url.pathname.startsWith('/client/v4/accounts/acct123/hyperdrive/configs/')) {
      if (request.headers.authorization !== 'Bearer cf-test-token') return response.writeHead(403).end('{}');
      return response.writeHead(hyperdrive.status, { 'content-type': 'application/json' }).end(JSON.stringify(hyperdrive.body));
    }
    const live = JSON.parse(readFileSync(join(fakeDir, 'live.json'), 'utf8')) as { version_id: string }[];
    const healthy = live.every((v) => healthyVersions.has(v.version_id));
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      return response.writeHead(200, { 'content-type': 'text/html' }).end('<link rel="stylesheet" href="/style.css?v=abc">');
    }
    if (request.method === 'POST' && url.pathname === '/stripe/webhook') {
      return response.writeHead(healthy ? 400 : 503).end(healthy ? 'No signature.' : 'Billing is not set up.');
    }
    return response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  rmSync(written, { force: true });
});

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'slotlock-deploy-dashboard-'));
  scratch.push(fakeDir);
  writeFileSync(join(fakeDir, 'wrangler'), wrangler, { mode: 0o755 });
  writeFileSync(join(fakeDir, 'live.json'), JSON.stringify([{ version_id: 'v1-old', percentage: 100 }]));
  healthyVersions = new Set(['v1-old', 'v2-new']);
  hyperdrive = { status: 200, body: { success: true, result: { id: HYPERDRIVE, caching: { disabled: true } } } };
});

function config(vars: Record<string, string> = {}, extra = '') {
  return `// The production configuration (a test's).
{
  "name": "slotlock-dashboard",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",${extra}
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${HYPERDRIVE}" }],
  "vars": ${JSON.stringify({ SLOTLOCK_PUBLIC_URL: base, SLOTLOCK_SERVICE_URL: 'https://slotlock-api.test', ...vars })},
}
`;
}

function deploy(text: string, env: Record<string, string> = {}) {
  const output = join(fakeDir, 'output');
  const summary = join(fakeDir, 'summary.md');
  return new Promise<{ status: number | null; output: string; log: string; outputs: string; summary: string }>((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: {
        PATH: process.env.PATH ?? '',
        SLOTLOCK_WRANGLER: join(fakeDir, 'wrangler'),
        FAKE_DIR: fakeDir,
        FAKE_SECRETS: JSON.stringify(SECRETS),
        CLOUDFLARE_API_BASE_URL: `${base}/client/v4`,
        CLOUDFLARE_ACCOUNT_ID: 'acct123',
        CLOUDFLARE_API_TOKEN: 'cf-test-token',
        SLOTLOCK_DASHBOARD_WRANGLER_CONFIG: text,
        SLOTLOCK_DEPLOY_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
        SLOTLOCK_DEPLOY_CHECK_WAIT_MS: '5',
        GITHUB_ACTIONS: 'true',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });
    let text_ = '';
    child.stdout.on('data', (chunk) => (text_ += chunk));
    child.stderr.on('data', (chunk) => (text_ += chunk));
    child.on('close', (status) => {
      const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      resolve({ status, output: text_, log: read(join(fakeDir, 'wrangler.log')), outputs: read(output), summary: read(summary) });
    });
  });
}

describe('scripts/deploy-dashboard.mjs', () => {
  it('deploys, checks the live dashboard, and reports the version it made live', async () => {
    const result = await deploy(config());
    expect(result.status, result.output).toBe(0);
    expect(result.log.trim().split('\n')).toEqual([
      'secret list --format json --config wrangler.deploy.jsonc',
      'deployments status --json --config wrangler.deploy.jsonc',
      'deploy --message main abcdef012345 --config wrangler.deploy.jsonc',
      'deployments status --json --config wrangler.deploy.jsonc',
    ]);
    expect(result.output).toContain('Hyperdrive HYPERDRIVE: caching disabled.');
    expect(result.output).toContain('GET /dashboard 200, unsigned POST /stripe/webhook 400');
    expect(result.outputs).toBe(`url=${base}/dashboard\n`);
    expect(result.summary).toContain('`v2-new@100` (was `v1-old@100`)');
    // The configuration is written where its `main` resolves, and nothing else is printed from it.
    expect(readFileSync(written, 'utf8')).toBe(config());
    expect(result.output).not.toContain('someone@example.test');
  });

  it('rolls back to the versions that were live when the live dashboard fails its check', async () => {
    healthyVersions = new Set(['v1-old']);
    const result = await deploy(config());
    expect(result.status).toBe(1);
    expect(result.log).toContain('versions deploy v1-old@100 --yes --message Rollback: main abcdef012345 failed its live check');
    expect(JSON.parse(readFileSync(join(fakeDir, 'live.json'), 'utf8'))).toEqual([{ version_id: 'v1-old', percentage: 100 }]);
    expect(result.output).toContain('::error title=Dashboard deploy::The live dashboard check failed after deploying abcdef012345');
    expect(result.output).toContain('It was rolled back to v1-old@100, which passes the check.');
    expect(result.summary).toContain('### Dashboard deploy rolled back');
  });

  it('stops before deploying a var that has a secret\'s name, or without a secret the Worker needs', async () => {
    const clash = await deploy(config({ STRIPE_SECRET_KEY_ID: 'x', SLOTLOCK_STRIPE_PRICE_DEVELOPER: 'price_1' }), {
      FAKE_SECRETS: JSON.stringify([...SECRETS, 'SLOTLOCK_STRIPE_PRICE_DEVELOPER']),
    });
    expect(clash.status).toBe(1);
    expect(clash.output).toContain('SLOTLOCK_STRIPE_PRICE_DEVELOPER is both a var in the configuration and a secret');
    expect(clash.log).not.toMatch(/^deploy /m);

    const missing = await deploy(config(), { FAKE_SECRETS: JSON.stringify(['SLOTLOCK_GITHUB_CLIENT_ID']) });
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('has no SLOTLOCK_GITHUB_CLIENT_SECRET, SLOTLOCK_SESSION_SECRET: it would answer 503');
    expect(missing.log).not.toMatch(/^deploy /m);
  });

  it('stops when Hyperdrive caches queries, and warns but deploys when the token cannot read it', async () => {
    hyperdrive = { status: 200, body: { success: true, result: { id: HYPERDRIVE, caching: { disabled: false, max_age: 60 } } } };
    const cached = await deploy(config());
    expect(cached.status).toBe(1);
    expect(cached.output).toContain('The Hyperdrive configuration of HYPERDRIVE caches queries');
    expect(cached.output).toContain(`npx wrangler hyperdrive update ${HYPERDRIVE} --caching-disabled`);
    expect(cached.log).toBe('');

    const unreadable = await deploy(config(), { CLOUDFLARE_API_TOKEN: 'cf-token-without-hyperdrive-read' });
    expect(unreadable.status, unreadable.output).toBe(0);
    expect(unreadable.output).toContain('::warning title=Dashboard deploy::Could not read the Hyperdrive configuration of HYPERDRIVE (403)');
  });

  it('fails the run, and changes nothing live, when wrangler cannot deploy', async () => {
    const result = await deploy(config(), { FAKE_DEPLOY_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('wrangler deploy failed: ✘ [ERROR] A request to the Cloudflare API failed.');
    expect(result.log).not.toContain('versions deploy');
  });

  it.each([
    ['an empty variable', '', 'SLOTLOCK_DASHBOARD_WRANGLER_CONFIG is empty'],
    ['the example', readFileSync(join(root, 'workers', 'dashboard', 'wrangler.jsonc'), 'utf8'), 'still holds values from the example'],
    ['a secret among the vars', null, 'vars SLOTLOCK_SESSION_SECRET is named like a secret'],
    ['a free-plan date', null, 'vars.SLOTLOCK_FREE_PLAN_FROM makes billing answer 503'],
    ['plain http to another host', null, 'vars.SLOTLOCK_PUBLIC_URL must be the dashboard\'s https origin'],
    ['another entry point', null, '"main" must be worker.ts'],
    ['not JSON', '{ "name": ', 'It is not JSON or JSONC'],
  ])('refuses %s before it asks Cloudflare anything', async (name, given, message) => {
    const text =
      given ??
      {
        'a secret among the vars': config({ SLOTLOCK_SESSION_SECRET: 'x'.repeat(40) }),
        'a free-plan date': config({ SLOTLOCK_FREE_PLAN_FROM: '2026-11-16' }),
        'plain http to another host': config({ SLOTLOCK_PUBLIC_URL: 'http://app.slotlock.test' }),
        'another entry point': config().replace('"main": "worker.ts"', '"main": "src/other.ts"'),
      }[name] ??
      '';
    const result = await deploy(text);
    expect(result.status).toBe(1);
    expect(result.output).toContain(message);
    expect(result.log).toBe('');
  });

  it('reads JSONC: comments, trailing commas, and // inside strings', async () => {
    const { parseJsonc, configProblems } = await import('../../scripts/deploy-dashboard.mjs');
    expect(parseJsonc('{ /* a */ "url": "https://a.test/x", // b\n "list": [1, 2,], "q": "say \\"//\\"", }')).toEqual({
      url: 'https://a.test/x',
      list: [1, 2],
      q: 'say "//"',
    });
    expect(configProblems(config())).toEqual([]);
  });
});
