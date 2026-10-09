// The release and self-host files agree with each other and with the code: every GitHub Action is
// pinned to a commit with its version beside it, every base image to a digest, server.json names
// what the Dockerfile labels and what the CLI reads, and the DCO and release-tag scripts accept and
// refuse what their workflows rely on.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_ENVIRONMENT_VARIABLES } from '../self-host.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const workflowDirectory = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(workflowDirectory, file), 'utf8') }));
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;

interface ServerJson {
  name: string;
  version: string;
  packages: {
    identifier: string;
    transport: { url: string; headers: { name: string; value: string }[] };
    runtimeArguments: { name: string; value: string; variables: Record<string, unknown> }[];
    environmentVariables: { name: string; isRequired?: boolean; isSecret?: boolean }[];
  }[];
}
const server = JSON.parse(read('server.json')) as ServerJson;
const serverPackage = server.packages[0];

describe('pinned dependencies', () => {
  it('pins every action to a full commit SHA with the matching version comment', () => {
    const versions = new Map<string, string>();
    let count = 0;
    for (const { file, text } of workflows) {
      for (const line of text.split('\n')) {
        const match = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!match) continue;
        const [, reference = '', comment = ''] = match;
        // A reusable workflow in this repository runs from the same commit as its caller.
        if (/^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/.test(reference)) continue;
        count += 1;
        expect(reference, `${file}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        const version = /^\s*#\s*(v\d+\.\d+\.\d+)\s*$/.exec(comment)?.[1];
        expect(version, `${file}: ${line.trim()} needs a # vX.Y.Z comment`).toBeDefined();
        // One commit is one version everywhere, so a stale comment cannot hide an update.
        const sha = reference.split('@')[1] as string;
        expect(versions.get(sha) ?? version, `${file}: ${reference}`).toBe(version);
        versions.set(sha, version as string);
      }
    }
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it('pins every base and service image to a digest', () => {
    const fromLines = read('Dockerfile')
      .split('\n')
      .filter((line) => line.startsWith('FROM '));
    expect(fromLines).toHaveLength(3);
    for (const line of fromLines) expect(line).toMatch(/^FROM \S+:\S+@sha256:[0-9a-f]{64} AS \w+$/);
    const images = [
      ...read('docker-compose.yml').matchAll(/^[ \t]+image:[ \t]*(\S+)/gm),
      ...workflows.flatMap(({ text }) => [...text.matchAll(/^[ \t]+image:[ \t]*(\S+)/gm)]),
    ].map(([, image]) => image as string);
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const image of images.filter((name) => name !== 'slotlock:local')) {
      expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    }
  });
});

describe('MCP Registry entry', () => {
  it('names the server the image is labelled with, at the package version', () => {
    const label = /io\.modelcontextprotocol\.server\.name="([^"]+)"/.exec(read('Dockerfile'))?.[1];
    expect(label).toBe('io.github.PILOTAAI/slotlock');
    expect(server.name).toBe(label);
    expect(server.version).toBe(packageVersion);
    expect(serverPackage?.identifier).toBe(`ghcr.io/pilotaai/slotlock:${packageVersion}`);
  });

  it('declares only variables the command reads, with the secrets required and secret', () => {
    const declared = serverPackage?.environmentVariables ?? [];
    const known: readonly string[] = SLOTLOCK_ENVIRONMENT_VARIABLES;
    for (const { name } of declared) expect(known).toContain(name);
    for (const name of ['DATABASE_URL', 'SLOTLOCK_AUTH_TOKEN', 'SLOTLOCK_CONFIRMATION_SECRET']) {
      expect(declared.find((variable) => variable.name === name)).toMatchObject({
        isRequired: true,
        isSecret: true,
      });
    }
    // The URL's {PORT} is the PORT variable, which is also the published container port.
    expect(serverPackage?.transport.url).toBe('http://localhost:{PORT}/mcp');
    expect(declared.map(({ name }) => name)).toContain('PORT');
    expect(serverPackage?.runtimeArguments).toContainEqual(
      expect.objectContaining({ name: '-p', value: '127.0.0.1:{PORT}:{PORT}' }),
    );
    expect(serverPackage?.transport.headers).toContainEqual(
      expect.objectContaining({ name: 'Authorization', value: 'Bearer {SLOTLOCK_AUTH_TOKEN}' }),
    );
  });
});

describe('Compose quickstart', () => {
  const compose = read('docker-compose.yml');
  const example = read('.env.example');
  const exampleKeys = new Map(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(([, key, value]) => [key, value]),
  );

  it('documents every variable it interpolates and commits no secret value', () => {
    const interpolated = new Set(
      [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name),
    );
    for (const name of interpolated) expect([...exampleKeys.keys()]).toContain(name);
    for (const secret of [
      'POSTGRES_PASSWORD',
      'SLOTLOCK_APP_DB_PASSWORD',
      'SLOTLOCK_AUTH_TOKEN',
      'SLOTLOCK_CONFIRMATION_SECRET',
    ]) {
      expect(exampleKeys.get(secret), secret).toBe('');
    }
    expect(read('.gitignore').split('\n')).toContain('.env');
  });

  it('publishes ports on loopback only', () => {
    const ports = [...compose.matchAll(/^\s+-\s*"([^"]*:\d+)"\s*$/gm)].map(([, port]) => port);
    expect(ports).toEqual(['127.0.0.1:${SLOTLOCK_PORT:-8080}:8080']);
  });
});

