// The five language clients go out with each release: versioned with the package by the release
// scripts, published from release.yml once its suite has passed, each from its own environment a
// maintainer approves (PyPI, crates.io and NuGet by trusted publishing, Maven Central as a deployment
// a maintainer publishes in the Central Portal, Go as a module tag), and refused when a client's
// version disagrees with the release.
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});
const hasJq = spawnSync('jq', ['--version']).status === 0;
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;

/** Each client file and the line in it that names its version. */
const CLIENT_VERSION_LINES: [string, (version: string) => string][] = [
  ['clients/python/pyproject.toml', (v) => `version = "${v}"`],
  ['clients/python/src/slotlock/_transport.py', (v) => `__version__ = "${v}"`],
  ['clients/rust/Cargo.toml', (v) => `version = "${v}"`],
  ['clients/java/build.gradle.kts', (v) => `version = "${v}"`],
  [
    'clients/java/src/main/java/io/pylota/slotlock/SlotlockClient.java',
    (v) => `  public static final String VERSION = "${v}";`,
  ],
  ['clients/dotnet/src/Slotlock/Slotlock.csproj', (v) => `    <Version>${v}</Version>`],
  [
    'clients/dotnet/src/Slotlock/SlotlockClient.cs',
    (v) => `    public const string Version = "${v}";`,
  ],
  ['clients/go/client.go', (v) => `const Version = "${v}"`],
];
const cargoLockVersion = (text: string) =>
  /^name = "slotlock"\nversion = "([^"]+)"$/m.exec(text)?.[1];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    },
  }).trim();
}

describe('client versions', () => {
  it('match the package version, in every manifest and User-Agent constant', () => {
    for (const [file, line] of CLIENT_VERSION_LINES) {
      expect(read(file).split('\n'), file).toContain(line(packageVersion));
    }
    expect(cargoLockVersion(read('clients/rust/Cargo.lock'))).toBe(packageVersion);
  });

  /** A repository at 1.2.3, tagged, whose clients are the real files at CLIENTS (default 1.2.3). */
  function project(clients = '1.2.3') {
    const cwd = mkdtempSync(join(tmpdir(), 'slotlock-clients-'));
    scratch.push(cwd);
    git(cwd, 'init', '--quiet', '--initial-branch=main');
    const files: Record<string, string> = {
      'package.json': `${JSON.stringify({ name: 'slotlock', version: '1.2.3' }, null, 2)}\n`,
      'package-lock.json': `${JSON.stringify(
        {
          name: 'slotlock',
          version: '1.2.3',
          lockfileVersion: 3,
          packages: { '': { version: '1.2.3' } },
        },
        null,
        2,
      )}\n`,
      'server.json': `${JSON.stringify(
        { version: '1.2.3', packages: [{ identifier: 'ghcr.io/pilotaai/slotlock:1.2.3' }] },
        null,
        2,
      )}\n`,
      'slotlock.manifest.json': `${JSON.stringify({ version: '1.2.3' }, null, 2)}\n`,
      'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n- A change.\n\n## 1.2.3 - 2026-10-09\n',
    };
    for (const [file, line] of CLIENT_VERSION_LINES) {
      files[file] = read(file).replace(line(packageVersion), line(clients));
    }
    files['clients/rust/Cargo.lock'] = read('clients/rust/Cargo.lock').replace(
      `name = "slotlock"\nversion = "${packageVersion}"`,
      `name = "slotlock"\nversion = "${clients}"`,
    );
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'release 1.2.3');
    git(cwd, 'tag', 'v1.2.3');
    const script = (name: string, ...args: string[]) =>
      spawnSync('sh', [join(root, 'scripts', name), ...args], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
        },
      });
    return { cwd, script, files };
  }

  it.skipIf(!hasJq)(
    'move with the release, every other byte unchanged, and pass the tag check',
    () => {
      const repo = project();
      const result = repo.script('prepare-release.sh', '1.2.4');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      for (const [file, line] of CLIENT_VERSION_LINES) {
        expect(readFileSync(join(repo.cwd, file), 'utf8'), file).toBe(
          (repo.files[file] as string).replace(line('1.2.3'), line('1.2.4')),
        );
      }
      expect(
        cargoLockVersion(readFileSync(join(repo.cwd, 'clients/rust/Cargo.lock'), 'utf8')),
      ).toBe('1.2.4');
      git(repo.cwd, 'add', '.');
      git(repo.cwd, 'commit', '--quiet', '-m', 'Release 1.2.4');
      git(repo.cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const head = git(repo.cwd, 'rev-parse', 'HEAD');
      const checked = repo.script('check-release-tag.sh', 'v1.2.4', '--commit', head);
      expect(checked.stderr).toBe('');
      expect(checked.status).toBe(0);
    },
  );

  it.skipIf(!hasJq)(
    'refuse a release while a client is at another version, and change nothing',
    () => {
      const repo = project('1.2.2');
      const result = repo.script('prepare-release.sh', '1.2.4');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "clients/python/pyproject.toml is not at package.json's 1.2.3",
      );
      expect(git(repo.cwd, 'status', '--porcelain')).toBe('');
    },
  );

  it.skipIf(!hasJq)('are checked before a tag is released', () => {
    const repo = project('1.2.2');
    git(repo.cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const head = git(repo.cwd, 'rev-parse', 'HEAD');
    const checked = repo.script('check-release-tag.sh', 'v1.2.3', '--commit', head);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('clients/python/pyproject.toml does not name version 1.2.3');
  });
});

