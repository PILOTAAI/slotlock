// scripts/publish-due-posts.mjs and scheduled-posts.yml: a post merged ahead of its publishAt goes
// live when its time comes, through a rebuild of the site, and nothing else starts one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'publish-due-posts.mjs');
const NOW = '2026-11-16T13:20:00Z';

const scratch: string[] = [];
let server: Server;
let site = '';
/** The paths the stand-in site was asked for, and what it serves: these are live, the rest 404. */
const asked: string[] = [];
const live = new Set(['/blog/already-live/']);
let failing = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    if (failing) return void response.writeHead(503).end();
    response.writeHead(live.has(request.url ?? '') ? 200 : 404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  site = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function post(status: string, publishAt?: string) {
  return ['---', 'title: A post', `status: ${status}`, ...(publishAt ? [`publishAt: ${publishAt}`] : []), '---', 'Body.', ''].join('\n');
}

function posts(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-posts-'));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Runs the script without blocking this process, which serves the stand-in site. */
function run(dir: string, now = NOW) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? '', SLOTLOCK_SITE_URL: site, SLOTLOCK_POSTS_DIR: dir, SLOTLOCK_NOW: now },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr })),
  );
}

describe('publish-due-posts.mjs', () => {
  it('lists only published posts whose time has come and that the site does not serve yet', async () => {
    const dir = posts({
      'due-now.md': post('published', '2026-11-16T13:00Z'),
      'already-live.md': post('published', '2026-11-16T12:00Z'),
      'still-to-come.md': post('published', '2026-11-16T14:00Z'),
      'a-draft.md': post('draft', '2026-11-16T13:00Z'),
      'no-date.md': post('published'),
      'long-ago.md': post('published', '2026-11-10T09:00Z'),
      'notes.txt': 'not a post',
    });
    asked.length = 0;
    const result = await run(dir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('due-now\n');
    expect(result.stderr).toContain('already-live: live (200)');
    // Only the due posts are asked for, each once, with HEAD.
    expect(asked.sort()).toEqual(['HEAD /blog/already-live/', 'HEAD /blog/due-now/']);
  });

  it('lists nothing while the post is still to come, and lists it once its time has passed', async () => {
    const dir = posts({ 'launch.md': post('published', '2026-11-16T13:00Z') });
    expect((await run(dir, '2026-11-16T12:59:00Z')).stdout).toBe('');
    expect((await run(dir, '2026-11-16T13:00:00Z')).stdout).toBe('launch\n');
  });

  it('starts no rebuild when the site itself is failing', async () => {
    const dir = posts({ 'due-now.md': post('published', '2026-11-16T13:00Z') });
    failing = true;
    try {
      const result = await run(dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('answered 503; not rebuilding for it');
    } finally {
      failing = false;
    }
  });

  it('reads every post in the repository', async () => {
    const result = await run(join(root, 'site', 'content', 'blog'), '2026-11-13T00:00:00Z');
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('scheduled-posts.yml', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'scheduled-posts.yml'), 'utf8');

  it('runs on main every quarter hour and may only start workflows', () => {
    expect(workflow).toMatch(/^ {4}- cron: "4,19,34,49 \* \* \* \*"$/m);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}actions: write\n/m);
    expect(workflow).not.toContain('secrets.');
  });

  it('starts the Site workflow on main only when a post is due and not live', () => {
    expect(workflow).toContain("if: steps.due.outputs.slugs != ''");
    expect(workflow).toContain('gh workflow run site.yml --ref main --repo "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('node scripts/publish-due-posts.mjs');
  });
});
