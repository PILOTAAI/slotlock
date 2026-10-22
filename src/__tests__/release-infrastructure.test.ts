// The release and self-host files agree with each other and with the code: every GitHub Action is
// pinned to a commit with its version beside it, every base image to a digest, server.json names
// what the Dockerfile labels and what the CLI reads, and the DCO, release-tag, release-planning and
// bootstrap scripts accept and refuse what their workflows rely on.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  // Kamal pulls an image it did not build only when its `service` label names the service it deploys
  // (`docker inspect -f '{{ .Config.Labels.service }}' | grep -x <service>`), so without it the
  // published image cannot be deployed with Kamal.
  it('labels the image with the service Kamal deploys it as', () => {
    expect(/^\s*service="([^"]+)"/m.exec(read('Dockerfile'))?.[1]).toBe('slotlock');
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
      'SLOTLOCK_GITHUB_CLIENT_SECRET',
      'SLOTLOCK_SESSION_SECRET',
    ]) {
      expect(exampleKeys.get(secret), secret).toBe('');
    }
    expect(read('.gitignore').split('\n')).toContain('.env');
  });

  it('hands the server every setting serve reads, so .env can set each one', () => {
    const service = compose.slice(compose.indexOf('\n  slotlock:\n'), compose.indexOf('\nvolumes:'));
    const passed = new Set(
      [...service.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map(([, name]) => name),
    );
    expect(passed, 'canary: the service environment was found').toContain('DATABASE_URL');
    // The owner's URL belongs to the one-off migrate service; HOST and PORT are the image's own.
    const owned = new Set(['SLOTLOCK_MIGRATE_DATABASE_URL', 'HOST', 'PORT']);
    const missing = SLOTLOCK_ENVIRONMENT_VARIABLES.filter(
      (name) => !owned.has(name) && !passed.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("mounts Postgres's volume where its image keeps the data", () => {
    // From 18 the official image keeps its data in a version directory under /var/lib/postgresql,
    // and refuses to start (exit 1, even on a new empty volume) with a mount at .../data.
    const service = compose.slice(compose.indexOf('\n  postgres:\n'), compose.indexOf('\n  db-roles:\n'));
    const major = Number(/image:\s*postgres:(\d+)/.exec(service)?.[1]);
    expect(major, 'canary: the postgres service and its image were found').toBeGreaterThan(0);
    const mounts = [...service.matchAll(/^\s+-\s*postgres-data:(\S+)\s*$/gm)].map(([, path]) => path);
    expect(mounts).toEqual([major >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data']);
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
      for (const [, user, password] of text.matchAll(
        /postgres(?:ql)?:\/\/([^:@/\s]+):([^@/\s]+)@/g,
      )) {
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
    expect(
      roles.length,
      'canary: CI, release and CONTRIBUTING name their roles',
    ).toBeGreaterThanOrEqual(10);
    expect(passwords.length, 'canary: and their passwords').toBeGreaterThanOrEqual(7);
    for (const { file, value } of roles) expect(value, `${file}: role`).not.toBe('slotlock');
    for (const { file, value } of passwords) {
      expect(value, `${file}: password`).not.toMatch(/slot|lock/i);
      expect(
        value.length,
        `${file}: password ${value} is short enough to occur in output`,
      ).toBeGreaterThanOrEqual(12);
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
const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

describe.skipIf(!hasJq)('release tag check', () => {
  function release(changelogDate = '2026-10-09') {
    const repo = repository();
    mkdirSync(join(repo.cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo.cwd, '.github', 'workflows', 'tag-release.yml'), 'name: Tag release\n');
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
  /** Commits a change on main and moves origin/main to it. */
  function merge(repo: ReturnType<typeof release>, message: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.cwd, path)), { recursive: true });
      writeFileSync(join(repo.cwd, path), text);
    }
    repo.git('add', '.');
    const commit = repo.commit(message);
    repo.git('update-ref', 'refs/remotes/origin/main', commit);
    return commit;
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

  it('refuses a checkout that is not the commit the tag names', () => {
    // A run on a branch called v1.2.3 checks out the branch while the tag sits on main.
    const repo = release();
    const tagged = repo.git('rev-parse', 'HEAD');
    repo.git('tag', 'v1.2.3');
    repo.git('checkout', '--quiet', '-b', 'v1.2.3-branch');
    const branch = repo.commit('not what the tag names');
    const result = repo.script('check-release-tag.sh', 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The checkout is ${branch}, not ${tagged}`);
  });

  it('checks a commit before its tag exists, as tag-release.yml does', () => {
    const repo = release();
    const head = repo.git('rev-parse', 'HEAD');
    const result = repo.script('check-release-tag.sh', 'v1.2.3', '--commit', head);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${head} is on main`);
  });

  it('refuses a commit that is not on main before it is tagged', () => {
    const repo = release();
    repo.git('checkout', '--quiet', '-b', 'side');
    const side = repo.commit('unmerged');
    const result = repo.script('check-release-tag.sh', 'v1.2.3', '--commit', side);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Commit ${side} is not on main`);
  });

  it('reads the files of the commit it checks, not of the checkout', () => {
    const repo = release();
    const released = repo.git('rev-parse', 'HEAD');
    merge(repo, 'start 1.2.4', {
      'package.json': JSON.stringify({ version: '1.2.4' }),
      'server.json': JSON.stringify({ version: '1.2.4', packages: [] }),
    });
    const result = repo.script('check-release-tag.sh', 'v1.2.3', '--commit', released);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('takes the commit to check from its arguments only', () => {
    // An inherited rev must not switch it to --commit mode, which skips the tag and checkout checks.
    const repo = release();
    const result = spawnSync('sh', [join(root, 'scripts', 'check-release-tag.sh'), 'v1.2.3'], {
      cwd: repo.cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        rev: repo.git('rev-parse', 'HEAD'),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Tag v1.2.3 does not exist');
  });

  describe('release planning', () => {
    const plan = (repo: ReturnType<typeof release>) =>
      repo.script('plan-release.sh', repo.git('rev-parse', 'HEAD'));

    it('releases a dated version that has no tag yet, on the commit that dated it', () => {
      const repo = release();
      const result = plan(repo);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `tag=v1.2.3\ncommit=${repo.git('rev-parse', 'HEAD')}\nrelease=true\n`,
      );
    });

    it('tags the release commit, not a later merge, when the first run never ran', () => {
      // GitHub keeps one pending run per concurrency group and drops the older one.
      const repo = release();
      const released = repo.git('rev-parse', 'HEAD');
      merge(repo, 'a later fix', { 'README.md': 'later\n' });
      const result = plan(repo);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`tag=v1.2.3\ncommit=${released}\nrelease=true\n`);
    });

    it('tags a version dated before tag-release.yml existed where tag-release.yml arrived', () => {
      // A tag push runs the tagged commit's workflows; an older commit would release with old ones.
      const repo = release();
      repo.git('rm', '--quiet', '-r', '.github');
      const undated = repo.commit('the automation is not here yet');
      repo.git('update-ref', 'refs/remotes/origin/main', undated);
      const arrived = merge(repo, 'add tag-release.yml', {
        '.github/workflows/tag-release.yml': 'name: Tag release\n',
      });
      merge(repo, 'a later fix', { 'README.md': 'later\n' });
      const result = plan(repo);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`tag=v1.2.3\ncommit=${arrived}\nrelease=true\n`);
    });

    it('starts the release where the version became ready again', () => {
      const repo = release();
      merge(repo, 'undate 1.2.3', { 'CHANGELOG.md': '# Changelog\n\n## 1.2.3 - Unreleased\n' });
      const redated = merge(repo, 'date 1.2.3 again', {
        'CHANGELOG.md': '# Changelog\n\n## 1.2.3 - 2026-10-10\n',
      });
      const result = plan(repo);
      expect(result.stdout).toBe(`tag=v1.2.3\ncommit=${redated}\nrelease=true\n`);
    });

    it('skips a version that is already tagged on main', () => {
      const repo = release();
      repo.git('tag', 'v1.2.3');
      const result = plan(repo);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `tag=v1.2.3\ncommit=${repo.git('rev-parse', 'HEAD')}\nrelease=false\n`,
      );
      expect(result.stderr).toContain('v1.2.3 already exists');
    });

    it('fails when the version is tagged on a commit that is not on main', () => {
      const repo = release();
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.commit('unmerged');
      repo.git('tag', 'v1.2.3');
      repo.git('checkout', '--quiet', 'main');
      const result = plan(repo);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('release=');
      expect(result.stderr).toContain('which is not on main');
    });

    it('skips a version whose CHANGELOG heading is not dated yet', () => {
      const result = plan(release('Unreleased'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('tag=v1.2.3\nrelease=false\n');
      expect(result.stderr).toContain('does not date 1.2.3 yet');
    });

    it('fails a dated version that fails a release check instead of skipping it', () => {
      const repo = release();
      // The release commit itself leaves server.json at the previous version.
      writeFileSync(
        join(repo.cwd, 'server.json'),
        JSON.stringify({
          version: '1.2.2',
          packages: [{ identifier: 'ghcr.io/pilotaai/slotlock:1.2.2' }],
        }),
      );
      repo.git('add', '.');
      repo.git('commit', '--quiet', '--amend', '--no-edit');
      repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const result = plan(repo);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('release=true');
      expect(result.stderr).toContain('server.json version is not 1.2.3');
    });

    it('fails a dated version on a commit that is not on main', () => {
      const repo = release();
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.commit('unmerged');
      const result = plan(repo);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('release=true');
      expect(result.stderr).toContain('is not on main');
    });
  });
});

describe('release automation', () => {
  const workflow = (file: string) => read(join('.github', 'workflows', file));

  it('tags a merged version on main with the deploy key that only main can read', () => {
    const text = workflow('tag-release.yml');
    expect(text).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m);
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toContain('environment: release-tag');
    // The deploy key pushes the tag; GITHUB_TOKEN gets no write permission here.
    expect(text).toMatch(/ {4}permissions:\n {6}contents: read\n {4}steps:/);
    expect(text).not.toMatch(/(?:contents|actions): write/);
    expect(text).toContain('ssh-key: ${{ secrets.TAG_RELEASE_DEPLOY_KEY }}');
    expect(text).toContain('scripts/plan-release.sh "$GITHUB_SHA" >> "$GITHUB_OUTPUT"');
    expect(text).toContain('COMMIT: ${{ steps.plan.outputs.commit }}');
    expect(text).toContain('tag -a "$TAG" -m "Slotlock ${TAG#v}" "$COMMIT"');
    expect(text).toContain('git push "git@github.com:$GITHUB_REPOSITORY.git" "refs/tags/$TAG"');
    expect(text).not.toContain('gh workflow run');
  });

  it('starts the release workflows only from a pushed v* tag', () => {
    for (const file of ['release.yml', 'image.yml']) {
      const text = workflow(file);
      expect(text, file).toMatch(/^on:\n {2}push:\n {4}tags: \['v\*'\]\n\n/m);
      expect(text, file).not.toContain('workflow_dispatch');
      expect(text, file).toContain('run: scripts/check-release-tag.sh "$GITHUB_REF_NAME"');
    }
  });

  it('only stages on npm, and asks for the bootstrap when npm refuses the credential', () => {
    const text = workflow('release.yml');
    const stage = text.slice(text.indexOf('\n  stage:\n'), text.indexOf('\n  github-release:\n'));
    expect(stage).toContain('environment: npm');
    expect(stage).toContain('id-token: write');
    expect(stage).toContain('npm stage publish "./$TARBALL" --provenance --access public');
    expect(stage).toContain("grep -Eq 'ENEEDAUTH|E401' stage.log");
    expect(stage).toContain('scripts/bootstrap-release.sh $GITHUB_REF_NAME');
    // GOVERNANCE.md, Releases: a maintainer approves each version with two-factor authentication.
    for (const { file, text: body } of workflows) {
      expect(body, file).not.toMatch(/npm (?:publish|dist-tag)\b/);
    }
  });

  it('names only scripts that exist', () => {
    let count = 0;
    for (const { file, text } of workflows) {
      for (const [path] of text.matchAll(/scripts\/[\w.-]+\.(?:sh|mjs)/g)) {
        count += 1;
        expect(existsSync(join(root, path)), `${file}: ${path}`).toBe(true);
      }
    }
    expect(count, 'canary: the workflows name their scripts').toBeGreaterThanOrEqual(8);
  });
});

interface GitHubRequest {
  method: string;
  path: string;
  body: {
    target?: string;
    reviewers?: unknown[];
    rules?: { type: string }[];
    bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
    conditions?: { ref_name: { include: string[] } };
    title?: string;
    key?: string;
    read_only?: boolean;
    default_workflow_permissions?: string;
    can_approve_pull_request_reviews?: boolean;
  };
}

describe.skipIf(!hasJq)('GitHub configuration', () => {
  const script = join(root, 'scripts', 'configure-github.sh');

  function dryRun(...args: string[]): GitHubRequest[] {
    const result = spawnSync('bash', [script, '--dry-run', ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SKIP_SITE_SECRETS: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    return [...result.stdout.matchAll(/^> (PUT|POST) \/(\S+)\n(\{[\s\S]*?\n\})$/gm)].map(
      ([, method = '', path = '', body = '']) => ({
        method,
        path,
        body: JSON.parse(body) as GitHubRequest['body'],
      }),
    );
  }
  const environment = (requests: GitHubRequest[], name: string) =>
    requests.find(
      (request) =>
        request.method === 'PUT' && request.path === `repos/PILOTAAI/slotlock/environments/${name}`,
    )?.body;

  it('lets only admins and deploy keys create release tags, and only admins move or delete them', () => {
    const tags = dryRun().find(
      (request) => request.path.endsWith('/rulesets') && request.body.target === 'tag',
    )?.body;
    expect(tags?.conditions?.ref_name.include).toEqual(['refs/tags/v*']);
    expect(tags?.rules?.map((rule) => rule.type).sort()).toEqual([
      'creation',
      'deletion',
      'update',
    ]);
    expect(tags?.bypass_actors).toEqual([
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' },
    ]);
  });

  it('keeps the tag deploy key in an environment only main can use', () => {
    const requests = dryRun();
    expect(environment(requests, 'release-tag')?.reviewers).toEqual([]);
    const policy = requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path ===
          'repos/PILOTAAI/slotlock/environments/release-tag/deployment-branch-policies',
    )?.body;
    expect(policy).toEqual({ name: 'main', type: 'branch' });
    const key = requests.find((request) => request.path === 'repos/PILOTAAI/slotlock/keys')?.body;
    expect(key).toMatchObject({ title: 'slotlock tag-release (GitHub Actions)', read_only: false });
  });

  it('keeps the release app in an environment only main can use, with no reviewer', () => {
    const requests = dryRun();
    expect(environment(requests, 'release-app')?.reviewers).toEqual([]);
    const policy = requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path ===
          'repos/PILOTAAI/slotlock/environments/release-app/deployment-branch-policies',
    )?.body;
    expect(policy).toEqual({ name: 'main', type: 'branch' });
  });

  it('makes a release wait for no reviewer unless asked to', () => {
    const plain = dryRun();
    expect(environment(plain, 'npm')?.reviewers).toEqual([]);
    expect(environment(plain, 'mcp-registry')?.reviewers).toEqual([]);
    const approved = dryRun('--require-approval');
    expect(environment(approved, 'npm')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
    expect(environment(approved, 'mcp-registry')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
  });

  // A stand-in for gh that answers every request configure-github.sh sends, logs each one, and
  // keeps the deploy key it is sent and the secret value it receives on stdin. With
  // STUB_WORKFLOW_PERMISSIONS set, it refuses the Actions workflow permissions with that message,
  // as GitHub does (409) when the organization holds the setting.
  const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG/gh.log"
case "$1 $2" in
  'secret set') cat > "$STUB_LOG/secret-$3"; ls "$TMPDIR" > "$STUB_LOG/tmpdir-while-storing"; exit 0 ;;
esac
case "$*" in
  *'--jq .id') echo 42; exit 0 ;;
  *'--jq .login') echo ada; exit 0 ;;
esac
method=GET
previous=''
for arg; do
  [ "$previous" = --method ] && method=$arg
  previous=$arg
  path=$arg
done
if [ "$method" != GET ]; then
  case " $* " in *' --input - '*) body=$(cat) ;; *) body='' ;; esac
  if [ "$method $path" = 'PUT repos/PILOTAAI/slotlock/actions/permissions/workflow' ] && [ -n "$STUB_WORKFLOW_PERMISSIONS" ]; then
    echo "$STUB_WORKFLOW_PERMISSIONS" >&2
    exit 1
  fi
  [ "$method $path" = 'POST repos/PILOTAAI/slotlock/keys' ] && printf '%s' "$body" > "$STUB_LOG/key.json"
  echo '{"id":1}'
  exit 0
fi
case "$path" in
  repos/PILOTAAI/slotlock) echo '{"permissions":{"admin":true},"visibility":"public","default_branch":"main"}' ;;
  */code-scanning/default-setup) echo '{"state":"configured","languages":["actions","javascript-typescript"],"query_suite":"extended"}' ;;
  */deployment-branch-policies*) echo '{"branch_policies":[]}' ;;
  */environments/release-tag/secrets*) echo "$STUB_SECRETS" ;;
  repos/PILOTAAI/slotlock/keys*) echo "$STUB_KEYS" ;;
  */rulesets\\?*) echo '[]' ;;
  *) echo '{}' ;;
esac
`;

  function configure(
    scenario: { keys: string; secrets: string; workflowPermissions?: string },
    ...args: string[]
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-configure-'));
    scratch.push(dir);
    const bin = join(dir, 'bin');
    const log = join(dir, 'log');
    const temp = join(dir, 'tmp');
    for (const path of [bin, log, temp]) mkdirSync(path);
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TMPDIR: temp,
        SKIP_SITE_SECRETS: '1',
        STUB_LOG: log,
        STUB_KEYS: scenario.keys,
        STUB_SECRETS: scenario.secrets,
        STUB_WORKFLOW_PERMISSIONS: scenario.workflowPermissions ?? '',
      },
    });
    const calls = readFileSync(join(log, 'gh.log'), 'utf8').trim().split('\n');
    return { ...result, dir, log, temp, calls };
  }
  const none = { keys: '[]', secrets: '{"secrets":[]}' };
  const present = {
    keys: '[{"id":7,"title":"slotlock tag-release (GitHub Actions)"}]',
    secrets: '{"secrets":[{"name":"TAG_RELEASE_DEPLOY_KEY"}]}',
  };

  it('lets GitHub Actions open pull requests, with GITHUB_TOKEN read-only by default', () => {
    const permissions = dryRun().find(
      (request) =>
        request.method === 'PUT' &&
        request.path === 'repos/PILOTAAI/slotlock/actions/permissions/workflow',
    )?.body;
    expect(permissions).toEqual({
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: true,
    });
  });

  it.skipIf(!hasSshKeygen)(
    'carries on when the organization holds that setting, and says where to change it',
    () => {
      const page = 'https://github.com/organizations/PILOTAAI/settings/actions';
      const allowed = configure(present);
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain('may open pull requests');
      expect(allowed.stdout).not.toContain(page);
      const held = configure({ ...present, workflowPermissions: 'gh: Conflict (HTTP 409)' });
      expect(held.status, held.stderr).toBe(0);
      expect(held.stderr).toContain('refused to let Actions open pull requests: gh: Conflict');
      expect(held.stdout).toContain(page);
      // The steps after it still ran.
      expect(held.stdout).toContain('6. Left for you to do by hand');
    },
  );

  describe.skipIf(!hasSshKeygen)('the tag deploy key', () => {
    it('sends GitHub the public half and the environment the private half, and keeps neither', () => {
      const run = configure(none);
      expect(run.status, run.stderr).toBe(0);
      const sent = JSON.parse(readFileSync(join(run.log, 'key.json'), 'utf8')) as {
        title: string;
        key: string;
        read_only: boolean;
      };
      expect(sent.read_only).toBe(false);
      expect(sent.key).toMatch(/^ssh-ed25519 \S+ slotlock tag-release \(GitHub Actions\)$/);
      const secret = join(run.log, 'secret-TAG_RELEASE_DEPLOY_KEY');
      expect(readFileSync(secret, 'utf8')).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
      expect(run.calls).toContain(
        'secret set TAG_RELEASE_DEPLOY_KEY --env release-tag --repo PILOTAAI/slotlock',
      );
      // The secret is the private half of the key GitHub was sent.
      chmodSync(secret, 0o600);
      const derived = execFileSync('ssh-keygen', ['-y', '-f', secret], { encoding: 'utf8' });
      expect(sent.key.split(' ').slice(0, 2)).toEqual(derived.trim().split(' ').slice(0, 2));
      // Nothing of it is printed or left behind. Canary: the key was made in this TMPDIR.
      expect(run.stdout + run.stderr).not.toContain('PRIVATE KEY');
      expect(readFileSync(join(run.log, 'tmpdir-while-storing'), 'utf8')).toMatch(
        /^slotlock-tag-key\.\w+\n$/,
      );
      expect(readdirSync(run.temp)).toEqual([]);
    });

    it('leaves a key and secret that are already there', () => {
      const run = configure(present);
      expect(run.status, run.stderr).toBe(0);
      expect(run.calls.filter((call) => call.startsWith('secret set'))).toEqual([]);
      expect(run.calls.some((call) => / repos\/PILOTAAI\/slotlock\/keys$/.test(call))).toBe(false);
      expect(run.stdout).toContain('already set (--rotate-tag-key replaces them)');
    });

    it('replaces the key on --rotate-tag-key, adding the new one before deleting the old', () => {
      const run = configure(present, '--rotate-tag-key');
      expect(run.status, run.stderr).toBe(0);
      const added = run.calls.findIndex(
        (call) =>
          call.startsWith('api --method POST') && call.endsWith(' repos/PILOTAAI/slotlock/keys'),
      );
      const stored = run.calls.findIndex((call) => call.startsWith('secret set'));
      const deleted = run.calls.findIndex(
        (call) =>
          call.startsWith('api --method DELETE') &&
          call.endsWith(' repos/PILOTAAI/slotlock/keys/7'),
      );
      expect(added).toBeGreaterThanOrEqual(0);
      expect(stored).toBeGreaterThan(added);
      expect(deleted).toBeGreaterThan(stored);
      expect(readdirSync(run.temp)).toEqual([]);
    });
  });
});

describe.skipIf(!hasJq)('release bootstrap', () => {
  const tagCommit = 'a'.repeat(40);
  const run = (id: number, sha = tagCommit) => ({
    databaseId: id,
    status: 'completed',
    conclusion: 'failure',
    headSha: sha,
    event: 'push',
  });
  // Stand-ins for npm, gh and curl: each logs its arguments and answers as the scenario says.
  const stubs: Record<string, string> = {
    npm: `case "$*" in
  --version) echo "$STUB_NPM_VERSION" ;;
  'view slotlock@1.2.3 version') [ "$STUB_VERSION_ON_NPM" = 1 ] && echo 1.2.3 || exit 1 ;;
  'view slotlock version') [ "$STUB_PACKAGE_ON_NPM" = 1 ] && echo 1.2.2 || exit 1 ;;
  whoami) echo ada ;;
  'stage list slotlock') printf '%s' "$STUB_STAGED" ;;
  'stage publish '*) echo '+ slotlock@1.2.3 (staged with id stage-1)' ;;
  'stage approve stage-1') ;;
  'trust list slotlock --json') printf '%s' "$STUB_TRUST"; exit "\${STUB_TRUST_STATUS:-0}" ;;
  'trust github '*) ;;
  *) echo "unexpected: npm $*" >&2; exit 99 ;;
esac`,
    gh: `case "$*" in
  'api -H Accept: application/vnd.github.raw+json repos/PILOTAAI/slotlock/contents/package.json?ref=main')
    echo '{"version":"1.2.3"}' ;;
  'api repos/PILOTAAI/slotlock/environments/release-tag/secrets '*)
    if [ "$STUB_CONFIGURED" = 1 ] || [ -f "$STUB_LOG/configured" ]; then echo '["TAG_RELEASE_DEPLOY_KEY"]'; else echo '[]'; fi ;;
  'api repos/PILOTAAI/slotlock/rulesets?'*) echo 7 ;;
  'api repos/PILOTAAI/slotlock/rulesets/7 '*) echo true ;;
  'api repos/PILOTAAI/slotlock/commits/main --jq .sha') echo "$STUB_MAIN_COMMIT" ;;
  'api repos/PILOTAAI/slotlock/git/ref/tags/v1.2.3 '*)
    if [ "$STUB_TAG_PUSHED" != 1 ] && [ ! -f "$STUB_LOG/tagged" ]; then exit 1; fi
    if [ "$STUB_TAG_TYPE" = commit ]; then echo "commit $STUB_TAG_COMMIT"; else echo "tag 7a6"; fi ;;
  'api repos/PILOTAAI/slotlock/git/tags/7a6 '*) echo "commit $STUB_TAG_COMMIT" ;;
  'run list '*'--workflow tag-release.yml '*) echo "$STUB_TAG_RUNS" ;;
  'run list '*'--workflow release.yml '*) [ "$STUB_GH_FAILS" = 1 ] && exit 1; echo "$STUB_RELEASE_RUNS" ;;
  'run list '*'--workflow image.yml '*) echo "$STUB_IMAGE_RUNS" ;;
  'run download '*) for last; do :; done; cp "$STUB_ARTIFACT"/* "$last" ;;
  'run view '*'--json attempt'*)
    if [ -f "$STUB_LOG/rerun-$3" ] && [ "$STUB_NO_NEW_ATTEMPT" != 1 ]; then echo 2; else echo 1; fi ;;
  'run view 22 '*) echo "$STUB_IMAGE_JOB" ;;
  'run rerun '*)
    touch "$STUB_LOG/rerun-$3"
    if [ "$3" = 5 ] && [ "$STUB_RERUN_TAGS" = 1 ]; then touch "$STUB_LOG/tagged"; fi ;;
  'run watch '*) ;;
  'workflow run '*) ;;
  *) echo "unexpected: gh $*" >&2; exit 99 ;;
esac`,
    curl: `case "$*" in
  *ghcr.io/token*) [ "$STUB_IMAGE_PUBLIC" = 1 ] && echo '{"token":"anonymous"}' || exit 22 ;;
  *ghcr.io/v2/*) [ "$STUB_IMAGE_PUBLIC" = 1 ] || exit 22 ;;
  *) echo "unexpected: curl $*" >&2; exit 99 ;;
esac`,
  };

  function bootstrap(scenario: Record<string, string>, checksum?: string, args = ['v1.2.3']) {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-bootstrap-'));
    scratch.push(dir);
    const bin = join(dir, 'bin');
    const artifact = join(dir, 'artifact');
    const log = join(dir, 'log');
    for (const path of [bin, artifact, log, join(dir, 'package')]) mkdirSync(path);
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$STUB_LOG/${name}.log"\n${body}\n`,
        { mode: 0o755 },
      );
    }
    // A stand-in for configure-github.sh: it records how it was run, and sets GitHub up when asked.
    const configure = join(bin, 'configure-github.sh');
    writeFileSync(
      configure,
      `#!/bin/sh\necho "SKIP_SITE_SECRETS=$SKIP_SITE_SECRETS" >> "$STUB_LOG/configure.log"\n[ "$STUB_CONFIGURE_WORKS" = 1 ] && touch "$STUB_LOG/configured"\nexit 0\n`,
      { mode: 0o755 },
    );
    // The npm-package artifact a Release run uploads: the tarball and its SHA256SUMS.
    writeFileSync(
      join(dir, 'package', 'package.json'),
      JSON.stringify({ name: 'slotlock', version: '1.2.3' }),
    );
    const tarball = join(artifact, 'slotlock-1.2.3.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const sum = checksum ?? createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(join(artifact, 'SHA256SUMS'), `${sum}  slotlock-1.2.3.tgz\n`);
    const result = spawnSync('bash', [join(root, 'scripts', 'bootstrap-release.sh'), ...args], {
      encoding: 'utf8',
      input: '',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SLOTLOCK_CONFIGURE_GITHUB: configure,
        SLOTLOCK_POLL_SECONDS: '0',
        STUB_LOG: log,
        STUB_CONFIGURED: '1',
        STUB_CONFIGURE_WORKS: '1',
        STUB_TAG_PUSHED: '1',
        STUB_MAIN_COMMIT: 'c'.repeat(40),
        STUB_TAG_RUNS: '[]',
        STUB_ARTIFACT: artifact,
        STUB_NPM_VERSION: '11.19.0',
        STUB_TAG_COMMIT: tagCommit,
        STUB_RELEASE_RUNS: JSON.stringify([run(11)]),
        STUB_IMAGE_RUNS: JSON.stringify([run(22)]),
        STUB_IMAGE_PUBLIC: '1',
        STUB_IMAGE_JOB: 'success',
        STUB_STAGED: '',
        STUB_TRUST: '',
        ...scenario,
      },
    });
    const calls = (name: string) =>
      existsSync(join(log, `${name}.log`))
        ? readFileSync(join(log, `${name}.log`), 'utf8')
            .trim()
            .split('\n')
        : [];
    return { ...result, npm: calls('npm'), gh: calls('gh'), configure: calls('configure') };
  }
  const tagRun = (conclusion: string) =>
    JSON.stringify([{ databaseId: 5, status: 'completed', conclusion, headSha: 'c'.repeat(40) }]);

  it('sets GitHub up first when tag-release.yml has no deploy key, without asking for site secrets', () => {
    const result = bootstrap({ STUB_CONFIGURED: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.configure).toEqual(['SKIP_SITE_SECRETS=1']);
    expect(result.npm).toContain('stage approve stage-1');
  });

  it('leaves GitHub alone when tag-release.yml is already set up', () => {
    const result = bootstrap({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.configure).toEqual([]);
  });

  it('stops when configure-github.sh leaves the deploy key missing', () => {
    const result = bootstrap({ STUB_CONFIGURED: '0', STUB_CONFIGURE_WORKS: '0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the deploy key or the ruleset bypass is still missing');
    expect(result.npm.filter((call) => /^(?:stage|trust) /.test(call))).toEqual([]);
  });

  it("pushes the tag by re-running main's failed Tag release run, then finishes the release", () => {
    const result = bootstrap({
      STUB_TAG_PUSHED: '0',
      STUB_TAG_RUNS: tagRun('failure'),
      STUB_RERUN_TAGS: '1',
    });
    expect(result.status, result.stderr).toBe(0);
    const rerunAt = result.gh.indexOf(rerun(5));
    // Right after a re-run GitHub still shows the finished attempt: it waits for the next one first.
    const attemptAt = result.gh.findIndex(
      (call, index) => index > rerunAt && call.startsWith('run view 5 ') && call.includes('--json attempt'),
    );
    const watchAt = result.gh.findIndex((call) => call.startsWith('run watch 5 '));
    expect(rerunAt).toBeGreaterThanOrEqual(0);
    expect(attemptAt).toBeGreaterThan(rerunAt);
    expect(watchAt).toBeGreaterThan(attemptAt);
    expect(result.stdout).toContain('Tag release run 5: attempt 2 started');
    expect(result.gh).toContainEqual(download(11));
    expect(result.npm).toContain('stage approve stage-1');
  });

  it('stops when GitHub never starts the new attempt of a re-run', () => {
    const result = bootstrap({
      STUB_TAG_PUSHED: '0',
      STUB_TAG_RUNS: tagRun('failure'),
      STUB_NO_NEW_ATTEMPT: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub did not start a new attempt of Tag release run 5');
    expect(result.gh.filter((call) => call.startsWith('run watch'))).toEqual([]);
  });

  it('resolves an annotated tag to the commit it names, and a lightweight one too', () => {
    for (const type of ['tag', 'commit']) {
      const result = bootstrap({ STUB_TAG_TYPE: type });
      expect(result.status, `${type}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`v1.2.3 names ${tagCommit}`);
      expect(result.gh.some((call) => call.startsWith('api repos/PILOTAAI/slotlock/git/tags/'))).toBe(
        type === 'tag',
      );
    }
  });

  it('starts Tag release when main has no run of it yet', () => {
    const result = bootstrap({ STUB_TAG_PUSHED: '0' });
    expect(result.gh).toContain('workflow run tag-release.yml --repo PILOTAAI/slotlock --ref main');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no Tag release run started for main');
  });

  it('stops when Tag release passed without pushing the tag', () => {
    const result = bootstrap({ STUB_TAG_PUSHED: '0', STUB_TAG_RUNS: tagRun('success') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('passed without pushing v1.2.3');
    expect(result.npm.filter((call) => /^(?:stage|trust) /.test(call))).toEqual([]);
  });

  it("releases main's version when no tag is given", () => {
    const result = bootstrap({}, undefined, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.gh[0]).toBe(
      'api -H Accept: application/vnd.github.raw+json repos/PILOTAAI/slotlock/contents/package.json?ref=main',
    );
    expect(result.stdout).toContain('Release v1.2.3');
    expect(result.npm).toContain('stage approve stage-1');
  });
  const rerun = (id: number) => `run rerun ${id} --failed --repo PILOTAAI/slotlock`;
  const download = (id: number) =>
    expect.stringMatching(
      new RegExp(`^run download ${id} --repo PILOTAAI/slotlock --name npm-package --dir `),
    );

  it('puts the first version on npm from the tested tarball, with no trusted publisher yet', () => {
    const result = bootstrap({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.gh).toContainEqual(download(11));
    expect(result.npm).toContainEqual(
      expect.stringMatching(
        /^stage publish \S+\/slotlock-1\.2\.3\.tgz --access public --tag latest --provenance=false$/,
      ),
    );
    expect(result.npm).toContain('stage approve stage-1');
    // npm expires a trusted publisher that has not published within 2 days.
    expect(result.npm.filter((call) => call.startsWith('trust '))).toEqual([]);
    expect(result.gh).toContain(rerun(11));
    expect(result.gh).toContain(rerun(22));
  });

  it("uses only the run the tag's push started on the tag's commit", () => {
    // Newest first: a run on another commit, as a branch named v1.2.3 would start, comes first.
    const result = bootstrap({
      STUB_RELEASE_RUNS: JSON.stringify([run(33, 'b'.repeat(40)), run(11)]),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.gh).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^run list --repo PILOTAAI/slotlock --workflow release\\.yml --branch v1\\.2\\.3 --commit ${tagCommit} --event push `,
        ),
      ),
    );
    expect(result.gh).toContainEqual(download(11));
    expect(result.gh).not.toContainEqual(download(33));
    expect(result.gh).not.toContain(rerun(33));
  });

  it('stops when gh cannot list the runs instead of finding none', () => {
    const result = bootstrap({ STUB_GH_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh could not list the release.yml runs for v1.2.3');
    expect(result.npm.filter((call) => /^(?:stage|trust) /.test(call))).toEqual([]);
  });

  it('stops when the tag is not on GitHub', () => {
    const result = bootstrap({ STUB_TAG_COMMIT: '' });
    expect(result.status).toBe(1);
    expect(result.gh.filter((call) => call.startsWith('run '))).toEqual([]);
  });

  it('creates the stage-only trusted publisher when a later version is waiting', () => {
    const result = bootstrap({ STUB_PACKAGE_ON_NPM: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.npm).toContain(
      'trust github slotlock --file release.yml --repository PILOTAAI/slotlock --environment npm --allow-stage-publish',
    );
    expect(result.npm.filter((call) => call.startsWith('stage '))).toEqual([]);
    expect(result.gh).toContain(rerun(11));
  });

  it('leaves a trusted publisher that exists', () => {
    const result = bootstrap({ STUB_PACKAGE_ON_NPM: '1', STUB_TRUST: '[{"id":"tp-1"}]' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.npm.filter((call) => call.startsWith('trust github'))).toEqual([]);
    expect(result.stdout).toContain('already has a trusted publisher');
  });

  it('stops when npm cannot list the trusted publishers instead of assuming one', () => {
    // npm prints {"error": ...} on stdout with --json when it fails.
    const failed = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_TRUST: '{"error":{"code":"ECONNREFUSED"}}',
      STUB_TRUST_STATUS: '1',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('npm trust list slotlock failed');
    expect(failed.npm.filter((call) => call.startsWith('trust github'))).toEqual([]);
    const errorOnly = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_TRUST: '{"error":{"code":"EOTP"}}',
    });
    expect(errorOnly.status).toBe(1);
    expect(errorOnly.stderr).toContain('EOTP');
  });

  it('stages the version when only a prerelease of it is staged', () => {
    const result = bootstrap({ STUB_STAGED: 'stage-0  slotlock@1.2.3-rc.1\n' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.npm).toContainEqual(expect.stringMatching(/^stage publish /));
  });

  it('leaves npm alone for a version already there', () => {
    const result = bootstrap({ STUB_PACKAGE_ON_NPM: '1', STUB_VERSION_ON_NPM: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.npm.filter((call) => /^(?:stage|trust|publish) /.test(call))).toEqual([]);
  });

  it("refuses a tarball that does not match its run's checksum", () => {
    const result = bootstrap({}, '0'.repeat(64));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its SHA256SUMS');
    expect(result.npm.filter((call) => call.startsWith('stage '))).toEqual([]);
    expect(result.gh).not.toContain(rerun(11));
  });

  it('stops at a private image, naming the page that makes it public', () => {
    const result = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_VERSION_ON_NPM: '1',
      STUB_IMAGE_PUBLIC: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'https://github.com/orgs/PILOTAAI/packages/container/package/slotlock',
    );
    expect(result.stderr).toContain('stopped before the image was public');
    expect(result.gh).not.toContain(rerun(22));
  });

  it('re-runs an Image run whose image job failed, without asking about visibility', () => {
    const result = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_VERSION_ON_NPM: '1',
      STUB_IMAGE_PUBLIC: '0',
      STUB_IMAGE_JOB: 'failure',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('did not push the image');
    expect(result.gh).toContain(rerun(22));
  });

  it('refuses an npm older than the one it was run with', () => {
    for (const version of ['11.14.2', '11.16.0']) {
      const result = bootstrap({ STUB_NPM_VERSION: version });
      expect(result.status, version).toBe(1);
      expect(result.stderr).toContain(`npm ${version} is older than 11.17.0`);
      expect(result.gh).toEqual([]);
    }
  });
});
describe.skipIf(!hasJq)('release preparation', () => {
  const server = (version: string) =>
    `${JSON.stringify(
      {
        name: 'io.github.PILOTAAI/slotlock',
        version,
        packages: [{ registryType: 'oci', identifier: `ghcr.io/pilotaai/slotlock:${version}` }],
      },
      null,
      2,
    )}\n`;
  const changelog = (unreleased = '### Changed\n\n- Something users will notice.\n') =>
    `# Changelog\n\n## Unreleased\n\n${unreleased}\n## 1.2.3 - 2026-10-09\n\n- The last release.\n`;

  /** A repository with v1.2.3 tagged and every copy of the version at VERSION. */
  function project(files: Record<string, string> = {}, version = '1.2.3') {
    const repo = repository();
    const all: Record<string, string> = {
      'package.json': `${JSON.stringify({ name: 'slotlock', version }, null, 2)}\n`,
      'package-lock.json': `${JSON.stringify(
        {
          name: 'slotlock',
          version,
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'slotlock', version } },
        },
        null,
        2,
      )}\n`,
      'server.json': server(version),
      'slotlock.manifest.json': `${JSON.stringify({ name: 'slotlock', version, capabilities: [] }, null, 2)}\n`,
      'CHANGELOG.md': changelog(),
      ...files,
    };
    for (const [path, text] of Object.entries(all)) writeFileSync(join(repo.cwd, path), text);
    repo.git('add', '.');
    repo.commit('release 1.2.3');
    repo.git('tag', 'v1.2.3');
    return repo;
  }
  const contents = (repo: ReturnType<typeof project>, path: string) =>
    readFileSync(join(repo.cwd, path), 'utf8');
  const today = new Date().toISOString().slice(0, 10);

  it('moves every copy of the version and dates the Unreleased notes, changing nothing else', () => {
    const repo = project();
    const before = {
      server: contents(repo, 'server.json'),
      manifest: contents(repo, 'slotlock.manifest.json'),
      changelog: contents(repo, 'CHANGELOG.md'),
    };
    const result = repo.script('prepare-release.sh', '1.2.4');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(contents(repo, 'package.json')).version).toBe('1.2.4');
    const lock = JSON.parse(contents(repo, 'package-lock.json'));
    expect([lock.version, lock.packages[''].version]).toEqual(['1.2.4', '1.2.4']);
    // Byte for byte apart from the version: no reformatting rides along.
    expect(contents(repo, 'server.json')).toBe(before.server.replaceAll('1.2.3', '1.2.4'));
    expect(contents(repo, 'slotlock.manifest.json')).toBe(before.manifest.replace('1.2.3', '1.2.4'));
    expect(contents(repo, 'CHANGELOG.md')).toBe(
      before.changelog.replace('## Unreleased', `## 1.2.4 - ${today}`),
    );
    // And the result is a release check-release-tag.sh accepts.
    repo.git('add', '.');
    const released = repo.commit('Release 1.2.4');
    repo.git('update-ref', 'refs/remotes/origin/main', released);
    expect(repo.script('check-release-tag.sh', 'v1.2.4', '--commit', released).status).toBe(0);
  });

  it.each([
    ['1.2.4', true],
    ['1.3.0', true],
    ['2.0.0', true],
    ['1.2.10', true],
    ['1.2.3', false],
    ['1.2.2', false],
    ['1.1.9', false],
    ['1.2.3-rc.1', false],
  ])('from 1.2.3, %s is a later version: %s', (version, later) => {
    const result = project().script('prepare-release.sh', version);
    expect(result.status, result.stderr).toBe(later ? 0 : 1);
    if (!later)
      expect(result.stderr).toContain(`${version} is not later than package.json's 1.2.3`);
  });

  it('orders prereleases below their release and by name', () => {
    const prepare = (from: string, to: string) => project({}, from).script('prepare-release.sh', to);
    for (const [from, to, later] of [
      ['1.2.4-rc.1', '1.2.4', true],
      ['1.2.4-rc.1', '1.2.4-rc.2', true],
      ['1.2.4-rc.2', '1.2.4-rc.1', false],
      ['1.2.4', '1.2.4-rc.1', false],
    ] as const) {
      const result = prepare(from, to);
      expect(result.status, `${from} -> ${to}: ${result.stderr}`).toBe(later ? 0 : 1);
    }
  });

  it('refuses a version that is already tagged', () => {
    const result = project({}, '1.2.2').script('prepare-release.sh', '1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('v1.2.3 is already tagged');
  });

  it.each([
    [
      'no Unreleased section',
      '# Changelog\n\n## 1.2.3 - 2026-10-09\n',
      "has no '## Unreleased' section",
    ],
    ['an empty Unreleased section', changelog(''), "'## Unreleased' section is empty"],
    [
      'an Unreleased heading with only blank lines',
      changelog('\n\n'),
      "'## Unreleased' section is empty",
    ],
  ])('refuses %s, and changes no file', (_, text, message) => {
    const repo = project({ 'CHANGELOG.md': text });
    const result = repo.script('prepare-release.sh', '1.2.4');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('refuses a version with a leading v, or one that is not semver', () => {
    for (const version of ['v1.2.4', '1.2', '1.2.4.5', '1.2.4-']) {
      const repo = project();
      const result = repo.script('prepare-release.sh', version);
      expect(result.status, version).toBe(1);
      expect(repo.git('status', '--porcelain'), version).toBe('');
    }
  });
});

describe('release button', () => {
  const workflow = (file: string) => read(join('.github', 'workflows', file));

  it('runs only on demand, on main, with the version passed through the environment', () => {
    const text = workflow('release-version.yml');
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}version:\n/m);
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    // The input is data: it reaches the shell as an environment variable, never as script text.
    const inScripts = text
      .split('\n')
      .filter((line) => line.includes('${{ inputs.') && !/^\s+(?:VERSION|BRANCH): /.test(line));
    expect(inScripts).toEqual([]);
    expect(text).toContain('scripts/prepare-release.sh "$VERSION"');
  });

  it('waits for CI and DCO on the pull request, merges only after both, then starts Tag release', () => {
    const text = workflow('release-version.yml');
    const order = [
      'scripts/prepare-release.sh "$VERSION"',
      'scripts/open-release-pr.sh "$VERSION" >> "$GITHUB_ENV"',
      'scripts/wait-for-pr-checks.sh "$SHA" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/pull/$PR" ci.yml dco.yml',
      'gh pr merge "$PR" --squash --delete-branch',
      'gh workflow run tag-release.yml --ref main',
      // The merge starts no push workflow, and the site shows the version.
      'gh workflow run site.yml --ref main',
    ].map((line) => text.indexOf(line));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const permission of ['contents: write', 'pull-requests: write', 'actions: write']) {
      expect(text).toContain(permission);
    }
  });

  it('opens and merges as the release app once it is stored, and as GITHUB_TOKEN until then', () => {
    const text = workflow('release-version.yml');
    const step = (name: string) => {
      const start = text.indexOf(`- name: ${name}`);
      expect(start, name).toBeGreaterThan(0);
      const next = text.indexOf('\n      - ', start + 1);
      return text.slice(start, next === -1 ? undefined : next);
    };
    expect(text).toContain('\n    environment: release-app\n');
    const mint = step("Mint the release app's token");
    expect(mint).toContain("if: vars.RELEASE_APP_CLIENT_ID != ''");
    expect(mint).toContain('client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}');
    expect(mint).toContain('private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
    // Only what opening and merging the pull request needs.
    expect(mint.match(/permission-[a-z-]+: \w+/g)).toEqual([
      'permission-contents: write',
      'permission-pull-requests: write',
    ]);
    expect(text.indexOf("- name: Mint the release app's token")).toBeLessThan(
      text.indexOf('uses: actions/checkout@'),
    );
    const appOrGitHub = '${{ steps.app.outputs.token || github.token }}';
    expect(text).toContain(`token: ${appOrGitHub}`);
    for (const name of ['Push the release branch and open its pull request', 'Merge it']) {
      expect(step(name)).toContain(`GH_TOKEN: ${appOrGitHub}`);
    }
    // Reading workflow runs needs actions: read, which the app's token does not have.
    expect(step('Wait for CI and DCO on the pull request')).toContain(
      'GH_TOKEN: ${{ github.token }}',
    );
    // The app's merge is a push, which starts Tag release and Site; a GITHUB_TOKEN merge starts none.
    expect(step('Start Tag release and Site on main')).toContain(
      "if: steps.app.outputs.token == ''",
    );
    expect(step('Say what the merge starts')).toContain("if: steps.app.outputs.token != ''");
    expect(step('Say how to repair the release app')).toContain(
      "if: failure() && steps.app.outcome == 'failure'",
    );
    // Every step names the token it uses: none comes from the job.
    expect(text).not.toMatch(/^ {4}env:\n(?: {6}.*\n)* {6}GH_TOKEN:/m);
  });

  it('leaves CI and DCO to the pull request, whose own runs are the checks its merge needs', () => {
    // On the first real release (0.1.1, 2026-10-22), CI and DCO started with workflow_dispatch passed
    // at the release commit, and the pull request still had none of its required checks.
    const text = workflow('release-version.yml');
    expect(text).not.toMatch(/gh workflow run (?:ci|dco)\.yml/);
    for (const file of ['ci.yml', 'dco.yml']) {
      expect(workflow(file), file).toMatch(/^on:\n {2}pull_request:\n/m);
    }
    // The wait outlasts a person: GitHub-hosted runners stop a job at 360 minutes.
    expect(text).toContain('timeout-minutes: 360');
  });
});

describe('release pull request', () => {
  const bot = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
  const branch = 'release/v1.2.4';
  const files = [
    'package.json',
    'package-lock.json',
    'server.json',
    'slotlock.manifest.json',
    'CHANGELOG.md',
  ];
  // A stand-in for gh: pr list answers with the open pull request's number, or nothing; pr create
  // opens #52, or fails with STUB_CREATE_ERROR.
  const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG/gh.log"
case "$1 $2" in
  'pr list') if [ -f "$STUB_LOG/created" ]; then echo 52; else printf '%s' "$STUB_OPEN_PR"; fi ;;
  'pr create')
    if [ -n "$STUB_CREATE_ERROR" ]; then echo "$STUB_CREATE_ERROR" >&2; exit 1; fi
    touch "$STUB_LOG/created"
    echo https://github.com/PILOTAAI/slotlock/pull/52 ;;
  *) echo "unexpected: gh $*" >&2; exit 99 ;;
esac
`;

  // The real git, for a wrapper that stands in front of it.
  const realGit =
    (process.env.PATH ?? '')
      .split(':')
      .map((dir) => join(dir, 'git'))
      .find((path) => existsSync(path)) ?? 'git';

  /**
   * A checkout of main with an origin it pushes to, origin holding `leftover` (commits an earlier
   * run left on the release branch) and the working tree holding the prepared release of 1.2.4.
   */
  function checkout(leftover: { author: string; message: string }[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-release-pr-'));
    scratch.push(dir);
    const origin = join(dir, 'origin.git');
    const cwd = join(dir, 'work');
    const bin = join(dir, 'bin');
    const log = join(dir, 'log');
    for (const path of [cwd, bin, log]) mkdirSync(path);
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
    const base = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const env = { ...base, GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '--quiet', '--bare', '--initial-branch=main', origin);
    git('init', '--quiet', '--initial-branch=main');
    const write = (version: string) => {
      for (const file of files) writeFileSync(join(cwd, file), `${file} ${version}\n`);
    };
    write('1.2.3');
    git('add', '.');
    git('commit', '--quiet', '--author=Ada <ada@example.com>', '-m', 'Release 1.2.3');
    git('remote', 'add', 'origin', origin);
    git('push', '--quiet', 'origin', 'main');
    if (leftover.length > 0) {
      git('switch', '--quiet', '-c', 'leftover');
      for (const { author, message } of leftover) {
        git('commit', '--quiet', '--allow-empty', `--author=${author}`, '-m', message);
      }
      git('push', '--quiet', 'origin', `leftover:refs/heads/${branch}`);
      git('switch', '--quiet', 'main');
      git('branch', '--quiet', '-D', 'leftover');
    }
    git('fetch', '--quiet', 'origin');
    write('1.2.4');
    const remote = () => git('ls-remote', origin, `refs/heads/${branch}`).split('\t')[0] ?? '';
    const calls = () =>
      existsSync(join(log, 'gh.log')) ? readFileSync(join(log, 'gh.log'), 'utf8') : '';
    // The script runs as release-version.yml runs it: no committer in the environment.
    const run = (scenario: { openPr?: string; createError?: string } = {}) =>
      spawnSync('sh', [join(root, 'scripts', 'open-release-pr.sh'), '1.2.4'], {
        cwd,
        encoding: 'utf8',
        env: {
          ...base,
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'PILOTAAI/slotlock',
          GITHUB_RUN_ID: '9',
          STUB_LOG: log,
          STUB_OPEN_PR: scenario.openPr ?? '',
          STUB_CREATE_ERROR: scenario.createError ?? '',
        },
      });
    /** Another run: a fresh checkout of main, with the release prepared again. */
    const again = () => {
      git('switch', '--quiet', 'main');
      git('branch', '--quiet', '-D', branch);
      git('fetch', '--quiet', 'origin');
      write('1.2.4');
    };
    return { cwd, origin, bin, git, write, remote, calls, run, again };
  }

  it('commits the prepared release on its branch, pushes it and opens its pull request', () => {
    const repo = checkout();
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const tip = repo.remote();
    expect(result.stdout).toBe(`SHA=${tip}\nPR=52\n`);
    expect(repo.git('log', '-1', '--format=%an <%ae>%n%s%n%b', tip)).toBe(
      `${bot}\nRelease 1.2.4\nSigned-off-by: ${bot}`,
    );
    expect(repo.git('rev-parse', `${tip}^`)).toBe(repo.git('rev-parse', 'origin/main'));
    expect(repo.git('diff', '--name-only', `${tip}^`, tip).split('\n').sort()).toEqual(
      [...files].sort(),
    );
    expect(repo.calls()).toContain(
      `pr create --repo PILOTAAI/slotlock --base main --head ${branch} --title Release 1.2.4 --body`,
    );
  });

  it('replaces the branch an earlier run left, and reuses its open pull request', () => {
    const repo = checkout([{ author: bot, message: 'Release 1.2.4' }]);
    const left = repo.remote();
    const result = repo.run({ openPr: '41' });
    expect(result.status, result.stderr).toBe(0);
    const tip = repo.remote();
    expect(tip).not.toBe(left);
    expect(result.stdout).toBe(`SHA=${tip}\nPR=41\n`);
    expect(result.stderr).toContain(
      `::notice::Replacing ${branch}, which an earlier run left at ${left}.`,
    );
    expect(repo.calls()).not.toContain('pr create');
  });

  it.each([
    [
      'a commit someone else made',
      [{ author: 'Ada <ada@example.com>', message: 'Release 1.2.4' }],
    ],
    ["another version's release commit", [{ author: bot, message: 'Release 1.2.3' }]],
    [
      'a commit on top of a release commit',
      [
        { author: bot, message: 'Release 1.2.4' },
        { author: bot, message: 'Release 1.2.4' },
      ],
    ],
  ])('leaves a branch holding %s, and stops', (_, leftover) => {
    const repo = checkout(leftover);
    const left = repo.remote();
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `::error::${branch} holds commits this workflow did not make.`,
    );
    expect(result.stdout).toBe('');
    expect(repo.remote()).toBe(left);
    expect(repo.calls()).toBe('');
  });

  it.each([
    ['did not exist', []],
    ['held an earlier run', [{ author: bot, message: 'Release 1.2.4' }]],
  ])('never overwrites a push that lands after it looked, when the branch %s', (_, leftover) => {
    const repo = checkout(leftover);
    const intruder = repo.git('rev-parse', 'origin/main');
    // Another push lands as this one starts: after the script looked at the branch, before git
    // reads the remote's refs. (Moved any later, the server refuses even a forced push.)
    writeFileSync(
      join(repo.bin, 'git'),
      [
        '#!/bin/sh',
        `[ "$1" != push ] || "${realGit}" --git-dir="${repo.origin}" update-ref refs/heads/${branch} ${intruder}`,
        `exec "${realGit}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const result = repo.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(repo.remote()).toBe(intruder);
    expect(repo.calls()).toBe('');
  });

  it('names the setting when Actions may not open pull requests, and the next run uses its branch', () => {
    const repo = checkout();
    // The message the first real run got, on 2026-10-22.
    const refusal =
      'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)';
    const refused = repo.run({ createError: refusal });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain(refusal);
    expect(refused.stderr).toContain(
      '::error::GitHub Actions may not open pull requests in PILOTAAI/slotlock.',
    );
    expect(refused.stderr).toContain('https://github.com/PILOTAAI/slotlock/settings/actions');
    expect(refused.stderr).toContain('https://github.com/organizations/PILOTAAI/settings/actions');
    const left = repo.remote();
    expect(left).not.toBe('');
    // Another run, from a fresh checkout of main, once an admin has allowed it.
    repo.again();
    const allowed = repo.run();
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stderr).toContain(`::notice::Keeping ${branch} at ${left}`);
    expect(allowed.stdout).toBe(`SHA=${left}\nPR=52\n`);
  });

  it('keeps a branch that holds this same release, pushing nothing, so its checks still count', () => {
    const repo = checkout();
    expect(repo.run().status).toBe(0);
    const left = repo.remote();
    repo.again();
    // A git that refuses to push: keeping the branch must not need one.
    writeFileSync(
      join(repo.bin, 'git'),
      ['#!/bin/sh', '[ "$1" != push ] || exit 99', `exec "${realGit}" "$@"`, ''].join('\n'),
      { mode: 0o755 },
    );
    const result = repo.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`SHA=${left}\nPR=52\n`);
    expect(result.stderr).toContain(
      `::notice::Keeping ${branch} at ${left}: it already holds this release.`,
    );
    expect(repo.remote()).toBe(left);
    expect(repo.calls().match(/^pr create /gm)).toHaveLength(1);
  });

  it('replaces a branch with this release once main has moved on, even by an empty commit', () => {
    const repo = checkout();
    expect(repo.run().status).toBe(0);
    const left = repo.remote();
    // main moves on without changing a file: the release tree is the same, its parent is not.
    repo.git('switch', '--quiet', 'main');
    repo.git('commit', '--quiet', '--allow-empty', '--author=Ada <ada@example.com>', '-m', 'Docs');
    repo.git('push', '--quiet', 'origin', 'main');
    repo.again();
    const result = repo.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `::notice::Replacing ${branch}, which an earlier run left at ${left}.`,
    );
    const tip = repo.remote();
    expect(tip).not.toBe(left);
    expect(repo.git('rev-parse', `${tip}^`)).toBe(repo.git('rev-parse', 'origin/main'));
  });

  it('stops without that hint when opening the pull request fails for another reason', () => {
    const result = checkout().run({ createError: 'HTTP 502: Bad Gateway' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::Could not open the pull request for release/v1.2.4.');
    expect(result.stderr).not.toContain('settings/actions');
  });
});

describe.skipIf(!hasJq)('release checks wait', () => {
  const commit = 'c'.repeat(40);
  const url = 'https://github.com/PILOTAAI/slotlock/pull/53';
  // A stand-in for gh run list: each call answers with the next run JSON queued for its workflow (the
  // last one repeats), through the --jq filter the script passes, as gh does.
  const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG/gh.log"
workflow=''
filter=''
previous=''
for arg; do
  [ "$previous" = --workflow ] && workflow=$arg
  [ "$previous" = --jq ] && filter=$arg
  previous=$arg
done
queue="$STUB_LOG/runs-$workflow"
answer='[]'
if [ -s "$queue" ]; then
  answer=$(head -n 1 "$queue")
  if [ "$(wc -l < "$queue")" -gt 1 ]; then
    tail -n +2 "$queue" > "$queue.next"
    mv "$queue.next" "$queue"
  fi
fi
printf '%s' "$answer" | jq -r "$filter"
`;
  // Runs as gh run list --json databaseId,status,conclusion shows them. A run waiting for approval
  // reads completed / action_required, as GitHub showed the 0.1.1 release's on 2026-10-22.
  const run = (id: number, status: string, conclusion = '') =>
    JSON.stringify([{ databaseId: id, status, conclusion }]);
  const held = (id: number) => run(id, 'completed', 'action_required');
  const none = '[]';

  function wait(queues: Record<string, string[]>, minutes = '5') {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-wait-'));
    scratch.push(dir);
    const bin = join(dir, 'bin');
    const log = join(dir, 'log');
    for (const path of [bin, log]) mkdirSync(path);
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
    for (const [workflow, answers] of Object.entries(queues)) {
      writeFileSync(join(log, `runs-${workflow}`), `${answers.join('\n')}\n`);
    }
    const result = spawnSync(
      'sh',
      [join(root, 'scripts', 'wait-for-pr-checks.sh'), commit, url, ...Object.keys(queues)],
      {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          STUB_LOG: log,
          SLOTLOCK_POLL_SECONDS: '0',
          SLOTLOCK_WAIT_MINUTES: minutes,
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'PILOTAAI/slotlock',
        },
      },
    );
    const calls = readFileSync(join(log, 'gh.log'), 'utf8').trim().split('\n');
    return { ...result, calls };
  }

  it('waits through the approval and both runs, asking for the approval once', () => {
    const result = wait({
      'ci.yml': [
        held(1),
        held(1),
        run(1, 'queued'),
        run(1, 'in_progress'),
        run(1, 'completed', 'success'),
      ],
      'dco.yml': [none, held(2), run(3, 'completed', 'success')],
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const asks = result.stdout.match(/^::notice::.*$/gm) ?? [];
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain(`Open ${url} and click "Approve workflows to run"`);
    expect(result.stdout).toContain('ci.yml: waiting for approval. dco.yml: not started.');
    expect(result.stdout).toContain('ci.yml: in_progress. dco.yml: passed.');
    expect(result.stdout.trim().split('\n').at(-1)).toBe('ci.yml: passed. dco.yml: passed.');
  });

  it("looks only at the pull request's runs at the release commit", () => {
    const result = wait({ 'ci.yml': [run(1, 'completed', 'success')] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      expect.stringContaining(`run list --workflow ci.yml --commit ${commit} --event pull_request`),
    ]);
  });

  it('fails on a run that did not pass, naming it', () => {
    const result = wait({
      'ci.yml': [run(5, 'completed', 'failure')],
      'dco.yml': [run(6, 'completed', 'success')],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '::error::ci.yml did not pass on the pull request (failure): https://github.com/PILOTAAI/slotlock/actions/runs/5',
    );
  });

  it('stops when the approval never comes, saying how to carry on', () => {
    const result = wait({ 'ci.yml': [held(1)], 'dco.yml': [held(2)] }, '0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error::Still waiting for approval of the checks on ${url}.`);
    expect(result.stderr).toContain('run Release a version again with the same version');
  });

  it('stops when a run never starts', () => {
    const result = wait({ 'ci.yml': [run(1, 'completed', 'success')], 'dco.yml': [none] }, '0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error::Still waiting for dco.yml on ${url}.`);
  });
});
