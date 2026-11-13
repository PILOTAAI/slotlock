// workers/status/worker.ts against a stand-in for the API, the dashboard, the site, GitHub and the
// heartbeat: it opens and closes `status` issues as status-probe.sh does, starts the Site workflow
// for a post that is due and not live, and pings the heartbeat on every run.
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker, { type SlotlockStatusEnv, runSlotlockStatus } from '../../workers/status/worker.js';

interface World {
  apiAnswers: { status: number; body: unknown }[];
  dashboardStatus: number;
  siteStatus: number;
  openIssues: { number: number; title: string; pull_request?: object }[];
  posts: Record<string, string>;
  livePosts: Set<string>;
  siteRuns: { status: string; created_at: string }[];
  heartbeatStatus: number;
  failGitHub: boolean;
}
let world: World;
const calls: { method: string; path: string; body: unknown; auth: string | undefined }[] = [];
let server: Server;
let base = '';
const NOW = Date.parse('2026-11-16T13:05:00Z');

function post(status: string, publishAt?: string) {
  return ['---', 'title: A post', `status: ${status}`, ...(publishAt ? [`publishAt: ${publishAt}`] : []), '---', 'Body.', ''].join('\n');
}

beforeEach(() => {
  world = {
    apiAnswers: [{ status: 200, body: { status: 'ready', version: '0.10.2' } }],
    dashboardStatus: 200,
    siteStatus: 200,
    openIssues: [],
    posts: { 'old-post.md': post('published') },
    livePosts: new Set(),
    siteRuns: [{ status: 'completed', created_at: '2026-11-16T09:00:00Z' }],
    heartbeatStatus: 200,
    failGitHub: false,
  };
  calls.length = 0;
});

