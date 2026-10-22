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

  it('makes a release wait for no reviewer unless asked to', () => {
    const plain = dryRun();
    expect(environment(plain, 'npm')?.reviewers).toEqual([]);
    expect(environment(plain, 'mcp-registry')?.reviewers).toEqual([]);
    const approved = dryRun('--require-approval');
    expect(environment(approved, 'npm')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
    expect(environment(approved, 'mcp-registry')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
  });

  describe.skipIf(!hasSshKeygen)('the tag deploy key', () => {
    // A stand-in for gh that answers every request configure-github.sh sends, logs each one, and
    // keeps the deploy key it is sent and the secret value it receives on stdin.
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

    function configure(scenario: { keys: string; secrets: string }, ...args: string[]) {
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
  'api repos/PILOTAAI/slotlock/commits/tags/v1.2.3 --jq .sha')
    if [ "$STUB_TAG_PUSHED" = 1 ] || [ -f "$STUB_LOG/tagged" ]; then echo "$STUB_TAG_COMMIT"; else exit 1; fi ;;
  'run list '*'--workflow tag-release.yml '*) echo "$STUB_TAG_RUNS" ;;
  'run list '*'--workflow release.yml '*) [ "$STUB_GH_FAILS" = 1 ] && exit 1; echo "$STUB_RELEASE_RUNS" ;;
  'run list '*'--workflow image.yml '*) echo "$STUB_IMAGE_RUNS" ;;
  'run download '*) for last; do :; done; cp "$STUB_ARTIFACT"/* "$last" ;;
  'run view 22 '*) echo "$STUB_IMAGE_JOB" ;;
  'run rerun 5 '*) [ "$STUB_RERUN_TAGS" = 1 ] && touch "$STUB_LOG/tagged"; exit 0 ;;
  'run rerun '*) ;;
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
    const watchAt = result.gh.findIndex((call) => call.startsWith('run watch 5 '));
    expect(rerunAt).toBeGreaterThanOrEqual(0);
    expect(watchAt).toBeGreaterThan(rerunAt);
    expect(result.gh).toContainEqual(download(11));
    expect(result.npm).toContain('stage approve stage-1');
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
        /^stage publish \S+\/slotlock-1\.2\.3\.tgz --access public --tag latest$/,
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

  it('refuses an npm without npm stage and npm trust', () => {
    const result = bootstrap({ STUB_NPM_VERSION: '11.14.2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm 11.14.2 has no npm stage or npm trust');
    expect(result.gh).toEqual([]);
  });
});
