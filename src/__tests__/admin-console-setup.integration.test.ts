// scripts/configure-admin-console.mjs against stand-ins for the Cloudflare API, the GitHub API, gh,
// Wrangler and the slotlock CLI, with a real PostgreSQL for the console's role. Skipped without
// DATABASE_URL.
import { spawn } from 'node:child_process';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL?.trim();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'configure-admin-console.mjs');
const WEB = 'https://github.test';
const ACCOUNT = '0a'.repeat(16);
const SITE_TAG = '5e'.repeat(16);
const ANALYTICS_TOKEN = `cf-analytics-${randomBytes(16).toString('hex')}`;
const TOKEN = 'cf-test-token';
const AUD = 'ab'.repeat(32);
const HOSTNAME = 'admin.slotlock.test';
const CONSOLE_KEY = `ck_${randomBytes(24).toString('base64url')}`;
const CLIENT_SECRET = `gh-oauth-secret-${randomBytes(12).toString('hex')}`;
// The release app, the one GitHub App: what it asks for once its permissions are updated.
const RELEASE_CLIENT_ID = 'Iv23liReleaseTest';
const RELEASE_SLUG = 'pilotaai-slotlock-release';
const PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'read',
};
const RELEASE_ONLY = { contents: 'write', metadata: 'read', pull_requests: 'write' };

const scratch: string[] = [];
const servers: Server[] = [];
const roles: string[] = [];
afterAll(async () => {
  for (const server of servers) server.close();
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
  if (url && roles.length > 0) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    for (const role of roles) await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    await sql.end();
  }
});

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
};

interface CloudflareRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** The stand-in Cloudflare API: Hyperdrive and Access, recording every request and its body. */
async function cloudflareApi(answers: { hyperdriveId?: string } = {}) {
  const requests: CloudflareRequest[] = [];
  const state = {
    hyperdrive: [] as Record<string, unknown>[],
    apps: [] as Record<string, unknown>[],
    policies: [] as Record<string, unknown>[],
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const answer = (status: number, result: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(status < 300 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 10000, message: String(result) }] }));
      };
      const target = new URL(request.url ?? '/', 'http://cf.test');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method: request.method ?? '', path: `${target.pathname}${target.search}`, body });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return answer(403, 'Authentication error');
      const base = `/accounts/${ACCOUNT}`;
      const route = `${request.method} ${target.pathname}`;
      // Hyperdrive never returns the password.
      const shown = (config: Record<string, unknown>) => {
        const { password: _password, ...origin } = config.origin as Record<string, unknown>;
        return { ...config, origin };
      };
      if (route === `GET ${base}/hyperdrive/configs`) return answer(200, state.hyperdrive.map(shown));
      if (route === `POST ${base}/hyperdrive/configs`) {
        const config = { id: answers.hyperdriveId ?? `${state.hyperdrive.length + 1}`.padStart(32, 'd'), ...body };
        state.hyperdrive.push(config);
        return answer(200, shown(config));
      }
      const patched = new RegExp(`^PATCH ${base}/hyperdrive/configs/(\\w+)$`).exec(route);
      if (patched) {
        const config = state.hyperdrive.find((item) => item.id === patched[1]);
        if (!config) return answer(404, 'not found');
        Object.assign(config, {
          ...body,
          origin: { ...(config.origin as object), ...((body?.origin as object) ?? {}) },
        });
        return answer(200, shown(config));
      }
      if (route === `GET ${base}/access/organizations`) return answer(200, { auth_domain: 'slotlock.cloudflareaccess.com' });
      if (route === `GET ${base}/access/apps`) {
        const domain = target.searchParams.get('domain');
        return answer(200, state.apps.filter((app) => !domain || app.domain === domain));
      }
      if (route === `POST ${base}/access/apps`) {
        const app = { id: `app${state.apps.length + 1}`, aud: AUD, ...body };
        state.apps.push(app);
        return answer(200, app);
      }
      if (route === `GET ${base}/access/policies`) return answer(200, state.policies);
      if (route === `POST ${base}/access/policies`) {
        const policy = { id: `pol${state.policies.length + 1}`, ...body };
        state.policies.push(policy);
        return answer(200, policy);
      }
      answer(404, `unexpected ${route}`);
    });
  });
  return { url: await listen(server), requests, state };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface ReleaseApp {
  /** What the app asks for, in its settings. */
  app?: Record<string, string>;
  /** What its installation on slotlock has accepted. */
  installation?: Record<string, string>;
  reach?: 'slotlock' | 'all';
  installed?: boolean;
}