async function body(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    const send = (status: number, payload: unknown = '') =>
      response
        .writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json' })
        .end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    if (url.pathname === '/api/healthz') {
      const answer = world.apiAnswers.length > 1 ? world.apiAnswers.shift() : world.apiAnswers[0];
      return send(answer?.status ?? 500, answer?.body ?? '');
    }
    if (url.pathname === '/dashboard/dashboard') return send(world.dashboardStatus);
    if (url.pathname === '/site/') return send(world.siteStatus);
    if (url.pathname.startsWith('/site/blog/')) {
      const slug = url.pathname.split('/')[3] ?? '';
      return send(world.livePosts.has(slug) ? 200 : 404);
    }
    if (url.pathname === '/heartbeat') return send(world.heartbeatStatus);
    if (url.pathname.startsWith('/github/')) {
      const path = url.pathname.slice('/github'.length);
      calls.push({ method: request.method ?? '', path: `${path}${url.search}`, body: await body(request), auth: request.headers.authorization });
      if (world.failGitHub) return send(502, { message: 'Bad gateway' });
      const repo = '/repos/PILOTAAI/slotlock';
      if (request.method === 'GET' && path === `${repo}/issues`) return send(200, world.openIssues);
      if (request.method === 'POST' && path === `${repo}/issues`) return send(201, { number: 300 });
      if (request.method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) return send(201, {});
      if (request.method === 'PATCH' && /\/issues\/\d+$/.test(path)) return send(200, {});
      if (path === `${repo}/contents/site/content/blog`) {
        return send(
          200,
          Object.keys(world.posts).map((name) => ({ name, path: `site/content/blog/${name}`, type: 'file' })),
        );
      }
      if (path.startsWith(`${repo}/contents/site/content/blog/`)) return send(200, world.posts[path.split('/').at(-1) ?? ''] ?? '');
      if (path === `${repo}/actions/workflows/site.yml/runs`) return send(200, { workflow_runs: world.siteRuns });
      if (path === `${repo}/actions/workflows/site.yml/dispatches`) return send(204);
      return send(404, { message: 'Not Found' });
    }
    return send(404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => server.close());

function env(overrides: Partial<SlotlockStatusEnv> = {}): SlotlockStatusEnv {
  return {
    SLOTLOCK_STATUS_REPOSITORY: 'PILOTAAI/slotlock',
    SLOTLOCK_STATUS_API: `${base}/api`,
    SLOTLOCK_STATUS_DASHBOARD: `${base}/dashboard`,
    SLOTLOCK_STATUS_SITE: `${base}/site`,
    SLOTLOCK_STATUS_RETRY_SECONDS: '0',
    SLOTLOCK_STATUS_GITHUB_API: `${base}/github`,
    SLOTLOCK_STATUS_GITHUB_TOKEN: 'github_pat_test',
    SLOTLOCK_STATUS_HEARTBEAT_URL: `${base}/heartbeat`,
    ...overrides,
  };
}
const writes = () => calls.filter((call) => call.method !== 'GET');

describe('status Worker', () => {
  it('changes nothing while everything is up and no post is due, and pings the heartbeat', async () => {
    const report = await runSlotlockStatus(env(), NOW);
    expect(report.parts).toEqual([
      { name: 'api', up: true },
      { name: 'dashboard', up: true },
      { name: 'site', up: true },
    ]);
    expect(report.heartbeat).toBe(true);
    expect(report.problems).toEqual([]);
    expect(writes()).toEqual([]);
    expect(calls.every((call) => call.auth === 'Bearer github_pat_test')).toBe(true);
  });

  it('opens an issue for a part down three times, and closes the issue of a part that is up again', async () => {
    world.apiAnswers = [{ status: 200, body: { status: 'starting' } }];
    // A pull request with an incident's title is not the incident's issue.
    world.openIssues = [
      { number: 9, title: 'Hosted Slotlock API is down', pull_request: {} },
      { number: 41, title: 'Hosted Slotlock dashboard is down' },
    ];
    const report = await runSlotlockStatus(env(), NOW);
    expect(report.parts[0]).toEqual({ name: 'api', up: false, why: 'not ready: starting', issue: 'opened #300' });
    expect(report.parts[1]).toEqual({ name: 'dashboard', up: true, issue: 'closed #41' });
    const opened = writes().find((call) => call.path === '/repos/PILOTAAI/slotlock/issues');
    expect(opened?.body).toMatchObject({ title: 'Hosted Slotlock API is down', labels: ['status'] });
    expect((opened?.body as { body: string }).body).toContain('failed three checks in a row from Cloudflare, the last at 2026-11-16T13:05:00Z: not ready: starting.');
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /repos/PILOTAAI/slotlock/issues',
      'POST /repos/PILOTAAI/slotlock/issues/41/comments',
      'PATCH /repos/PILOTAAI/slotlock/issues/41',
    ]);
  });

  it('calls a part down only after three failed checks, and opens no second issue for it', async () => {
    world.apiAnswers = [
      { status: 503, body: '' },
      { status: 503, body: '' },
      { status: 200, body: { status: 'ready' } },
    ];
    world.siteStatus = 502;
    world.openIssues = [{ number: 7, title: 'Slotlock site is down' }];
    const report = await runSlotlockStatus(env(), NOW);
    expect(report.parts[0]).toEqual({ name: 'api', up: true });
    expect(report.parts[2]).toEqual({ name: 'site', up: false, why: 'HTTP 502' });
    expect(writes()).toEqual([]);
  });

  it('starts the Site workflow for a post that is due and not live, once', async () => {
    world.posts = {
      'introducing-slotlock.md': post('published', '2026-11-16T13:00Z'),
      'still-to-come.md': post('published', '2026-11-17T09:00Z'),
      'a-draft.md': post('draft', '2026-11-16T12:00Z'),
      'already-live.md': post('published', '2026-11-16T12:00Z'),
    };
    world.livePosts.add('already-live');
    const report = await runSlotlockStatus(env(), NOW);
    expect(report.posts).toEqual({ due: ['introducing-slotlock', 'already-live'], missing: ['introducing-slotlock'], dispatched: true });
    const dispatch = writes().find((call) => call.path.endsWith('/actions/workflows/site.yml/dispatches'));
    expect(dispatch).toMatchObject({ method: 'POST', body: { ref: 'main' } });

    // While that run goes, the next run starts nothing more.
    world.siteRuns = [{ status: 'in_progress', created_at: '2026-11-16T13:05:01Z' }];
    calls.length = 0;
    const next = await runSlotlockStatus(env(), NOW + 5 * 60 * 1000);
    expect(next.posts).toMatchObject({ missing: ['introducing-slotlock'], dispatched: false, skipped: 'a Site run is in_progress' });
    expect(writes()).toEqual([]);
  });

  it('runs without a token, touching nothing on GitHub, and says so', async () => {
    world.apiAnswers = [{ status: 500, body: '' }];
    const report = await runSlotlockStatus(env({ SLOTLOCK_STATUS_GITHUB_TOKEN: '' }), NOW);
    expect(report.parts[0]).toEqual({ name: 'api', up: false, why: 'HTTP 500' });
    expect(report.problems).toEqual(['no GitHub token: issues and posts are left alone']);
    expect(calls).toEqual([]);
    expect(report.heartbeat).toBe(true);
  });

  it('keeps going when GitHub fails, and reports a heartbeat that fails', async () => {
    world.failGitHub = true;
    world.heartbeatStatus = 500;
    const report = await runSlotlockStatus(env(), NOW);
    expect(report.parts.map((part) => part.up)).toEqual([true, true, true]);
    expect(report.problems).toHaveLength(5);
    expect(report.problems[0]).toContain('api: GitHub answered 502 to GET /repos/PILOTAAI/slotlock/issues');
    expect(report.problems.at(-1)).toBe('heartbeat: HTTP 500');
    expect(report.heartbeat).toBe(false);
  });

  it('runs on its schedule and serves nothing', async () => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, env({ SLOTLOCK_STATUS_HEARTBEAT_URL: '' }), { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    expect(calls.some((call) => call.path === '/repos/PILOTAAI/slotlock/issues?labels=status&state=open&per_page=100')).toBe(true);
    expect((await worker.fetch()).status).toBe(404);
  });
});

describe('status-worker.yml and wrangler.jsonc', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workflow = readFileSync(join(root, '.github', 'workflows', 'status-worker.yml'), 'utf8');
  const config = readFileSync(join(root, 'workers', 'status', 'wrangler.jsonc'), 'utf8');

  it('runs every five minutes, with no route and no workers.dev address', () => {
    expect(config).toContain('"triggers": { "crons": ["*/5 * * * *"] }');
    expect(config).toContain('"workers_dev": false');
    expect(config).not.toContain('"routes"');
  });

  it('deploys only from main, in the site environment, and hands the secrets over on stdin', () => {
    const deploy = workflow.slice(workflow.indexOf('  deploy:'));
    expect(deploy).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
    expect(deploy).toMatch(/environment:\n {6}name: site\n/);
    expect(deploy).toContain('npx wrangler secret bulk');
    expect(deploy).not.toMatch(/wrangler secret bulk \S/);
    // The pull request job holds no secret.
    expect(workflow.slice(0, workflow.indexOf('  deploy:'))).not.toContain('secrets.');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});
