// scripts/check-cloudflare-credentials.sh, the check site.yml runs before every deploy and
// configure-github.sh runs before it stores the Cloudflare secrets, against a local stand-in for the
// Cloudflare API. The stand-in answers the way api.cloudflare.com answered made-up values on
// 2026-10-10: 6003 with a 6111 chain for anything shorter than 40 characters or containing a space or
// a quote, and 1000 "Invalid API Token" for a well-formed value that is not a live token.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = join(root, 'scripts', 'check-cloudflare-credentials.sh');
const configure = join(root, 'scripts', 'configure-github.sh');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'fedcba9876543210fedcba9876543210';
const ACCOUNT_TOKEN = `cfat_${'A'.repeat(40)}x1y2z3w4`;
const USER_TOKEN = 'u'.repeat(40);
const EXPIRED_TOKEN = 'e'.repeat(40);
const NO_WORKERS_TOKEN = 'n'.repeat(40);

const requests: { path: string; authorization: string }[] = [];

function answer(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function refusal(token: string) {
  return token.length < 40 || /[\s"'`]/.test(token)
    ? {
        code: 6003,
        message: 'Invalid request headers',
        error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }],
      }
    : { code: 1000, message: 'Invalid API Token' };
}

function cloudflare(request: IncomingMessage, response: ServerResponse) {
  const authorization = request.headers.authorization ?? '';
  const path = request.url ?? '';
  requests.push({ path, authorization });
  const token = authorization.replace(/^Bearer /, '');
  const verified = (status: string) => answer(response, 200, { success: true, result: { status } });
  if (path === `/accounts/${ACCOUNT}/tokens/verify`) {
    if (token === ACCOUNT_TOKEN || token === NO_WORKERS_TOKEN) return verified('active');
    if (token === EXPIRED_TOKEN) return verified('expired');
  } else if (path === '/user/tokens/verify') {
    if (token === USER_TOKEN) return verified('active');
  } else if (path === `/accounts/${ACCOUNT}/workers/scripts`) {
    if (token === ACCOUNT_TOKEN || token === USER_TOKEN) {
      return answer(response, 200, { success: true, result: [] });
    }
    return answer(response, 403, {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    });
  } else if (path === `/accounts/${OTHER_ACCOUNT}/workers/scripts`) {
    return answer(response, 403, {
      success: false,
      errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
    });
  }
  return answer(response, 400, { success: false, errors: [refusal(token)] });
}

const server = createServer(cloudflare);
let api = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests.length = 0;
});

/** Runs a script without blocking this process, so the stand-in API can answer it. */
function run(
  file: string,
  args: string[],
  env: Record<string, string>,
  input = '',
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [file, ...args],
      { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
      },
    );
    child.stdin?.end(input);
  });
}

function check(token: string, account = ACCOUNT, extra: Record<string, string> = {}) {
  return run(checker, [], {
    CLOUDFLARE_API_BASE_URL: api,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: account,
    ...extra,
  });
}

describe('check-cloudflare-credentials.sh', () => {
  it('accepts an active account API token that can list the account Workers', async () => {
    const result = await check(ACCOUNT_TOKEN);
    expect(result.code).toBe(0);
    expect(result.output).toContain('an active account API token');
    // The token travels only in the Authorization header.
    expect(requests.map((r) => r.authorization)).toEqual(
      requests.map(() => `Bearer ${ACCOUNT_TOKEN}`),
    );
  });

  it('accepts an active user API token, verified under /user', async () => {
    const result = await check(USER_TOKEN);
    expect(result.code).toBe(0);
    expect(result.output).toContain('an active user API token');
  });

  it.each([
    ['the account ID', ACCOUNT, 'holds the account ID'],
    ['a value with a space', `${'a'.repeat(20)} ${'b'.repeat(20)}`, 'contains a space'],
    ['a quoted token', `"${USER_TOKEN}"`, 'contains a quote'],
    ['a Global API Key in the new format', `cfk_${'k'.repeat(40)}abcd`, 'Global API Key'],
  ])('refuses %s without asking Cloudflare', async (_label, token, reason) => {
    const result = await check(token);
    expect(result.code).toBe(1);
    expect(result.output).toContain(reason);
    expect(requests).toEqual([]);
  });

  it.each([
    ['an account or token ID', 'fedcba9876543210fedcba9876543211', 'shape of an account ID'],
    [
      'an older Global API Key',
      '0123456789abcdef0123456789abcdef01234',
      'shape of a Global API Key',
    ],
    ['a cut-off paste', USER_TOKEN.slice(0, 39), 'paste may be cut off'],
    ['an unknown token', 'z'.repeat(40), 'Cloudflare does not know it'],
  ])('names the mistake when Cloudflare refuses %s', async (_label, token, reason) => {
    const result = await check(token);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Cloudflare refused CLOUDFLARE_API_TOKEN');
    expect(result.output).toContain(reason);
  });

  it('refuses a token that is not active', async () => {
    const result = await check(EXPIRED_TOKEN);
    expect(result.code).toBe(1);
    expect(result.output).toContain('status is expired');
  });

  it('refuses an active token that cannot reach Workers in the account', async () => {
    const missingPermission = await check(NO_WORKERS_TOKEN);
    expect(missingPermission.code).toBe(1);
    expect(missingPermission.output).toContain('cannot list Workers');
    const otherAccount = await check(USER_TOKEN, OTHER_ACCOUNT);
    expect(otherAccount.code).toBe(1);
    expect(otherAccount.output).toContain('9109 Unauthorized to access requested resource');
  });

  it('writes a GitHub annotation in Actions', async () => {
    const result = await check(ACCOUNT, ACCOUNT, { GITHUB_ACTIONS: 'true' });
    expect(result.output).toMatch(/^::error title=Cloudflare credentials::/);
  });

  it('never prints the token or the account ID', async () => {
    for (const token of [ACCOUNT_TOKEN, USER_TOKEN, EXPIRED_TOKEN, 'z'.repeat(40), ACCOUNT]) {
      const { output } = await check(token);
      expect(output).not.toContain(token);
      expect(output).not.toContain(ACCOUNT);
    }
  });
});