describe('client publishing', () => {
  const release = read('.github/workflows/release.yml');
  const job = (name: string) => {
    const start = release.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = release.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return release.slice(start, next === -1 ? undefined : start + 1 + next);
  };

  it.each([
    ['pypi', 'pypi', true],
    ['crates-io', 'crates-io', true],
    ['nuget', 'nuget', true],
    ['maven-central', 'maven-central', false],
    ['go-module', 'go-module', false],
  ])(
    'publishes from job %s after the suite passes, in environment %s',
    (name, environment, oidc) => {
      const text = job(name);
      expect(text).toContain('needs: build');
      expect(text).toContain(`environment: ${environment}`);
      expect(
        text.includes('id-token: write'),
        'only trusted publishing asks for an OIDC token',
      ).toBe(oidc);
    },
  );

  it('uses each registry trusted publishing where it has one, and no long-lived token there', () => {
    expect(job('pypi')).toMatch(/uses: pypa\/gh-action-pypi-publish@[0-9a-f]{40} # v1\.14\.3/);
    expect(job('pypi')).toContain('--require-hashes');
    expect(job('crates-io')).toMatch(
      /uses: rust-lang\/crates-io-auth-action@[0-9a-f]{40} # v1\.0\.5/,
    );
    expect(job('crates-io')).toContain('CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}');
    expect(job('nuget')).toMatch(/uses: NuGet\/login@[0-9a-f]{40} # v1\.2\.0/);
    expect(job('nuget')).toContain('--api-key "$NUGET_API_KEY"');
    for (const name of ['pypi', 'crates-io', 'nuget']) expect(job(name)).not.toContain('secrets.');
    // Maven Central has no trusted publishing: a user token uploads a deployment that waits in the
    // Central Portal until a maintainer publishes it.
    expect(job('maven-central')).toContain('scripts/central-bundle.sh');
    expect(read('scripts/central-bundle.sh')).toContain('publishingType=USER_MANAGED');
    expect(job('go-module')).toContain('scripts/tag-go-module.sh');
    expect(job('go-module')).toContain('contents: write');
  });

  it.skipIf(!hasJq)('gives each registry its own environment, with a reviewer, for v* tags', () => {
    const result = spawnSync('bash', [join(root, 'scripts', 'configure-github.sh'), '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SKIP_SITE_SECRETS: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    for (const name of ['pypi', 'crates-io', 'nuget', 'maven-central', 'go-module']) {
      const body = new RegExp(
        `^> PUT /repos/PILOTAAI/slotlock/environments/${name}\\n(\\{[\\s\\S]*?\\n\\})$`,
        'm',
      ).exec(result.stdout)?.[1];
      expect(JSON.parse(body ?? '{}').reviewers, name).toEqual([{ type: 'User', id: 0 }]);
      expect(result.stdout, name).toMatch(
        new RegExp(
          `^> POST /repos/PILOTAAI/slotlock/environments/${name}/deployment-branch-policies\\n\\{\\n  "name": "v\\*",\\n  "type": "tag"\\n\\}$`,
          'm',
        ),
      );
    }
    // A Go module version is its tag: once pushed, nobody but an admin moves or deletes it.
    const permanent = [
      ...result.stdout.matchAll(/^> (?:PUT|POST) \/\S+rulesets\S*\n(\{[\s\S]*?\n\})$/gm),
    ]
      .map(([, json]) => JSON.parse(json as string))
      .find((body) => body.name === 'Release tags are permanent');
    expect(permanent.conditions.ref_name.include).toEqual([
      'refs/tags/v*',
      'refs/tags/clients/go/v*',
    ]);
  });
});

describe('Go module tag', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-go-tag-'));
    scratch.push(dir);
    const origin = join(dir, 'origin.git');
    const cwd = join(dir, 'work');
    mkdirSync(cwd);
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(cwd, 'init', '--quiet', '--initial-branch=main');
    mkdirSync(join(cwd, 'clients', 'go'), { recursive: true });
    writeFileSync(
      join(cwd, 'clients', 'go', 'go.mod'),
      'module github.com/PILOTAAI/slotlock/clients/go\n\ngo 1.22\n',
    );
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'release 1.2.3');
    git(cwd, 'remote', 'add', 'origin', origin);
    git(cwd, 'push', '--quiet', 'origin', 'main');
    const commit = git(cwd, 'rev-parse', 'HEAD');
    const run = (version: string, at = commit) =>
      spawnSync('sh', [join(root, 'scripts', 'tag-go-module.sh'), version, at], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
        },
      });
    const remoteTag = (tag: string) =>
      git(cwd, 'ls-remote', origin, `refs/tags/${tag}^{}`).split('\t')[0] ?? '';
    return { cwd, origin, commit, run, remoteTag };
  }

  it('pushes an annotated clients/go/v<version> tag on the release commit, once', () => {
    const r = repo();
    const first = r.run('1.2.3');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(r.remoteTag('clients/go/v1.2.3')).toBe(r.commit);
    expect(git(r.cwd, 'cat-file', '-t', 'refs/tags/clients/go/v1.2.3')).toBe('tag');
    // A re-run of the job after a later failure changes nothing.
    const again = r.run('1.2.3');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('already names');
  });

  it('refuses a tag that already names another commit, and a version that is not semver', () => {
    const r = repo();
    expect(r.run('1.2.3').status).toBe(0);
    writeFileSync(join(r.cwd, 'later'), 'x');
    git(r.cwd, 'add', '.');
    git(r.cwd, 'commit', '--quiet', '-m', 'later');
    const other = git(r.cwd, 'rev-parse', 'HEAD');
    const moved = r.run('1.2.3', other);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain('clients/go/v1.2.3 already names');
    expect(r.remoteTag('clients/go/v1.2.3')).toBe(r.commit);
    for (const version of ['v1.2.3', '1.2']) expect(r.run(version).status, version).toBe(2);
  });
});

