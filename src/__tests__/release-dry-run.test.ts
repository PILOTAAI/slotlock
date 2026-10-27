// A dry run of "Release a version" (REL-12): the release-app path had never run, and its first real
// use would be a release. With dry_run the workflow mints the app's token, prepares the release and
// checks that token can read the repository and push the release branch, then stops: no pull
// request, merge, tag or site deploy. scripts/release-dry-run.sh is that check; gh is a stand-in
// and origin a local bare repository.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

function dryRun(options: { identity?: string; ghFails?: boolean; origin?: 'ok' | 'missing' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-dry-run-'));
  scratch.push(dir);
  const origin = join(dir, 'origin.git');
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(cwd, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.3"}\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--quiet', '-m', 'main');
  git(cwd, 'remote', 'add', 'origin', origin);
  git(cwd, 'push', '--quiet', 'origin', 'main');
  // What prepare-release.sh leaves: the version moved, not committed.
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.4"}\n');
  if (options.origin === 'missing') git(cwd, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${dir}/gh.log"
[ -n "$STUB_GH_FAILS" ] && { echo "HTTP 404: Not Found" >&2; exit 1; }
[ "$1 $2" = "api repos/PILOTAAI/slotlock" ] && { echo PILOTAAI/slotlock; exit 0; }
echo "unexpected gh $*" >&2; exit 9
`,
    { mode: 0o755 },
  );
  const summary = join(dir, 'summary.md');
  const result = spawnSync(
    'sh',
    [join(root, 'scripts', 'release-dry-run.sh'), '1.2.4', options.identity ?? 'app'],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: `${bin}:${gitEnv.PATH}`,
        GITHUB_REPOSITORY: 'PILOTAAI/slotlock',
        GITHUB_STEP_SUMMARY: summary,
        GH_TOKEN: 'ghs_stand-in',
        ...(options.ghFails ? { STUB_GH_FAILS: '1' } : {}),
      },
    },
  );
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  return { ...result, summary: read(summary), branches: git(origin, 'branch', '--list'), cwd };
}

describe('scripts/release-dry-run.sh', () => {
  it('checks the token can read the repository and push the release branch, and pushes nothing', () => {
    const run = dryRun();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.branches).toBe('* main');
    expect(run.summary).toContain('### Dry run: releasing 1.2.4 as the release app');
    expect(run.summary).toContain('release/v1.2.4');
    expect(run.summary).toContain('package.json');
    // The prepared files are left as they were, uncommitted.
    expect(git(run.cwd, 'status', '--porcelain')).toBe('M package.json');
  });

  it('says when the run would fall back to GITHUB_TOKEN', () => {
    const run = dryRun({ identity: 'github' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.summary).toContain('as GITHUB_TOKEN');
    expect(run.summary).toContain('node scripts/create-release-app.mjs');
  });

  it('fails, naming the token, when it cannot read the repository or push the branch', () => {
    const unread = dryRun({ ghFails: true });
    expect(unread.status).toBe(1);
    expect(unread.stderr).toContain('the release app token cannot read PILOTAAI/slotlock');
    const unpushed = dryRun({ origin: 'missing' });
    expect(unpushed.status).toBe(1);
    expect(unpushed.stderr).toContain('the release app token cannot push release/v1.2.4');
  });

  it('refuses an identity it does not know and a malformed version', () => {
    expect(dryRun({ identity: 'someone' }).status).toBe(2);
  });
});

describe('Release a version, dry run', () => {
  const text = readFileSync(join(root, '.github', 'workflows', 'release-version.yml'), 'utf8');
  const step = (name: string) => {
    const start = text.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThan(0);
    const next = text.indexOf('\n      - ', start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it('takes a dry_run input, off by default', () => {
    expect(text).toMatch(
      / {6}dry_run:\n {8}description: [^\n]+\n {8}required: false\n {8}type: boolean\n {8}default: false\n/,
    );
  });

  it('runs the check instead of every step with an effect', () => {
    expect(step('Check the release token in a dry run, opening nothing')).toContain(
      'if: inputs.dry_run == true',
    );
    for (const name of [
      'Push the release branch and open its pull request',
      'Wait for CI and DCO on the pull request',
      'Merge it',
      'Start Tag release and Site on main',
      'Say what the merge starts',
    ]) {
      expect(step(name), name).toMatch(
        /\n {8}if: (?:inputs\.dry_run != true|.* && inputs\.dry_run != true)\n/,
      );
    }
    // The minting and the preparation run either way: they are what the dry run proves.
    expect(step("Mint the release app's token")).not.toContain('dry_run');
    expect(step('Prepare the release')).not.toContain('dry_run');
  });
});