describe('configure-github.sh --site-secrets', () => {
  let bin = '';
  let stored = '';

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'slotlock-gh-'));
    stored = join(bin, 'stored');
    // A gh that answers the preflight and records each secret set, with the value it read.
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash
case "$*" in
  'api user'*'--jq .id') echo 123 ;;
  'api user'*'--jq .login') echo owner ;;
  'secret set '*) printf '%s=%s\\n' "$3" "$(cat)" >> "${stored}" ;;
  *'environments/site/secrets'*) echo '{"secrets":[{"name":"CLOUDFLARE_API_TOKEN"},{"name":"CLOUDFLARE_ACCOUNT_ID"}]}' ;;
  *'repos/PILOTAAI/slotlock') echo '{"permissions":{"admin":true},"visibility":"public","default_branch":"main"}' ;;
  *) echo '{}' ;;
esac
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
  });
  afterAll(() => rmSync(bin, { recursive: true, force: true }));
  beforeEach(() => rmSync(stored, { force: true }));

  const secrets = (input: string) =>
    run(
      configure,
      ['--site-secrets'],
      { PATH: `${bin}:${process.env.PATH ?? ''}`, CLOUDFLARE_API_BASE_URL: api },
      input,
    );

  it('stores nothing Cloudflare refuses, then stores both values once it accepts them', async () => {
    // First attempt: the account ID pasted as the token. Second: the token, with stray spaces.
    const result = await secrets(`${ACCOUNT}\n${ACCOUNT}\n ${ACCOUNT}\n  ${ACCOUNT_TOKEN} \n`);
    expect(result.code).toBe(0);
    expect(result.output).toContain('holds the account ID');
    expect(readFileSync(stored, 'utf8')).toBe(
      `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${ACCOUNT_TOKEN}\n`,
    );
    expect(result.output).not.toContain(ACCOUNT_TOKEN);
  });

  it('leaves the stored values alone and exits 1 after three refusals', async () => {
    const wrong = `${ACCOUNT}\n${'z'.repeat(40)}\n`;
    const result = await secrets(wrong.repeat(3));
    expect(result.code).toBe(1);
    expect(result.output).toContain('3 of 3');
    expect(() => readFileSync(stored, 'utf8')).toThrow();
  });
});

describe('site.yml', () => {
  it('checks the credentials with the same secrets before the deploy step runs', () => {
    const site = readFileSync(join(root, '.github', 'workflows', 'site.yml'), 'utf8');
    const deploy = site.slice(site.indexOf('\n  deploy:'));
    const check = deploy.indexOf('run: bash scripts/check-cloudflare-credentials.sh');
    const wrangler = deploy.indexOf('run: npm run deploy');
    expect(check, 'the check step').toBeGreaterThan(0);
    expect(wrangler, 'the deploy step').toBeGreaterThan(check);
    const step = deploy.slice(deploy.lastIndexOf('- name:', check), check);
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(step).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    // A change to the checker runs the site workflow too.
    expect(site.match(/- "scripts\/check-cloudflare-credentials\.sh"/g)).toHaveLength(2);
  });
});