describe('Maven Central bundle', () => {
  /** A Gradle publication as `maven-publish` lays it out in a local repository, signed or not. */
  function bundle(options: { sign?: boolean; checksums?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-central-'));
    scratch.push(dir);
    const repo = join(dir, 'repo');
    const version = join(repo, 'io', 'pylota', 'slotlock', '1.2.3');
    mkdirSync(version, { recursive: true });
    writeFileSync(join(repo, 'io', 'pylota', 'slotlock', 'maven-metadata.xml'), '<metadata/>\n');
    for (const name of [
      'slotlock-1.2.3.pom',
      'slotlock-1.2.3.jar',
      'slotlock-1.2.3-sources.jar',
      'slotlock-1.2.3-javadoc.jar',
      'slotlock-1.2.3.module',
    ]) {
      const path = join(version, name);
      writeFileSync(path, name);
      if (options.checksums !== false) {
        for (const algorithm of ['md5', 'sha1']) {
          writeFileSync(`${path}.${algorithm}`, createHash(algorithm).update(name).digest('hex'));
        }
      }
      if (options.sign !== false) writeFileSync(`${path}.asc`, 'signature');
    }
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      // A stand-in for curl: it keeps its arguments, the header file it is given and the bundle.
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/curl.args"\nfor a; do case "$a" in bundle=@*) cp "\${a#bundle=@}" "${dir}/uploaded.zip" ;; @*) cat "\${a#@}" >> "${dir}/curl.headers" ;; esac; done\necho deployment-42\n`,
      { mode: 0o755 },
    );
    const run = (...env: [string, string][]) =>
      spawnSync('sh', [join(root, 'scripts', 'central-bundle.sh'), repo, '1.2.3'], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...Object.fromEntries(env) },
      });
    return { dir, run };
  }

  it('uploads the signed, checksummed publication as a deployment a maintainer publishes', () => {
    const b = bundle();
    const result = b.run(['CENTRAL_PORTAL_TOKEN', 'dXNlcjpwYXNz']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deployment-42');
    const args = readFileSync(join(b.dir, 'curl.args'), 'utf8').split('\n');
    expect(args).toContain(
      'https://central.sonatype.com/api/v1/publisher/upload?publishingType=USER_MANAGED&name=slotlock-1.2.3',
    );
    // The token reaches curl in a header file, never on its command line.
    expect(readFileSync(join(b.dir, 'curl.headers'), 'utf8')).toBe(
      'Authorization: Bearer dXNlcjpwYXNz\n',
    );
    expect(args.join('\n')).not.toContain('dXNlcjpwYXNz');
    const listing = execFileSync('unzip', ['-Z1', join(b.dir, 'uploaded.zip')], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(listing).toContain('io/pylota/slotlock/1.2.3/slotlock-1.2.3.jar.asc');
    // Gradle's maven-metadata.xml describes its local repository, not the deployment.
    expect(listing.filter((path) => path.includes('maven-metadata'))).toEqual([]);
  });

  it('refuses a publication with an unsigned or unchecksummed file, and uploads nothing', () => {
    for (const [what, options] of [
      ['signature', { sign: false }],
      ['checksum', { checksums: false }],
    ] as const) {
      const b = bundle(options);
      const result = b.run(['CENTRAL_PORTAL_TOKEN', 'dXNlcjpwYXNz']);
      expect(result.status, what).toBe(1);
      expect(result.stderr, what).toMatch(/slotlock-1\.2\.3[\w.-]* has no \.(?:asc|md5)/);
      expect(existsSync(join(b.dir, 'curl.args')), what).toBe(false);
    }
  });

  it('refuses to run without the Central Portal token', () => {
    const b = bundle();
    const result = b.run();
    expect(result.status).toBe(2);
    expect(existsSync(join(b.dir, 'curl.args'))).toBe(false);
    expect(readdirSync(b.dir)).not.toContain('uploaded.zip');
  });
});