/** The stand-in GitHub API, for the release app as it is: a JWT its key signed, issued by its Client ID. */
async function githubApi(scenario: ReleaseApp = {}) {
  const seen = { minted: [] as string[], revoked: [] as string[], badJwts: 0, jwts: 0 };
  const granted = { ...PERMISSIONS, metadata: 'read' };
  const jwtOk = (authorization: string | undefined) => {
    const [header = '', payload = '', signature = ''] = (/^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '').split('.');
    const verified = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString() || '{}');
    const now = Math.floor(Date.now() / 1000);
    const ok = verified && claims.iss === RELEASE_CLIENT_ID && claims.iat <= now && claims.exp > now && claims.exp - now <= 600;
    seen.jwts += 1;
    if (!ok) seen.badJwts += 1;
    return ok;
  };
  const server = createServer((request, response) => {
    const json = (status: number, body?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? '' : JSON.stringify(body));
    };
    const target = new URL(request.url ?? '/', 'http://api.test');
    const route = `${request.method} ${target.pathname}`;
    if (route === 'GET /app') {
      if (!jwtOk(request.headers.authorization)) return json(401, { message: 'A JSON web token could not be decoded' });
      return json(200, { id: 42, slug: RELEASE_SLUG, client_id: RELEASE_CLIENT_ID, owner: { login: 'PILOTAAI' }, permissions: scenario.app ?? granted });
    }
    if (route === 'GET /repos/PILOTAAI/slotlock/installation') {
      if (!jwtOk(request.headers.authorization)) return json(401, { message: 'Bad credentials' });
      if (scenario.installed === false) return json(404, { message: 'Not Found' });
      return json(200, {
        id: 7777, app_id: 42, app_slug: RELEASE_SLUG, client_id: RELEASE_CLIENT_ID,
        repository_selection: scenario.reach === 'all' ? 'all' : 'selected',
        permissions: scenario.installation ?? scenario.app ?? granted,
      });
    }
    if (route === 'POST /app/installations/7777/access_tokens') {
      if (!jwtOk(request.headers.authorization)) return json(401, { message: 'Bad credentials' });
      const token = `ghs_${seen.minted.length}`;
      seen.minted.push(token);
      return json(201, { token, permissions: scenario.installation ?? scenario.app ?? granted, repository_selection: scenario.reach === 'all' ? 'all' : 'selected' });
    }
    if (route === 'GET /installation/repositories') {
      const all = scenario.reach === 'all';
      return json(200, {
        total_count: all ? 12 : 1,
        repositories: all ? [{ full_name: 'PILOTAAI/slotlock' }, { full_name: 'PILOTAAI/pylota' }] : [{ full_name: 'PILOTAAI/slotlock' }],
      });
    }
    if (route === 'DELETE /installation/token') {
      seen.revoked.push((request.headers.authorization ?? '').replace('Bearer ', ''));
      return json(204);
    }
    json(404, { message: `unexpected ${route}` });
  });
  return { url: await listen(server), seen };
}

// gh: the account, the first Owners, repository variables and the release-app environment's (kept as
// files).
const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB/gh.log"
case "$1 $2" in
  'secret set') cat > "$STUB/gh-secret-$3"; exit 0 ;;
  'variable set')
    name="$3"; shift 3
    while [ $# -gt 0 ]; do if [ "$1" = "--body" ]; then printf '%s' "$2" > "$STUB/var-$name"; fi; shift; done
    exit 0 ;;
esac
for last; do :; done
case "$last" in
  user) echo '{"login":"ada"}' ;;
  user/memberships/orgs/PILOTAAI) echo '{"role":"admin","state":"active"}' ;;
  users/ada) echo '{"login":"ada","id":101,"type":"User"}' ;;
  users/grace) echo '{"login":"grace","id":102,"type":"User"}' ;;
  users/some-bot) echo '{"login":"some-bot","id":103,"type":"Bot"}' ;;
  repos/PILOTAAI/slotlock/actions/variables/*)
    name="\${last##*/}"
    if [ -f "$STUB/var-$name" ]; then printf '{"name":"%s","value":"%s"}\\n' "$name" "$(cat "$STUB/var-$name")"
    else echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi ;;
  repos/PILOTAAI/slotlock/environments/release-app/variables/*)
    name="\${last##*/}"
    if [ -f "$STUB/env-var-$name" ]; then printf '{"name":"%s","value":"%s"}\\n' "$name" "$(cat "$STUB/env-var-$name")"
    else echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi ;;
  *) echo "unexpected: gh $*" >&2; exit 99 ;;
esac
`;

// Wrangler: deploys are copies of the config; secrets are a JSON file, set from stdin.
const wrangler = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const stub = process.env.STUB, args = process.argv.slice(2);
fs.appendFileSync(path.join(stub, 'wrangler.log'), args.join(' ') + '\\n');
const file = path.join(stub, 'worker-secrets.json');
const secrets = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (args[0] === 'deploy') {
  fs.appendFileSync(path.join(stub, 'deploys.log'), fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8') + '\\n=====\\n');
  console.log('Deployed slotlock-admin');
} else if (args[0] === 'secret' && args[1] === 'list') {
  console.log(' wrangler 4.152.0');
  console.log(JSON.stringify(Object.keys(secrets).map((name) => ({ name, type: 'secret_text' }))));
} else if (args[0] === 'secret' && args[1] === 'bulk') {
  Object.assign(secrets, JSON.parse(fs.readFileSync(0, 'utf8')));
  fs.writeFileSync(file, JSON.stringify(secrets));
  console.log('Finished processing secrets');
} else { console.error('unexpected wrangler ' + args.join(' ')); process.exit(99); }
`;

