// scripts/configure-admin-console.mjs against stand-ins for the Cloudflare API, the GitHub API, gh,
// Wrangler and the slotlock CLI, with a real PostgreSQL for the console's role. Skipped without
// DATABASE_URL.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
const ACCOUNT = 'acc0123';
const TOKEN = 'cf-test-token';
const AUD = 'ab'.repeat(32);
const HOSTNAME = 'admin.slotlock.test';
const CONSOLE_KEY = `ck_${randomBytes(24).toString('base64url')}`;
const CLIENT_SECRET = `gh-oauth-secret-${randomBytes(12).toString('hex')}`;
const CMS_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'read',
};

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

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** The stand-in GitHub API, for the CMS App's manifest flow. */
async function githubApi() {
  const seen = { conversions: 0, minted: [] as string[], revoked: [] as string[] };
  const server = createServer((request, response) => {
    const json = (status: number, body?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? '' : JSON.stringify(body));
    };
    const target = new URL(request.url ?? '/', 'http://api.test');
    const route = `${request.method} ${target.pathname}`;
    if (route === 'POST /app-manifests/the-code/conversions') {
      seen.conversions += 1;
      return json(201, {
        id: 4242,
        slug: 'pilotaai-slotlock-cms',
        client_id: 'Iv23liCmsTest',
        pem: privateKey,
        owner: { login: 'PILOTAAI' },
        permissions: { ...CMS_PERMISSIONS, metadata: 'read' },
      });
    }
    if (route === 'GET /repos/PILOTAAI/slotlock/installation') return json(200, { id: 7777 });
    if (route === 'POST /app/installations/7777/access_tokens') {
      const token = `ghs_${seen.minted.length}`;
      seen.minted.push(token);
      return json(201, { token, permissions: { ...CMS_PERMISSIONS, metadata: 'read' }, repository_selection: 'selected' });
    }
    if (route === 'GET /installation/repositories') {
      return json(200, { total_count: 1, repositories: [{ full_name: 'PILOTAAI/slotlock' }] });
    }
    if (route === 'DELETE /installation/token') {
      seen.revoked.push((request.headers.authorization ?? '').replace('Bearer ', ''));
      return json(204);
    }
    json(404, { message: `unexpected ${route}` });
  });
  return { url: await listen(server), seen };
}

// gh: the account, the first Owners, the cms environment and repository variables (kept as files).
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
  repos/PILOTAAI/slotlock/environments/cms) echo '{"name":"cms","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' ;;
  repos/PILOTAAI/slotlock/environments/cms/deployment-branch-policies) echo '{"branch_policies":[{"name":"main","type":"branch"}]}' ;;
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
function writePrepared(config: string, cms: { id?: string; installation?: string } = {}) {
  const text = readFileSync(join(root, 'workers', 'admin', 'wrangler.jsonc'), 'utf8')
    .replace('"pattern": "admin.example.com"', `"pattern": "${HOSTNAME}"`)
    .replace('"id": "set-this-to-the-admin-hyperdrive-configuration-id"', `"id": "${'1'.padStart(32, 'd')}"`)
    .replace('"SLOTLOCK_ADMIN_PUBLIC_URL": "https://admin.example.com"', `"SLOTLOCK_ADMIN_PUBLIC_URL": "https://${HOSTNAME}"`)
    .replace('"SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN": "example.cloudflareaccess.com"', '"SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN": "slotlock.cloudflareaccess.com"')
    .replace('"SLOTLOCK_ADMIN_ACCESS_AUD": "set-this-to-the-access-application-aud"', `"SLOTLOCK_ADMIN_ACCESS_AUD": "${AUD}"`)
    .replace('"SLOTLOCK_ADMIN_CMS_APP_ID": ""', `"SLOTLOCK_ADMIN_CMS_APP_ID": "${cms.id ?? ''}"`)
    .replace('"SLOTLOCK_ADMIN_CMS_INSTALLATION": ""', `"SLOTLOCK_ADMIN_CMS_INSTALLATION": "${cms.installation ?? ''}"`);
  writeFileSync(config, text);
}

