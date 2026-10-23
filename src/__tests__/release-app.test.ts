// scripts/create-release-app.mjs, driven as a browser would drive it, against a stand-in for the
// GitHub API that checks the app's JWTs with a real key pair, and a stand-in for gh that records what
// it is asked to store.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'create-release-app.mjs');
const scratch: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const server of servers) server.close();
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CLIENT_ID = 'Iv23liSlotlockTest';
const SLUG = 'pilotaai-slotlock-release';
const WEB = 'https://github.test';
const GRANTED = { contents: 'write', metadata: 'read', pull_requests: 'write' };

interface Scenario {
  owner?: string;
  permissions?: Record<string, string>;
  /** Installation lookups that answer 404 before the app is installed. */
  installAfter?: number;
  /** What each successive installation check sees: every repository, two, or only slotlock. */
  reach?: Array<'all' | 'two' | 'slotlock'>;
}

/** The stand-in GitHub API. It records every request and the tokens it minted and saw revoked. */
async function githubApi(scenario: Scenario) {
  const seen = { conversions: 0, lookups: 0, minted: [] as string[], revoked: [] as string[] };
  const badJwts: string[] = [];
  const jwtOk = (authorization: string | undefined) => {
    const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
    const [header = '', payload = '', signature = ''] = token.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    const head = JSON.parse(Buffer.from(header, 'base64url').toString() || '{}');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString() || '{}');
    const now = Math.floor(Date.now() / 1000);
    const ok =
      verified &&
      head.alg === 'RS256' &&
      claims.iss === CLIENT_ID &&
      claims.iat <= now &&
      claims.exp > now &&
      claims.exp - now <= 600;
    if (!ok) badJwts.push(token);
    return ok;
  };
  const reachAt = (index: number) => {
    const reach = scenario.reach ?? ['slotlock'];
    return reach[Math.min(index, reach.length - 1)] ?? 'slotlock';
  };
  const server = createServer((request, response) => {
    const json = (status: number, body?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? '' : JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://api.test');
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /app-manifests/the-code/conversions') {
      seen.conversions += 1;
      json(201, {
        id: 42,
        slug: SLUG,
        node_id: 'A_1',
        client_id: CLIENT_ID,
        client_secret: 'not-used',
        webhook_secret: null,
        pem: privateKey,
        owner: { login: scenario.owner ?? 'PILOTAAI' },
        permissions: scenario.permissions ?? GRANTED,
        events: [],
      });
    } else if (route.startsWith('POST /app-manifests/')) {
      json(404, { message: 'Not Found' });
    } else if (route === 'GET /repos/PILOTAAI/slotlock/installation') {
      if (!jwtOk(request.headers.authorization)) return json(401, { message: 'Bad JWT' });
      seen.lookups += 1;
      if (seen.lookups <= (scenario.installAfter ?? 0)) return json(404, { message: 'Not Found' });
      json(200, { id: 77, app_slug: SLUG });
    } else if (route === 'POST /app/installations/77/access_tokens') {
      if (!jwtOk(request.headers.authorization)) return json(401, { message: 'Bad JWT' });
      const token = `ghs_${seen.minted.length}`;
      const reach = reachAt(seen.minted.length);
      seen.minted.push(token);
      json(201, {
        token,
        expires_at: '2099-01-01T00:00:00Z',
        permissions: GRANTED,
        repository_selection: reach === 'all' ? 'all' : 'selected',
      });
    } else if (route === 'GET /installation/repositories') {
      const token = /^Bearer (ghs_\d+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (!token || seen.revoked.includes(token)) return json(401, { message: 'Bad token' });
      const reach = reachAt(seen.minted.indexOf(token));
      const repositories =
        reach === 'slotlock'
          ? [{ full_name: 'PILOTAAI/slotlock' }]
          : [{ full_name: 'PILOTAAI/slotlock' }, { full_name: 'PILOTAAI/pylota' }];
      json(200, {
        total_count: reach === 'all' ? 12 : repositories.length,
        repository_selection: reach === 'all' ? 'all' : 'selected',
        repositories,
      });
    } else if (route === 'DELETE /installation/token') {
      const token = /^Bearer (ghs_\d+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (token) seen.revoked.push(token);
      json(204);
    } else {
      json(404, { message: `unexpected ${route}` });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen, badJwts };
}

// The stand-in for gh: GitHub's answers about the account and the release-app environment, and a
// record of what it is asked to store (the secret's value arrives on stdin).
const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG/gh.log"
case "$1 $2" in
  'secret set') cat > "$STUB_LOG/secret"; exit 0 ;;
  'variable set') printf '%s' "$*" > "$STUB_LOG/variable"; exit 0 ;;
esac
for last; do :; done
case "$last" in
  user) echo '{"login":"ada"}' ;;
  user/memberships/orgs/PILOTAAI) echo "{\\"role\\":\\"$STUB_ROLE\\",\\"state\\":\\"active\\"}" ;;
  repos/PILOTAAI/slotlock/environments/release-app)
    if [ -n "$STUB_ENVIRONMENT" ] || [ -f "$STUB_LOG/configured" ]; then
      echo '{"name":"release-app","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
    else
      echo 'gh: Not Found (HTTP 404)' >&2; exit 1
    fi ;;
  repos/PILOTAAI/slotlock/environments/release-app/deployment-branch-policies)
    printf '%s\\n' "$STUB_BRANCH_POLICIES" ;;
  repos/PILOTAAI/slotlock/environments/release-app/variables/RELEASE_APP_CLIENT_ID)
    if [ -n "$STUB_STORED" ]; then
      echo "{\\"name\\":\\"RELEASE_APP_CLIENT_ID\\",\\"value\\":\\"$STUB_STORED\\"}"
    else
      echo 'gh: Not Found (HTTP 404)' >&2; exit 1
    fi ;;
  *) echo "unexpected: gh $*" >&2; exit 99 ;;
