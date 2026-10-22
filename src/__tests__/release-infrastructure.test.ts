// The release and self-host files agree with each other and with the code: every GitHub Action is
// pinned to a commit with its version beside it, every base image to a digest, server.json names
// what the Dockerfile labels and what the CLI reads, and the DCO, release-tag, release-planning and
// bootstrap scripts accept and refuse what their workflows rely on.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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

  it('refuses a checkout that is not the commit the tag names', () => {
    // A dispatch on a branch called v1.2.3 checks out the branch while the tag sits on main.
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

  describe('release planning', () => {
    const plan = (repo: ReturnType<typeof release>) =>
      repo.script('plan-release.sh', repo.git('rev-parse', 'HEAD'));

    it('releases a dated version that has no tag yet', () => {
      const result = plan(release());
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('tag=v1.2.3\nrelease=true\n');
    });

    it('skips a version that is already tagged', () => {
      const repo = release();
      repo.git('tag', 'v1.2.3');
      const result = plan(repo);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('tag=v1.2.3\nrelease=false\n');
      expect(result.stderr).toContain('v1.2.3 already exists');
    });

    it('skips a version whose CHANGELOG heading is not dated yet', () => {
      const result = plan(release('Unreleased'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('tag=v1.2.3\nrelease=false\n');
      expect(result.stderr).toContain('does not date 1.2.3 yet');
    });

    it('fails a dated version that fails a release check instead of skipping it', () => {
      const repo = release();
      writeFileSync(
        join(repo.cwd, 'server.json'),
        JSON.stringify({
          version: '1.2.2',
          packages: [{ identifier: 'ghcr.io/pilotaai/slotlock:1.2.2' }],
        }),
      );
      repo.git('add', '.');
      const stale = repo.commit('server.json left at 1.2.2');
      repo.git('update-ref', 'refs/remotes/origin/main', stale);
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

  it('tags a merged version on main and starts both release workflows on the tag', () => {
    const text = workflow('tag-release.yml');
    expect(text).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m);
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toMatch(/permissions:\n\s+# .*\n\s+contents: write\n\s+# .*\n\s+actions: write\n/);
    expect(text).toContain('scripts/plan-release.sh "$GITHUB_SHA" >> "$GITHUB_OUTPUT"');
    expect(text).toContain("if: steps.plan.outputs.release == 'true'");
    const started = [
      ...text.matchAll(/gh workflow run (\S+) --repo "\$GITHUB_REPOSITORY" --ref "\$TAG"/g),
    ].map((match) => match[1] as string);
    expect(started).toEqual(['release.yml', 'image.yml']);
    for (const file of started) {
      // A tag pushed with GITHUB_TOKEN starts no workflow, so each one is dispatched on the tag.
      expect(workflow(file), file).toMatch(
        /^on:\n {2}push:\n {4}tags: \['v\*'\]\n(?: {2}#.*\n)* {2}workflow_dispatch:\n/m,
      );
      // A dispatch on any other ref fails here: its name is not v<package.json version>.
      expect(workflow(file), file).toContain(
        'run: scripts/check-release-tag.sh "$GITHUB_REF_NAME"',
      );
    }
  });

  it('only stages on npm, and asks for the bootstrap when npm needs a person', () => {
    const text = workflow('release.yml');
    const stage = text.slice(text.indexOf('\n  stage:\n'), text.indexOf('\n  github-release:\n'));
    expect(stage).toContain('environment: npm');
    expect(stage).toContain('id-token: write');
    expect(stage).toContain('npm stage publish "./$TARBALL" --provenance --access public');
    expect(stage).toContain('scripts/bootstrap-release.sh $GITHUB_REF_NAME');
    // GOVERNANCE.md, Releases: a maintainer approves each version with two-factor authentication.
    for (const { file, text: body } of workflows) {
      expect(body, file).not.toMatch(/npm (?:publish|dist-tag)\b/);
    }
  });

  it('names the image by its tag however the run started', () => {
    const text = workflow('image.yml');
    expect(text).toContain('type=semver,pattern={{version}},value=${{ github.ref_name }}');
    expect(text).toContain(
      'type=semver,pattern={{major}}.{{minor}},value=${{ github.ref_name }}',
    );
  });
});

interface DryRunRequest {
  method: string;
  path: string;
  body: {
    target?: string;
    reviewers?: unknown[];
    rules?: { type: string }[];
    conditions?: { ref_name: { include: string[] } };
  };
}

describe.skipIf(!hasJq)('GitHub configuration', () => {
  function dryRun(...args: string[]): DryRunRequest[] {
    const result = spawnSync(
      'bash',
      [join(root, 'scripts', 'configure-github.sh'), '--dry-run', ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SKIP_SITE_SECRETS: '1' } },
    );
    expect(result.status, result.stderr).toBe(0);
    return [...result.stdout.matchAll(/^> (PUT|POST) \/(\S+)\n(\{[\s\S]*?\n\})$/gm)].map(
      ([, method = '', path = '', body = '']) => ({
        method,
        path,
        body: JSON.parse(body) as DryRunRequest['body'],
      }),
    );
  }
  const environment = (requests: DryRunRequest[], name: string) =>
    requests.find(
      (request) =>
        request.method === 'PUT' &&
        request.path === `repos/PILOTAAI/slotlock/environments/${name}`,
    )?.body;

  it('lets tag-release.yml create release tags, which then only an admin can move or delete', () => {
    const tags = dryRun().find(
      (request) => request.path.endsWith('/rulesets') && request.body.target === 'tag',
    )?.body;
    expect(tags?.conditions?.ref_name.include).toEqual(['refs/tags/v*']);
    expect(tags?.rules?.map((rule) => rule.type).sort()).toEqual(['deletion', 'update']);
  });

  it('makes a release wait for no reviewer unless asked to', () => {
    const plain = dryRun();
    expect(environment(plain, 'npm')?.reviewers).toEqual([]);
    expect(environment(plain, 'mcp-registry')?.reviewers).toEqual([]);
    const approved = dryRun('--require-approval');
    expect(environment(approved, 'npm')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
    expect(environment(approved, 'mcp-registry')?.reviewers).toEqual([{ type: 'User', id: 0 }]);
  });
});

describe.skipIf(!hasJq)('release bootstrap', () => {
  // Stand-ins for npm, gh and curl: each logs its arguments and answers as the scenario says.
  const stubs: Record<string, string> = {
    npm: `case "$*" in
  --version) echo "$STUB_NPM_VERSION" ;;
  'view slotlock@1.2.3 version') [ "$STUB_VERSION_ON_NPM" = 1 ] && echo 1.2.3 || exit 1 ;;
  'view slotlock version') [ "$STUB_PACKAGE_ON_NPM" = 1 ] && echo 1.2.2 || exit 1 ;;
  whoami) echo ada ;;
  'stage list slotlock') ;;
  'stage publish '*) echo '+ slotlock@1.2.3 (staged with id stage-1)' ;;
  'stage approve stage-1') ;;
  'trust list slotlock --json') echo '[]' ;;
  'trust github '*) ;;
  *) echo "unexpected: npm $*" >&2; exit 99 ;;
esac`,
    gh: `case "$*" in
  'run list '*'--workflow release.yml '*) echo '11 completed failure' ;;
  'run list '*'--workflow image.yml '*) echo '22 completed failure' ;;
  'run download 11 '*) for last; do :; done; cp "$STUB_ARTIFACT"/* "$last" ;;
  'run view 22 '*) echo "$STUB_IMAGE_JOB" ;;
  'run rerun '*) ;;
  *) echo "unexpected: gh $*" >&2; exit 99 ;;
esac`,
    curl: `case "$*" in
  *ghcr.io/token*) [ "$STUB_IMAGE_PUBLIC" = 1 ] && echo '{"token":"anonymous"}' || exit 22 ;;
  *ghcr.io/v2/*) [ "$STUB_IMAGE_PUBLIC" = 1 ] || exit 22 ;;
  *) echo "unexpected: curl $*" >&2; exit 99 ;;
esac`,
  };

  function bootstrap(scenario: Record<string, string>, checksum?: string) {
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
    const result = spawnSync('bash', [join(root, 'scripts', 'bootstrap-release.sh'), 'v1.2.3'], {
      encoding: 'utf8',
      input: '',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        STUB_LOG: log,
        STUB_ARTIFACT: artifact,
        STUB_NPM_VERSION: '11.19.0',
        STUB_IMAGE_PUBLIC: '1',
        STUB_IMAGE_JOB: 'success',
        ...scenario,
      },
    });
    const calls = (name: string) =>
      existsSync(join(log, `${name}.log`))
        ? readFileSync(join(log, `${name}.log`), 'utf8').trim().split('\n')
        : [];
    return { ...result, npm: calls('npm'), gh: calls('gh') };
  }
  const rerun = (id: number) => `run rerun ${id} --failed --repo PILOTAAI/slotlock`;

  it('puts the first version on npm from the tested tarball, with no trusted publisher yet', () => {
    const run = bootstrap({});
    expect(run.status, run.stderr).toBe(0);
    expect(run.npm).toContainEqual(
      expect.stringMatching(/^stage publish \S+\/slotlock-1\.2\.3\.tgz --access public --tag latest$/),
    );
    expect(run.npm).toContain('stage approve stage-1');
    // npm expires a trusted publisher that has not published within 2 days.
    expect(run.npm.filter((call) => call.startsWith('trust '))).toEqual([]);
    expect(run.gh).toContain(rerun(11));
    expect(run.gh).toContain(rerun(22));
  });

  it('creates the stage-only trusted publisher when a later version is waiting', () => {
    const run = bootstrap({ STUB_PACKAGE_ON_NPM: '1' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.npm).toContain(
      'trust github slotlock --file release.yml --repository PILOTAAI/slotlock --environment npm --allow-stage-publish',
    );
    expect(run.npm.filter((call) => call.startsWith('stage '))).toEqual([]);
    expect(run.gh).toContain(rerun(11));
  });

  it('leaves npm alone for a version already there', () => {
    const run = bootstrap({ STUB_PACKAGE_ON_NPM: '1', STUB_VERSION_ON_NPM: '1' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.npm.filter((call) => /^(?:stage|trust|publish) /.test(call))).toEqual([]);
  });

  it("refuses a tarball that does not match its run's checksum", () => {
    const run = bootstrap({}, '0'.repeat(64));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('does not match its SHA256SUMS');
    expect(run.npm.filter((call) => call.startsWith('stage '))).toEqual([]);
    expect(run.gh).not.toContain(rerun(11));
  });

  it('stops at a private image, naming the page that makes it public', () => {
    const run = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_VERSION_ON_NPM: '1',
      STUB_IMAGE_PUBLIC: '0',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('https://github.com/orgs/PILOTAAI/packages/container/package/slotlock');
    expect(run.stderr).toContain('stopped before the image was public');
    expect(run.gh).not.toContain(rerun(22));
  });

  it('re-runs an Image run whose image job failed, without asking about visibility', () => {
    const run = bootstrap({
      STUB_PACKAGE_ON_NPM: '1',
      STUB_VERSION_ON_NPM: '1',
      STUB_IMAGE_PUBLIC: '0',
      STUB_IMAGE_JOB: 'failure',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('did not push the image');
    expect(run.gh).toContain(rerun(22));
  });

  it('refuses an npm without npm stage and npm trust', () => {
    const run = bootstrap({ STUB_NPM_VERSION: '11.14.2' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('npm 11.14.2 has no npm stage or npm trust');
    expect(run.gh).toEqual([]);
  });
});