// The slotlock CLI: migrate records what it was given; staff commands keep a JSON file.
const cli = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const stub = process.env.STUB, args = process.argv.slice(2);
fs.appendFileSync(path.join(stub, 'cli.log'), args.join(' ') + '\\n');
const file = path.join(stub, 'staff.json');
const staff = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : JSON.parse(process.env.STUB_STAFF || '[]');
if (args[0] === 'migrate') {
  fs.writeFileSync(path.join(stub, 'migrate-env.json'), JSON.stringify({ admin: process.env.SLOTLOCK_ADMIN_DATABASE_URL, owner: process.env.SLOTLOCK_MIGRATE_DATABASE_URL, serving: process.env.DATABASE_URL }));
  console.log('{"level":"info","event":"admin_role_granted"}');
} else if (args.join(' ') === 'staff console-key') {
  console.log('{"level":"info","event":"connecting"}');
  console.log(JSON.stringify({ console_key: process.env.STUB_CONSOLE_KEY, set_as: 'SLOTLOCK_ADMIN_CONSOLE_KEY' }));
} else if (args[0] === 'staff' && args[1] === 'list') {
  for (const member of staff) console.log(JSON.stringify(member));
} else if (args[0] === 'staff' && args[1] === 'add') {
  staff.push({ staff_ref: args[2], role: args[3], status: 'active' });
  fs.writeFileSync(file, JSON.stringify(staff));
  console.log(JSON.stringify({ staff: args[2], role: args[3], enrollment_code: 'code-for-' + args[2].replace(':', '-'), expires_at: '2026-12-19T00:00:00.000Z' }));
} else { console.error('unexpected slotlock ' + args.join(' ')); process.exit(99); }
`;

interface Setup {
  dir: string;
  stub: string;
  config: string;
  env: Record<string, string>;
  cloudflare: Awaited<ReturnType<typeof cloudflareApi>>;
  read: (name: string) => string | null;
}

async function setup(env: Record<string, string> = {}, answers: { hyperdriveId?: string } = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-admin-setup-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  const stub = join(dir, 'stub');
  for (const path of [bin, stub]) mkdirSync(path);
  writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
  writeFileSync(join(dir, 'wrangler'), wrangler, { mode: 0o755 });
  writeFileSync(join(dir, 'slotlock'), cli, { mode: 0o755 });
  const cloudflare = await cloudflareApi(answers);
  const config = join(dir, 'wrangler.deploy.jsonc');
  const role = `slotlock_admin_t${randomBytes(4).toString('hex')}`;
  roles.push(role);
  return {
    dir,
    stub,
    config,
    cloudflare,
    read: (name) => (existsSync(join(stub, name)) ? readFileSync(join(stub, name), 'utf8') : null),
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STUB: stub,
      SLOTLOCK_CLI: join(dir, 'slotlock'),
      SLOTLOCK_WRANGLER: join(dir, 'wrangler'),
      SLOTLOCK_CLOUDFLARE_API_URL: cloudflare.url,
      SLOTLOCK_ADMIN_CONFIG: config,
      SLOTLOCK_ADMIN_ROLE: role,
      SLOTLOCK_GITHUB_URL: WEB,
      SLOTLOCK_POLL_SECONDS: '0.02',
      SLOTLOCK_WAIT_MINUTES: '0.2',
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      DATABASE_URL: url ?? '',
      SLOTLOCK_MIGRATE_DATABASE_URL: url ?? '',
      SLOTLOCK_ADMIN_HOSTNAME: HOSTNAME,
      SLOTLOCK_ADMIN_ACCESS_EMAILS: 'Ada@Pylota.test, grace@pylota.test, ada@pylota.test',
      SLOTLOCK_ADMIN_DATABASE_HOST: 'db.slotlock.test:6543',
      SLOTLOCK_ADMIN_SITE_PREVIEW_HOST: 'slotlock-site-preview.team.workers.dev',
      STUB_CONSOLE_KEY: CONSOLE_KEY,
      ...env,
    },
  };
}

/** Runs the script without blocking this process, which serves the stand-in APIs. */
function start(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { output: () => output, exit };
}

async function runScript(args: string[], env: Record<string, string>) {
  const run = start(args, env);
  const code = await run.exit;
  return { code, output: run.output() };
}

/** The deploy config prepare would have written, for go-live alone. */
function writePrepared(config: string, cms: { id?: string; installation?: string } = {}, analytics = false) {
  const text = readFileSync(join(root, 'workers', 'admin', 'wrangler.jsonc'), 'utf8')
    .replace('"pattern": "admin.example.com"', `"pattern": "${HOSTNAME}"`)
    .replace('"id": "set-this-to-the-admin-hyperdrive-configuration-id"', `"id": "${'1'.padStart(32, 'd')}"`)
    .replace('"SLOTLOCK_ADMIN_PUBLIC_URL": "https://admin.example.com"', `"SLOTLOCK_ADMIN_PUBLIC_URL": "https://${HOSTNAME}"`)
    .replace('"SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN": "example.cloudflareaccess.com"', '"SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN": "slotlock.cloudflareaccess.com"')
    .replace('"SLOTLOCK_ADMIN_ACCESS_AUD": "set-this-to-the-access-application-aud"', `"SLOTLOCK_ADMIN_ACCESS_AUD": "${AUD}"`)
    .replace('"SLOTLOCK_ADMIN_CMS_APP_ID": ""', `"SLOTLOCK_ADMIN_CMS_APP_ID": "${cms.id ?? ''}"`)
    .replace('"SLOTLOCK_ADMIN_CMS_INSTALLATION": ""', `"SLOTLOCK_ADMIN_CMS_INSTALLATION": "${cms.installation ?? ''}"`)
    .replace('"SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT": ""', `"SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT": "${analytics ? ACCOUNT : ''}"`)
    .replace('"SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE": ""', `"SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE": "${analytics ? SITE_TAG : ''}"`);
  writeFileSync(config, text);
}

describe.skipIf(!url)('configure-admin-console.mjs', () => {
  it('prepares the role, Hyperdrive, Access and the config, and shows the role password only once', async () => {
    const run = await setup();
    const first = await runScript(['prepare'], { ...run.env, SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: SITE_TAG.toUpperCase() });
    expect(first.code, first.output).toBe(0);
    const role = run.env.SLOTLOCK_ADMIN_ROLE as string;

    // The role exists, logs in with the password shown once, and has no power of its own.
    const shown = /shown only now[^\n]*\n\s+(postgres\S+)/.exec(first.output)?.[1] ?? '';
    const roleUrl = new URL(shown);
    const password = decodeURIComponent(roleUrl.password);
    expect(password.length).toBeGreaterThanOrEqual(40);
    expect(first.output.split(password).length - 1).toBe(1);
    const asRole = postgres(shown, { max: 1, onnotice: () => {} });
    const [me] = await asRole<{ current_user: string }[]>`SELECT current_user`;
    await asRole.end();
    expect(me?.current_user).toBe(role);
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [attributes] = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcanlogin: boolean }[]>`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = ${role}`;
    await sql.end();
    expect(attributes).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcanlogin: true });

    // migrate got the role's URL in its environment, never as an argument.
    expect(JSON.parse(run.read('migrate-env.json') ?? '{}')).toEqual({ admin: shown, owner: url, serving: url });
    expect(run.read('cli.log')).toBe('migrate\n');

    // Hyperdrive connects as the role, at the host Cloudflare reaches, caching disabled.
    const posts = run.cloudflare.requests.filter((request) => request.method === 'POST');
    const hyperdrive = posts.find((request) => request.path.endsWith('/hyperdrive/configs'));
    expect(hyperdrive?.body).toEqual({
      name: 'slotlock-admin',
      origin: { scheme: 'postgres', host: 'db.slotlock.test', port: 6543, database: new URL(url as string).pathname.slice(1), user: role, password },
      caching: { disabled: true },
    });
    // Access: a policy with exactly the addresses given, attached to an app for the hostname.
    const policy = posts.find((request) => request.path.endsWith('/access/policies'));
    expect(policy?.body).toMatchObject({
      decision: 'allow',
      include: [{ email: { email: 'ada@pylota.test' } }, { email: { email: 'grace@pylota.test' } }],
    });
    const app = posts.find((request) => request.path.endsWith('/access/apps'));
    expect(app?.body).toMatchObject({ domain: HOSTNAME, type: 'self_hosted', policies: [{ id: 'pol1', precedence: 1 }] });

    // The config has this deployment's values and no placeholder or secret.
    const config = readFileSync(run.config, 'utf8');
    expect(config).toContain(`"pattern": "${HOSTNAME}"`);
    expect(config).toContain(`"id": "${'1'.padStart(32, 'd')}"`);
    expect(config).toContain(`"SLOTLOCK_ADMIN_PUBLIC_URL": "https://${HOSTNAME}"`);
    expect(config).toContain('"SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN": "slotlock.cloudflareaccess.com"');
    expect(config).toContain(`"SLOTLOCK_ADMIN_ACCESS_AUD": "${AUD}"`);
    expect(config).toContain('"SLOTLOCK_ADMIN_PREVIEW_HOST": "slotlock-site-preview.team.workers.dev"');
    // Web Analytics: the site tag given, in the account the console runs in.
    expect(config).toContain(`"SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE": "${SITE_TAG}"`);
    expect(config).toContain(`"SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT": "${ACCOUNT}"`);
    expect(first.output).toContain(`Web Analytics: the site tag ${SITE_TAG}, in the account ${ACCOUNT}. go-live asks for its token.`);
    expect(config).not.toMatch(/set-this|example\.com/);
    expect(config).not.toContain(password);
    expect(run.read('var-SITE_PREVIEW_HOST')).toBe('slotlock-site-preview.team.workers.dev');

    // Again with the role's URL and no site tag: Hyperdrive updated, Access and Web Analytics kept,
    // nothing created, no password shown.
    const before = run.cloudflare.requests.length;
    const second = await runScript(['prepare'], { ...run.env, SLOTLOCK_ADMIN_DATABASE_URL: shown });
    expect(second.code, second.output).toBe(0);
    const again = run.cloudflare.requests.slice(before);
    expect(again.filter((request) => request.method === 'POST')).toEqual([]);
    expect(again.find((request) => request.method === 'PATCH')?.body).toEqual({
      origin: { scheme: 'postgres', database: new URL(url as string).pathname.slice(1), user: role, password },
      caching: { disabled: true },
    });
    expect(second.output).toContain('Kept the Access application already there');
    expect(second.output).not.toContain(password);
    expect(readFileSync(run.config, 'utf8')).toBe(config);

    // Without it, the role that exists is not touched: its password is someone's to keep.
    const third = await runScript(['prepare'], run.env);
    expect(third.code).toBe(1);
    expect(third.output).toContain(`The role ${role} exists already. Set SLOTLOCK_ADMIN_DATABASE_URL`);
  });

  it('changes nothing on --dry-run, and refuses a database only this machine can reach', async () => {
    const run = await setup();
    const role = run.env.SLOTLOCK_ADMIN_ROLE as string;
    const database = new URL(url as string).pathname.slice(1);
    const dry = await runScript(['prepare', '--dry-run'], run.env);
    expect(dry.code, dry.output).toBe(0);
    // It says what a real run would do, as a real run would do it.
    expect(dry.output).toContain(`1. create the role ${role} as the console's database role, with a random password`);
    expect(dry.output).toContain(`If ${role} exists already, it stops instead: set SLOTLOCK_ADMIN_DATABASE_URL`);
    expect(dry.output).toContain(`2. create or update the Hyperdrive configuration slotlock-admin: ${role} at db.slotlock.test:6543, database ${database}, caching disabled`);
    expect(dry.output).toContain(`for ${HOSTNAME}, letting in only:\n       ada@pylota.test\n       grace@pylota.test\n`);
    expect(dry.output).toContain('4. set the repository variable SITE_PREVIEW_HOST to slotlock-site-preview.team.workers.dev');
    expect(dry.output).toContain('without Web Analytics (set SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE to add it)');
    expect(dry.output).toContain('Nothing was changed.');
    const otherAccount = 'b7'.repeat(16);
    const analytics = await runScript(['prepare', '--dry-run'], {
      ...run.env,
      SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: SITE_TAG,
      SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT: otherAccount,
    });
    expect(analytics.code, analytics.output).toBe(0);
    expect(analytics.output).toContain(`with Web Analytics for the site tag ${SITE_TAG} in the account ${otherAccount}\n`);
    expect(run.cloudflare.requests).toEqual([]);
    expect([run.read('gh.log'), run.read('cli.log'), run.read('wrangler.log')]).toEqual([null, null, null]);
    expect(existsSync(run.config)).toBe(false);

    // A role the owner gives is used as it is, under its own name.
    const given = new URL(url as string);
    given.username = 'console_given';
    given.password = 'not-used-on-a-dry-run';
    const named = await runScript(['prepare', '--dry-run'], { ...run.env, SLOTLOCK_ADMIN_DATABASE_URL: given.toString() });
    expect(named.code, named.output).toBe(0);
    expect(named.output).toContain('1. use the role console_given that SLOTLOCK_ADMIN_DATABASE_URL names');
    expect(named.output).not.toContain('not-used-on-a-dry-run');

    // An address only this machine reaches is refused on a dry run too, before anything else.
    for (const args of [['prepare', '--dry-run'], ['prepare']]) {
      const local = await runScript(args, { ...run.env, SLOTLOCK_ADMIN_DATABASE_HOST: '' });
      expect(local.code).toBe(1);
      expect(local.output).toContain('Hyperdrive cannot reach');
    }
    expect(run.cloudflare.requests).toEqual([]);
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const found = await sql`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${run.env.SLOTLOCK_ADMIN_ROLE as string}`;
    await sql.end();
    expect(found).toHaveLength(0);
  });

  it('writes no config from an answer of the wrong shape', async () => {
    // A quote would end the JSON string it goes in; a value of any other shape stops the script.
    const run = await setup({}, { hyperdriveId: 'deadbeef", "injected": "x' });
    const result = await runScript(['prepare'], run.env);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Hyperdrive answered without connecting as|Hyperdrive's configuration id is not what one looks like/);
    expect(existsSync(run.config)).toBe(false);

    const analytics = await setup();
    const quoted = await runScript(['prepare'], { ...analytics.env, SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: `${SITE_TAG}", "x": "` });
    expect(quoted.code).toBe(1);
    expect(quoted.output).toContain('SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE must be the site tag: 32 hex characters.');
    const account = await runScript(['prepare', '--dry-run'], {
      ...analytics.env,
      SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: SITE_TAG,
      SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT: 'acc0123',
    });
    expect(account.code).toBe(1);
    expect(account.output).toContain('The Web Analytics account (SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT, or CLOUDFLARE_ACCOUNT_ID) must be 32 hex characters.');
    expect(analytics.cloudflare.requests).toEqual([]);
    expect(existsSync(analytics.config)).toBe(false);
  });

  it('refuses go-live before 14 November 2026, touching nothing', async () => {
    const run = await setup({ SLOTLOCK_ADMIN_SETUP_TODAY: '2026-11-13', SLOTLOCK_ADMIN_OWNERS: 'ada' });
    writePrepared(run.config);
    const refused = await runScript(['go-live'], run.env);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('go-live is refused until 2026-11-14');
    expect([run.read('gh.log'), run.read('cli.log'), run.read('wrangler.log')]).toEqual([null, null, null]);
    const dry = await runScript(['go-live', '--dry-run'], run.env);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain('go-live is refused until 2026-11-14 (today is 2026-11-13). From then it would:');
    // What to have ready, and what each step does, as a real run would do it.
    expect(dry.output).toContain(`${WEB}/organizations/PILOTAAI/settings/applications/new,\n  with the callback https://${HOSTNAME}/callback.`);
    expect(dry.output).toContain('It answers 503 to everyone until step 2 is done.');
    for (const name of ['SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'CONSOLE_KEY', 'STRIPE_KEY']) {
      expect(dry.output).toContain(`SLOTLOCK_ADMIN_${name} `);
    }
    // No new GitHub App: the release app, with a key of the console's own.
    expect(dry.output).toContain('3. adopt the release app (RELEASE_APP_CLIENT_ID in the release-app environment) for Content, the status page and Deploys:');
    expect(dry.output).toContain('with SLOTLOCK_ADMIN_CMS_APP_KEY_FILE, a private key of the app for the console alone');
    expect(dry.output).not.toContain('Slotlock CMS');
    expect(dry.output).toContain('4. add as Owners those of ada who are not staff yet (each must be a GitHub user)');
    expect(dry.output).toContain('Erasing an account needs a second Owner to approve');
    expect(dry.output).not.toContain('SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN');
    writePrepared(run.config, {}, true);
    const withAnalytics = await runScript(['go-live', '--dry-run'], run.env);
    expect(withAnalytics.code).toBe(0);
    expect(withAnalytics.output).toContain('SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN      a token with Account Analytics Read, for Web Analytics');
    expect([run.read('gh.log'), run.read('cli.log'), run.read('wrangler.log')]).toEqual([null, null, null]);
  });

  it('goes live: deploys, sets the missing secrets on stdin, and adds only new Owners', async () => {
    const run = await setup({
      SLOTLOCK_ADMIN_SETUP_TODAY: '2026-11-14',
      SLOTLOCK_ADMIN_OWNERS: 'ada,grace',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_ID: 'Ov23liConsoleTest',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN: ANALYTICS_TOKEN,
      STUB_STAFF: JSON.stringify([{ staff_ref: 'github:101', role: 'owner', status: 'active' }]),
    });
    writePrepared(run.config, {}, true);
    writeFileSync(join(run.stub, `env-var-RELEASE_APP_CLIENT_ID`), RELEASE_CLIENT_ID);
    const live = await runScript(['go-live'], run.env);
    expect(live.code, live.output).toBe(0);

    const secrets = JSON.parse(run.read('worker-secrets.json') ?? '{}') as Record<string, string>;
    expect(Object.keys(secrets).sort()).toEqual([
      'SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN',
      'SLOTLOCK_ADMIN_CONSOLE_KEY',
      'SLOTLOCK_ADMIN_GITHUB_CLIENT_ID',
      'SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET',
      'SLOTLOCK_ADMIN_SESSION_SECRET',
    ]);
    expect(secrets.SLOTLOCK_ADMIN_CONSOLE_KEY).toBe(CONSOLE_KEY);
    expect(secrets.SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET).toBe(CLIENT_SECRET);
    expect(secrets.SLOTLOCK_ADMIN_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN).toBe(ANALYTICS_TOKEN);
    // No secret in the output or in any command's arguments.
    for (const value of [CONSOLE_KEY, CLIENT_SECRET, ANALYTICS_TOKEN, secrets.SLOTLOCK_ADMIN_SESSION_SECRET as string]) {
      expect(live.output).not.toContain(value);
      expect(`${run.read('wrangler.log')}${run.read('cli.log')}${run.read('gh.log')}`).not.toContain(value);
    }
    // Deployed once: without a key of the release app, the CMS stays off and the config as it was.
    expect(run.read('wrangler.log')).toBe(
      [
        `deploy --config ${run.config}`,
        `secret list --config ${run.config} --format json`,
        `secret bulk --config ${run.config}`,
        '',
      ].join('\n'),
    );
    expect(readFileSync(run.config, 'utf8')).toContain('"SLOTLOCK_ADMIN_CMS_APP_ID": ""');
    // What the owner does for the console's own key, and nothing about a new App.
    expect(live.output).toContain(
      `The console has no key of the release app (client ID ${RELEASE_CLIENT_ID}). As an owner of PILOTAAI, generate a second private key in the app's settings (${WEB}/organizations/PILOTAAI/settings/apps > the app > Private keys > Generate a private key), then run go-live again with SLOTLOCK_ADMIN_CMS_APP_KEY_FILE set to the downloaded file.`,
    );
    expect(live.output).not.toMatch(/Open http|Slotlock CMS/);
    expect(live.output).not.toContain('Web Analytics on that page');
    // ada is staff already; grace is added, and her code is shown for her.
    expect(run.read('cli.log')).toBe('staff console-key\nstaff list\nstaff add github:102 owner\n');
    expect(live.output).toContain('ada is staff already.');
    expect(live.output).toContain('grace: code-for-github-102 (until 2026-12-19T00:00:00.000Z)');

    // Again: every secret is there and both are staff, so nothing is set, rotated or added.
    const again = await runScript(['go-live'], run.env);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('Every secret was already set.');
    expect(run.read('cli.log')).toBe('staff console-key\nstaff list\nstaff add github:102 owner\nstaff list\n');
    expect(JSON.parse(run.read('worker-secrets.json') ?? '{}')).toEqual(secrets);
  });

  it('adopts the release app with a key of the console\'s own, once it has checked the app, and stores the key in the Worker only', async () => {
    const github = await githubApi();
    const keyFile = join(mkdtempSync(join(tmpdir(), 'slotlock-admin-key-')), 'pilotaai-slotlock-release.private-key.pem');
    scratch.push(dirname(keyFile));
    writeFileSync(keyFile, privateKey, { mode: 0o600 });
    const run = await setup({
      SLOTLOCK_ADMIN_SETUP_TODAY: '2026-11-14',
      SLOTLOCK_ADMIN_OWNERS: 'grace',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_ID: 'Ov23liConsoleTest',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      SLOTLOCK_GITHUB_API_URL: github.url,
      SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: keyFile,
    });
    writePrepared(run.config, {}, true);
    writeFileSync(join(run.stub, 'env-var-RELEASE_APP_CLIENT_ID'), RELEASE_CLIENT_ID);
    const live = await runScript(['go-live'], run.env);
    expect(live.code, live.output).toBe(0);

    // Signed in as the app by its Client ID, checked, and every check's token revoked.
    expect(github.seen.jwts).toBeGreaterThanOrEqual(3);
    expect(github.seen.badJwts).toBe(0);
    expect(github.seen.minted.length).toBe(1);
    expect(github.seen.revoked).toEqual(github.seen.minted);
    expect(live.output).toContain(
      `Checked ${RELEASE_SLUG}: installed on PILOTAAI/slotlock only, with actions: read, checks: read, contents: write, issues: write, pull_requests: write and statuses: read.`,
    );
    // The key is in the Worker, and nowhere on GitHub: no new App, no new secret, no cms environment.
    const secrets = JSON.parse(run.read('worker-secrets.json') ?? '{}') as Record<string, string>;
    expect(secrets.SLOTLOCK_ADMIN_CMS_APP_KEY).toBe(privateKey);
    const calls = run.read('gh.log') ?? '';
    expect(calls).not.toMatch(/secret set|variable set CMS|environments\/cms/);
    // The config names the app by its Client ID; the console finds the installation itself. Web
    // Analytics is kept.
    const deploys = (run.read('deploys.log') ?? '').split('=====').filter((text) => text.trim());
    expect(deploys).toHaveLength(2);
    expect(deploys[1]).toContain(`"SLOTLOCK_ADMIN_CMS_APP_ID": "${RELEASE_CLIENT_ID}"`);
    expect(deploys[1]).toContain('"SLOTLOCK_ADMIN_CMS_INSTALLATION": ""');
    expect(deploys[1]).toContain(`"SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE": "${SITE_TAG}"`);
    // The key is never printed nor an argument.
    const keyBody = privateKey.split('\n')[5] ?? '';
    expect(live.output).not.toContain(keyBody);
    expect(`${run.read('wrangler.log')}${calls}`).not.toContain(keyBody);
    expect(live.output).toContain(`delete ${keyFile}`);

    // Again without the file: the Worker's key is kept, and nothing is deployed twice.
    const again = await runScript(['go-live'], { ...run.env, SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: '' });
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('The Worker has its key of the release app.');
    expect((run.read('deploys.log') ?? '').split('=====').filter((text) => text.trim())).toHaveLength(3);
    expect(JSON.parse(run.read('worker-secrets.json') ?? '{}').SLOTLOCK_ADMIN_CMS_APP_KEY).toBe(privateKey);
  });

  it.each([
    [
      'the release app before its permissions were added',
      { app: RELEASE_ONLY },
      [
        `1. Set its permissions: ${WEB}/organizations/PILOTAAI/settings/apps/${RELEASE_SLUG}/permissions > Repository permissions > Actions: Read-only; Checks: Read-only; Issues: Read and write; Commit statuses: Read-only > Save changes.`,
        `2. Then accept them for the installation: ${WEB}/organizations/PILOTAAI/settings/installations/7777 > Review request > Accept new permissions.`,
      ],
    ],
    [
      'permissions the installation has not accepted yet',
      { installation: RELEASE_ONLY },
      [`1. Accept its new permissions for the installation: ${WEB}/organizations/PILOTAAI/settings/installations/7777 > Review request > Accept new permissions.`],
    ],
    [
      'a permission it should not have',
      { app: { ...PERMISSIONS, metadata: 'read', administration: 'write' }, installation: { ...PERMISSIONS, metadata: 'read', administration: 'write' } },
      [`1. Set its permissions: ${WEB}/organizations/PILOTAAI/settings/apps/${RELEASE_SLUG}/permissions > Repository permissions > Administration: No access > Save changes.`],
    ],
    [
      'an installation that reaches every repository',
      { reach: 'all' as const },
      [`1. The installation reaches every repository in PILOTAAI. Limit it to slotlock: ${WEB}/organizations/PILOTAAI/settings/installations/7777 > Only select repositories > slotlock > Save.`],
    ],
    [
      'no installation',
      { installed: false },
      [`1. Install it on slotlock only: ${WEB}/apps/${RELEASE_SLUG}/installations/new (Only select repositories > slotlock > Install).`],
    ],
  ])('refuses %s, deploying and storing nothing, and says what to change on GitHub', async (_, scenario, steps) => {
    const github = await githubApi(scenario);
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-admin-key-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'key.pem'), privateKey, { mode: 0o600 });
    const run = await setup({
      SLOTLOCK_ADMIN_SETUP_TODAY: '2026-11-14',
      SLOTLOCK_ADMIN_OWNERS: 'grace',
      SLOTLOCK_GITHUB_API_URL: github.url,
      SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: join(dir, 'key.pem'),
    });
    writePrepared(run.config);
    writeFileSync(join(run.stub, 'env-var-RELEASE_APP_CLIENT_ID'), RELEASE_CLIENT_ID);
    const refused = await runScript(['go-live'], run.env);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain(`The release app (${RELEASE_SLUG}) cannot serve the console yet: nothing was deployed or stored. As an owner of PILOTAAI:`);
    for (const line of steps) expect(refused.output).toContain(`\n  ${line}\n`);
    expect(refused.output).toContain('Then run go-live again.');
    expect(refused.output.match(/^ {2}\d\. /gm)).toHaveLength(steps.length);
    expect([run.read('wrangler.log'), run.read('cli.log'), run.read('worker-secrets.json')]).toEqual([null, null, null]);
    expect(github.seen.badJwts).toBe(0);
    expect(github.seen.revoked).toEqual(github.seen.minted);
    expect(refused.output).not.toContain(privateKey.split('\n')[5] ?? '');
  });

  it('refuses a key that is not the release app\'s, and a file that holds no key', async () => {
    const github = await githubApi();
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-admin-key-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'other.pem'), other.privateKey, { mode: 0o600 });
    writeFileSync(join(dir, 'notes.txt'), 'not a key', { mode: 0o600 });
    const run = await setup({ SLOTLOCK_ADMIN_SETUP_TODAY: '2026-11-14', SLOTLOCK_ADMIN_OWNERS: 'grace', SLOTLOCK_GITHUB_API_URL: github.url });
    writePrepared(run.config);
    writeFileSync(join(run.stub, 'env-var-RELEASE_APP_CLIENT_ID'), RELEASE_CLIENT_ID);
    const wrongKey = await runScript(['go-live'], { ...run.env, SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: join(dir, 'other.pem') });
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.output).toContain(`GitHub refused the key for the app with client ID ${RELEASE_CLIENT_ID} (HTTP 401)`);
    const notAKey = await runScript(['go-live'], { ...run.env, SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: join(dir, 'notes.txt') });
    expect(notAKey.code).toBe(1);
    expect(notAKey.output).toContain(`${join(dir, 'notes.txt')} is not a private key (.pem) of a GitHub App.`);
    // A key and no release app stored to use it with.
    rmSync(join(run.stub, 'env-var-RELEASE_APP_CLIENT_ID'));
    const noApp = await runScript(['go-live'], { ...run.env, SLOTLOCK_ADMIN_CMS_APP_KEY_FILE: join(dir, 'other.pem') });
    expect(noApp.code).toBe(1);
    expect(noApp.output).toContain('No release app is stored (RELEASE_APP_CLIENT_ID in the release-app environment): an owner of PILOTAAI runs node scripts/create-release-app.mjs first.');
    expect([run.read('wrangler.log'), run.read('worker-secrets.json')]).toEqual([null, null]);
  });
});