describe.skipIf(!url)('configure-admin-console.mjs', () => {
  it('prepares the role, Hyperdrive, Access and the config, and shows the role password only once', async () => {
    const run = await setup();
    const first = await runScript(['prepare'], run.env);
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
    expect(config).not.toMatch(/set-this|example\.com/);
    expect(config).not.toContain(password);
    expect(run.read('var-SITE_PREVIEW_HOST')).toBe('slotlock-site-preview.team.workers.dev');

    // Again with the role's URL: Hyperdrive updated, Access kept, nothing created, no password shown.
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
    const dry = await runScript(['prepare', '--dry-run'], run.env);
    expect(dry.code, dry.output).toBe(0);
    expect(dry.output).toContain('prepare would:');
    expect(dry.output).toContain('Nothing was changed.');
    expect(run.cloudflare.requests).toEqual([]);
    expect([run.read('gh.log'), run.read('cli.log'), run.read('wrangler.log')]).toEqual([null, null, null]);
    expect(existsSync(run.config)).toBe(false);

    const local = await runScript(['prepare'], { ...run.env, SLOTLOCK_ADMIN_DATABASE_HOST: '' });
    expect(local.code).toBe(1);
    expect(local.output).toContain('Hyperdrive cannot reach');
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
  });

  it('refuses go-live before 12 December 2026, touching nothing', async () => {
    const run = await setup({ SLOTLOCK_ADMIN_SETUP_TODAY: '2026-12-11', SLOTLOCK_ADMIN_OWNERS: 'ada' });
    writePrepared(run.config);
    const refused = await runScript(['go-live'], run.env);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('go-live is refused until 2026-12-12');
    expect([run.read('gh.log'), run.read('cli.log'), run.read('wrangler.log')]).toEqual([null, null, null]);
    const dry = await runScript(['go-live', '--dry-run'], run.env);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain('go-live is refused until 2026-12-12 (today is 2026-12-11). From then it would:');
  });

  it('goes live: deploys, sets the missing secrets on stdin, and adds only new Owners', async () => {
    const run = await setup({
      SLOTLOCK_ADMIN_SETUP_TODAY: '2026-12-12',
      SLOTLOCK_ADMIN_OWNERS: 'ada,grace',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_ID: 'Ov23liConsoleTest',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      STUB_STAFF: JSON.stringify([{ staff_ref: 'github:101', role: 'owner', status: 'active' }]),
    });
    writePrepared(run.config);
    writeFileSync(join(run.stub, 'var-CMS_APP_ID'), '4242');
    writeFileSync(join(run.stub, 'var-CMS_APP_INSTALLATION'), '7777');
    const live = await runScript(['go-live'], run.env);
    expect(live.code, live.output).toBe(0);

    const secrets = JSON.parse(run.read('worker-secrets.json') ?? '{}') as Record<string, string>;
    expect(Object.keys(secrets).sort()).toEqual([
      'SLOTLOCK_ADMIN_CONSOLE_KEY',
      'SLOTLOCK_ADMIN_GITHUB_CLIENT_ID',
      'SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET',
      'SLOTLOCK_ADMIN_SESSION_SECRET',
    ]);
    expect(secrets.SLOTLOCK_ADMIN_CONSOLE_KEY).toBe(CONSOLE_KEY);
    expect(secrets.SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET).toBe(CLIENT_SECRET);
    expect(secrets.SLOTLOCK_ADMIN_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    // No secret in the output or in any command's arguments.
    for (const value of [CONSOLE_KEY, CLIENT_SECRET, secrets.SLOTLOCK_ADMIN_SESSION_SECRET as string]) {
      expect(live.output).not.toContain(value);
      expect(`${run.read('wrangler.log')}${run.read('cli.log')}${run.read('gh.log')}`).not.toContain(value);
    }
    // Deployed, with the CMS App's ids put in the config and deployed again.
    expect(run.read('wrangler.log')).toBe(
      [
        `deploy --config ${run.config}`,
        `secret list --config ${run.config} --format json`,
        `secret bulk --config ${run.config}`,
        `deploy --config ${run.config}`,
        '',
      ].join('\n'),
    );
    expect(readFileSync(run.config, 'utf8')).toContain('"SLOTLOCK_ADMIN_CMS_APP_ID": "4242"');
    expect(live.output).toContain('The console has no key for it');
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

  it('creates the CMS App, and stores its key in the Worker and the cms environment only', async () => {
    const github = await githubApi();
    const run = await setup({
      SLOTLOCK_ADMIN_SETUP_TODAY: '2026-12-12',
      SLOTLOCK_ADMIN_OWNERS: 'grace',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_ID: 'Ov23liConsoleTest',
      SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      SLOTLOCK_GITHUB_API_URL: github.url,
    });
    writePrepared(run.config);
    const live = start(['go-live', '--no-open'], run.env);
    let base = '';
    for (let tries = 0; tries < 200 && !base; tries += 1) {
      base = /Open (http:\/\/127\.0\.0\.1:\d+)\//.exec(live.output())?.[1] ?? '';
      if (!base) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(base, live.output()).not.toBe('');
    const page = await (await fetch(`${base}/`)).text();
    const decode = (text: string) =>
      text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const manifest = JSON.parse(decode(/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? '{}'));
    expect(manifest).toMatchObject({ name: 'PILOTAAI Slotlock CMS', public: false, default_permissions: CMS_PERMISSIONS, default_events: [] });
    const state = new URL(decode(/<form method="post" action="([^"]+)"/.exec(page)?.[1] ?? '')).searchParams.get('state');
    const back = await fetch(`${base}/created?code=the-code&state=${state}`, { redirect: 'manual' });
    expect(back.status).toBe(302);
    expect(await live.exit, live.output()).toBe(0);

    const secrets = JSON.parse(run.read('worker-secrets.json') ?? '{}') as Record<string, string>;
    expect(secrets.SLOTLOCK_ADMIN_CMS_APP_KEY).toBe(privateKey);
    expect(run.read('gh-secret-CMS_APP_KEY')).toBe(privateKey);
    expect([run.read('var-CMS_APP_ID'), run.read('var-CMS_APP_INSTALLATION')]).toEqual(['4242', '7777']);
    const calls = run.read('gh.log') ?? '';
    expect(calls.indexOf('secret set CMS_APP_KEY --env cms')).toBeLessThan(calls.indexOf('variable set CMS_APP_ID'));
    // Deployed again with the App's ids; its key is never printed nor an argument.
    const deploys = (run.read('deploys.log') ?? '').split('=====').filter((text) => text.trim());
    expect(deploys).toHaveLength(2);
    expect(deploys[1]).toContain('"SLOTLOCK_ADMIN_CMS_APP_ID": "4242"');
    expect(deploys[1]).toContain('"SLOTLOCK_ADMIN_CMS_INSTALLATION": "7777"');
    const keyBody = privateKey.split('\n')[5] ?? '';
    expect(live.output()).not.toContain(keyBody);
    expect(`${run.read('wrangler.log')}${calls}`).not.toContain(keyBody);
    expect(github.seen.revoked).toEqual(github.seen.minted);
  });
});