const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

/** A throwaway repository that ignores the developer's own git configuration. */
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'slotlock-release-'));
  scratch.push(cwd);
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_COMMITTER_NAME: 'Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  const commit = (message: string, author = 'Ada <ada@example.com>') => {
    git('commit', '--quiet', '--allow-empty', `--author=${author}`, '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const script = (name: string, ...args: string[]) =>
    spawnSync('sh', [join(root, 'scripts', name), ...args], { cwd, env, encoding: 'utf8' });
  return { cwd, git, commit, script };
}

describe('database suite credentials', () => {
  // The suites and the CLI both see who they connect as. A role named slotlock is the package's own
  // schema, which "$user" puts first on the default search path, so names resolve as they never do
  // for a deployment role. And the CLI redacts the database password from everything it prints, so
  // a password that is a word in that output rewrites it. With slotlock:slotlock, both turned four
  // integration tests red on the first CI run while they passed locally as another role.
  it('runs them as a role that is not the schema, with a password its output never contains', () => {
    const sources = [...workflows, { file: 'CONTRIBUTING.md', text: read('CONTRIBUTING.md') }];
    const roles: { file: string; value: string }[] = [];
    const passwords: { file: string; value: string }[] = [];
    for (const { file, text } of sources) {
      for (const [, user, password] of text.matchAll(/postgres(?:ql)?:\/\/([^:@/\s]+):([^@/\s]+)@/g)) {
        roles.push({ file, value: user as string });
        passwords.push({ file, value: password as string });
      }
      for (const [, user] of text.matchAll(/(?:POSTGRES_USER:\s*|--username=)([^\s"]+)/g)) {
        roles.push({ file, value: user as string });
      }
      for (const [, password] of text.matchAll(/POSTGRES_PASSWORD:\s*(\S+)/g)) {
        passwords.push({ file, value: password as string });
      }
    }
    expect(roles.length, 'canary: CI, release and CONTRIBUTING name their roles').toBeGreaterThanOrEqual(10);
    expect(passwords.length, 'canary: and their passwords').toBeGreaterThanOrEqual(7);
    for (const { file, value } of roles) expect(value, `${file}: role`).not.toBe('slotlock');
    for (const { file, value } of passwords) {
      expect(value, `${file}: password`).not.toMatch(/slot|lock/i);
      expect(value.length, `${file}: password ${value} is short enough to occur in output`).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('DCO check', () => {
  it('passes signed-off commits and names each one without a sign-off from its author', () => {
    const repo = repository();
    const base = repo.commit('base');
    repo.commit('signed\n\nSigned-off-by: Ada <ADA@example.com>');
    repo.commit('bot bump', 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>');
    const signed = repo.git('rev-parse', 'HEAD');
    expect(repo.script('check-dco.sh', base, signed).status).toBe(0);

    const unsigned = repo.commit('unsigned');
    const otherSigner = repo.commit(
      'signed by someone else\n\nSigned-off-by: Bob <bob@example.com>',
    );
    const result = repo.script('check-dco.sh', base, otherSigner);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`Commit ${unsigned.slice(0, 7)}`);
    expect(result.stdout).toContain(`Commit ${otherSigner.slice(0, 7)}`);
    expect(result.stdout.match(/::error::/g)).toHaveLength(2);
  });
});

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!hasJq)('release tag check', () => {
  function release(changelogDate = '2026-10-09') {
    const repo = repository();
    writeFileSync(join(repo.cwd, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(repo.cwd, 'CHANGELOG.md'), `# Changelog\n\n## 1.2.3 - ${changelogDate}\n`);
    writeFileSync(
      join(repo.cwd, 'server.json'),
      JSON.stringify({
        version: '1.2.3',
        packages: [{ identifier: 'ghcr.io/pilotaai/slotlock:1.2.3' }],
      }),
    );
    repo.git('add', '.');
    const released = repo.commit('release 1.2.3');
    repo.git('update-ref', 'refs/remotes/origin/main', released);
    return repo;
  }

  it('accepts a tag on main that matches every version', () => {
    const repo = release();
    repo.git('tag', 'v1.2.3');
    const result = repo.script('check-release-tag.sh', 'v1.2.3');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('refuses a tag that is not the package version', () => {
    const repo = release();
    repo.git('tag', 'v1.2.4');
    expect(repo.script('check-release-tag.sh', 'v1.2.4').stderr).toMatch(
      /does not match package\.json/,
    );
  });

  it('refuses a tag on a commit that is not on main', () => {
    const repo = release();
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.commit('unmerged');
    repo.git('tag', 'v1.2.3');
    const result = repo.script('check-release-tag.sh', 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not on main/);
  });

  it('refuses a version without a dated CHANGELOG heading', () => {
    const repo = release('Unreleased');
    repo.git('tag', 'v1.2.3');
    expect(repo.script('check-release-tag.sh', 'v1.2.3').stderr).toMatch(/no dated heading/);
  });
});