esac
`;

interface Run {
  dir: string;
  log: string;
  api: Awaited<ReturnType<typeof githubApi>>;
  output: () => string;
  /** The local page's address, once the script prints it. */
  base: () => Promise<string>;
  exit: Promise<number | null>;
}

async function start(
  scenario: Scenario = {},
  options: { args?: string[]; env?: Record<string, string>; waitMinutes?: string } = {},
): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-release-app-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  for (const path of [bin, log]) mkdirSync(path);
  writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
  // Stands in for scripts/configure-github.sh: it creates the environment.
  const configure = join(dir, 'configure.sh');
  writeFileSync(configure, '#!/bin/sh\ntouch "$STUB_LOG/configured"\n', { mode: 0o755 });
  const api = await githubApi(scenario);
  const child = spawn(process.execPath, [script, '--no-open', ...(options.args ?? [])], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SLOTLOCK_GITHUB_URL: WEB,
      SLOTLOCK_GITHUB_API_URL: api.url,
      SLOTLOCK_POLL_SECONDS: '0.02',
      SLOTLOCK_WAIT_MINUTES: options.waitMinutes ?? '0.1',
      SLOTLOCK_CONFIGURE_GITHUB: configure,
      STUB_LOG: log,
      STUB_ROLE: 'admin',
      STUB_ENVIRONMENT: '1',
      STUB_BRANCH_POLICIES: '{"branch_policies":[{"name":"main","type":"branch"}]}',
      STUB_STORED: '',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  const waiting: Array<() => void> = [];
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    for (const wake of waiting.splice(0)) wake();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
  const base = async () => {
    for (;;) {
      const found = /Open (http:\/\/127\.0\.0\.1:\d+)\//.exec(output)?.[1];
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`the script exited first:\n${output}`);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { dir, log, api, output: () => output, base, exit };
}

const decode = (text: string) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** Loads the page the script serves, as the browser would, and reads its form. */
async function openPage(base: string) {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  const action = decode(/<form method="post" action="([^"]+)"/.exec(html)?.[1] ?? '');
  const manifest = JSON.parse(decode(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? '{}'));
  const state = new URL(action).searchParams.get('state') ?? '';
  return { response, html, action, manifest, state };
}

/** What GitHub does after "Create GitHub App": redirect back with the code and the state. */
const created = (base: string, state: string, code = 'the-code') =>
  fetch(`${base}/created?code=${code}&state=${state}`, { redirect: 'manual' });

const stored = (run: Run) => ({
  secret: existsSync(join(run.log, 'secret'))
    ? readFileSync(join(run.log, 'secret'), 'utf8')
    : null,
  variable: existsSync(join(run.log, 'variable'))
    ? readFileSync(join(run.log, 'variable'), 'utf8')
    : null,
  calls: existsSync(join(run.log, 'gh.log')) ? readFileSync(join(run.log, 'gh.log'), 'utf8') : '',
});

describe('release app setup', () => {
  it('creates, checks and stores the app, keeping its private key out of every output', async () => {
    const run = await start({ installAfter: 2 });
    const base = await run.base();
    const page = await openPage(base);
    // The page hands GitHub the manifest, for this organization, with an unguessable state.
    expect(page.action).toMatch(
      /^https:\/\/github\.test\/organizations\/PILOTAAI\/settings\/apps\/new\?state=[0-9a-f]{64}$/,
    );
    expect(page.manifest).toEqual({
      name: 'PILOTAAI Slotlock release',
      url: 'https://github.com/PILOTAAI/slotlock',
      description:
        'Opens and merges Slotlock release pull requests for .github/workflows/release-version.yml.',
      hook_attributes: { url: 'https://slotlock.pylota.io/', active: false },
      redirect_url: `${base}/created`,
      setup_url: `${base}/installed`,
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write' },
      default_events: [],
      request_oauth_on_install: false,
      setup_on_update: false,
    });
    const policy = page.response.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/script-src 'nonce-[^']+'/);
    expect(policy).toContain('form-action https://github.test');
    expect(page.response.headers.get('referrer-policy')).toBe('no-referrer');

    const back = await created(base, page.state);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(`${WEB}/apps/${SLUG}/installations/new`);
    expect(await run.exit).toBe(0);

    const result = stored(run);
    expect(result.secret).toBe(privateKey);
    expect(result.variable).toBe(
      `variable set RELEASE_APP_CLIENT_ID --env release-app --repo PILOTAAI/slotlock --body ${CLIENT_ID}`,
    );
    // The key goes in first: the workflow uses the app only once the client ID is there too.
    expect(result.calls.indexOf('secret set')).toBeLessThan(result.calls.indexOf('variable set'));
    expect(result.calls).toContain(
      'secret set RELEASE_APP_PRIVATE_KEY --env release-app --repo PILOTAAI/slotlock\n',
    );
    // The key is never printed, never an argument, never in a file but the one gh received.
    const keyBody = privateKey.split('\n')[5] ?? '';
    expect(keyBody.length).toBeGreaterThan(40);
    expect(run.output()).not.toContain('PRIVATE KEY');
    expect(run.output()).not.toContain(keyBody);
    expect(result.calls).not.toContain(keyBody);
    // The installation was found by polling with valid JWTs, and every check's token was revoked.
    expect(run.api.badJwts).toEqual([]);
    expect(run.api.seen.lookups).toBe(3);
    expect(run.api.seen.minted.length).toBeGreaterThan(0);
    expect(run.api.seen.revoked).toEqual(run.api.seen.minted);
    expect(run.output()).toContain(
      `Release a version now opens and merges release pull requests as ${SLUG}[bot]`,
    );
  });

  it('waits while the installation reaches more than slotlock, and says how to limit it', async () => {
    const run = await start({ reach: ['all', 'two', 'slotlock'] }, { waitMinutes: '0.2' });
    const base = await run.base();
    const page = await openPage(base);
    await created(base, page.state);
    expect(await run.exit).toBe(0);
    const output = run.output();
    expect(output).toContain('The installation reaches every repository in PILOTAAI.');
    expect(output).toContain(
      'The installation reaches 2 repositories (PILOTAAI/slotlock, PILOTAAI/pylota).',
    );
    expect(output).toContain(
      `${WEB}/organizations/PILOTAAI/settings/installations/77 > Only select repositories > slotlock > Save.`,
    );
    expect(run.api.seen.revoked).toEqual(run.api.seen.minted);
    expect(stored(run).secret).toBe(privateKey);
  });

  it('stores nothing when the installation never narrows to slotlock, and says what to delete', async () => {
    const run = await start({ reach: ['all'] }, { waitMinutes: '0.02' });
    const base = await run.base();
    const page = await openPage(base);
    await created(base, page.state);
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain(
      `The app ${SLUG} is not installed on exactly PILOTAAI/slotlock. Nothing was stored.`,
    );
    expect(run.output()).toContain(`${WEB}/organizations/PILOTAAI/settings/apps/${SLUG}/advanced`);
    expect(stored(run)).toMatchObject({ secret: null, variable: null });
    expect(run.api.seen.revoked).toEqual(run.api.seen.minted);
  });

  it.each([
    ['another owner', { owner: 'someone-else' }, 'it belongs to someone-else, not PILOTAAI'],
    [
      'more permissions',
      { permissions: { ...GRANTED, administration: 'write' } },
      'it was given contents: write, metadata: read, pull_requests: write, administration: write',
    ],
  ])('refuses an app GitHub created with %s, storing nothing', async (_, scenario, problem) => {
    const run = await start(scenario);
    const base = await run.base();
    const page = await openPage(base);
    expect((await created(base, page.state)).status).toBe(500);
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain(problem);
    expect(run.output()).toContain(
      `Nothing was stored. Delete it: ${WEB}/organizations/PILOTAAI/settings/apps/${SLUG}/advanced`,
    );
    expect(stored(run)).toMatchObject({ secret: null, variable: null });
  });

  it('ignores a redirect without its state, and answers only requests addressed to it', async () => {
    const run = await start();
    const base = await run.base();
    const page = await openPage(base);
    expect((await created(base, 'f'.repeat(64))).status).toBe(400);
    expect((await created(base, '')).status).toBe(400);
    expect(run.api.seen.conversions).toBe(0);
    // A page on another site cannot drive it through the browser: wrong Host, or not a GET.
    const port = new URL(base).port;
    const status = (method: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          { host: '127.0.0.1', port, method, path: '/', headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on('error', reject);
        request.end();
      });
    expect(await status('GET', 'evil.test')).toBe(421);
    expect(await status('POST', `127.0.0.1:${port}`)).toBe(405);
    // The real redirect still works, once.
    expect((await created(base, page.state)).status).toBe(302);
    expect((await created(base, page.state)).status).toBe(409);
    expect(await run.exit).toBe(0);
    expect(run.api.seen.conversions).toBe(1);
  });

  it.each([
    ['the account is not an owner', { STUB_ROLE: 'member' }, 'ada is not an owner of PILOTAAI'],
    [
      'the environment is open to other branches',
      {
        STUB_BRANCH_POLICIES:
          '{"branch_policies":[{"name":"main","type":"branch"},{"name":"*","type":"branch"}]}',
      },
      'Only main may deploy to release-app',
    ],
    [
      'an app is already stored',
      { STUB_STORED: 'Iv1old' },
      'A release app is already stored (client ID Iv1old). --replace creates and stores a new one.',
    ],
  ])('stops before serving anything when %s', async (_, env, message) => {
    const run = await start({}, { env });
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain(message);
    expect(run.output()).not.toContain('Open http');
    expect(stored(run)).toMatchObject({ secret: null, variable: null });
  });

  it('creates the environment with configure-github.sh when it is missing', async () => {
    const run = await start({}, { env: { STUB_ENVIRONMENT: '' } });
    const base = await run.base();
    expect(run.output()).toContain('The release-app environment does not exist: running');
    expect(existsSync(join(run.log, 'configured'))).toBe(true);
    const page = await openPage(base);
    await created(base, page.state);
    expect(await run.exit).toBe(0);
  });

  it('replaces a stored app with --replace, and names the one to delete', async () => {
    const run = await start({}, { args: ['--replace'], env: { STUB_STORED: 'Iv1old' } });
    const base = await run.base();
    const page = await openPage(base);
    await created(base, page.state);
    expect(await run.exit).toBe(0);
    expect(stored(run).secret).toBe(privateKey);
    expect(run.output()).toContain(
      'The app with client ID Iv1old is no longer used: delete it under',
    );
  });

  it('gives up when no app is created in time', async () => {
    const run = await start({}, { waitMinutes: '0.01' });
    await run.base();
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain('No app was created in time.');
    expect(stored(run)).toMatchObject({ secret: null, variable: null });
  });

  it('prints the manifest on --dry-run without running gh, and refuses a bad name', () => {
    const dry = spawnSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: '/nonexistent' },
    });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      '"default_permissions": {\n    "contents": "write",\n    "pull_requests": "write"\n  }',
    );
    for (const args of [['--name', 'x'.repeat(35)], ['--name'], ['--bogus']]) {
      const bad = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(bad.status, args.join(' ')).toBe(2);
      expect(bad.stderr).toContain('usage: node scripts/create-release-app.mjs');
    }
  });
});
