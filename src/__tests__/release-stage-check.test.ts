// scripts/check-stage.sh, which a maintainer runs before approving a staged npm version (GAP0-10):
// 0.2.0 went public with zod 4.6.5 (GHSA-mrhx-c7xc-m3w5) 17 hours after main had moved past it,
// because nothing looked at the stage again at approval. npm and gh are stand-ins here; the audit
// reports they answer with are npm 11.17.0's real output for a project that installs the published
// slotlock@0.2.0, without and with "overrides": {"zod": "4.6.7"}.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name: string) => join(root, 'src', '__tests__', 'fixtures', name);
const hasJq = spawnSync('jq', ['--version']).status === 0;
const STAGE_ID = '6f1c2a4e-0b7d-4c55-9a8e-2d3f4b5c6d7e';
const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

interface Stage {
  version?: string;
  tag?: string;
  latest?: string;
  audit?: string;
  /** The sha256 the GitHub release lists; by default the staged tarball's own. */
  releaseSha?: string;
  /** No SHA256SUMS in the release. */
  noRelease?: boolean;
  packageName?: string;
}

function check(stage: Stage, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-stage-'));
  scratch.push(dir);
  const version = stage.version ?? '0.2.0';
  // The staged tarball, as npm pack lays it out.
  const pack = join(dir, 'pack', 'package');
  mkdirSync(pack, { recursive: true });
  writeFileSync(
    join(pack, 'package.json'),
    JSON.stringify({ name: 'slotlock', version, dependencies: { zod: '4.6.5' } }),
  );
  const tarball = join(dir, 'stage.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', join(dir, 'pack'), 'package']);
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(
    join(dir, 'stage.json'),
    JSON.stringify({
      id: STAGE_ID,
      packageName: stage.packageName ?? 'slotlock',
      version,
      tag: stage.tag ?? 'latest',
      createdAt: '2026-10-23T18:08:40.000Z',
      actor: 'github-actions',
      actorType: 'oidc',
    }),
  );
  if (!stage.noRelease) {
    writeFileSync(join(dir, 'SHA256SUMS'), `${stage.releaseSha ?? sha}  slotlock-${version}.tgz\n`);
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // npm: stage view/download, view dist-tags.latest, install --package-lock-only, audit --json.
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
echo "$*" >> "${dir}/npm.log"
case "$1 $2" in
"stage view") cat "${dir}/stage.json" ;;
"stage download") cp "${dir}/stage.tgz" "slotlock-${version}-$3.tgz"; echo "slotlock-${version}-$3.tgz" ;;
"view slotlock") [ -n "$STUB_LATEST" ] && echo "$STUB_LATEST" ;;
"install --package-lock-only") cp package.json "${dir}/consumer.json"; echo '{}' > package-lock.json ;;
"audit --omit=dev") cat "$STUB_AUDIT"; jq -e '.metadata.vulnerabilities.total == 0' "$STUB_AUDIT" >/dev/null ;;
*) echo "unexpected npm $*" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  // gh: release download <tag> --repo <repo> --pattern SHA256SUMS --dir <dir>.
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${dir}/gh.log"
[ "$1 $2" = "release download" ] || { echo "unexpected gh $*" >&2; exit 9; }
[ -f "${dir}/SHA256SUMS" ] || { echo "release not found" >&2; exit 1; }
while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && cp "${dir}/SHA256SUMS" "$2/SHA256SUMS"; shift; done
`,
    { mode: 0o755 },
  );
  const result = spawnSync('sh', [join(root, 'scripts', 'check-stage.sh'), STAGE_ID, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STUB_LATEST: stage.latest ?? '0.1.1',
      STUB_AUDIT: stage.audit ?? fixture('npm-audit-slotlock-0.2.0-zod-override.json'),
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { ...result, read, sha };
}

describe.skipIf(!hasJq)('scripts/check-stage.sh', () => {
  it('passes the tested tarball with no advisory, and approves nothing itself', () => {
    const result = check({});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Its tarball is the one release v0.2.0 built and tested (sha256 ${result.sha})`,
    );
    expect(result.stdout).toContain(`npm stage approve ${STAGE_ID}`);
    expect(result.read('npm.log')).not.toMatch(/^stage approve/m);
    // The consumer installs the downloaded tarball itself, and the release is this repository's.
    expect(JSON.parse(result.read('consumer.json')).dependencies).toEqual({
      slotlock: 'file:slotlock.tgz',
    });
    expect(result.read('gh.log')).toContain(
      'release download v0.2.0 --repo PILOTAAI/slotlock --pattern SHA256SUMS',
    );
  });

  it('refuses a stage whose runtime dependencies have a high advisory, naming it', () => {
    const result = check({ audit: fixture('npm-audit-slotlock-0.2.0.json') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Blocking: GHSA-mrhx-c7xc-m3w5 (high) zod <4.6.6: Zod can exhaust memory while validating oversized constrained collections',
    );
    expect(result.stderr).toContain(
      "refused: slotlock@0.2.0's runtime dependencies have the advisories above",
    );
    expect(result.stdout).not.toContain('npm stage approve');
  });

  it('lets a maintainer accept a named advisory, and only that one', () => {
    const allowed = check(
      { audit: fixture('npm-audit-slotlock-0.2.0.json') },
      '--allow',
      'GHSA-mrhx-c7xc-m3w5',
    );
    expect(allowed.stderr).toBe('');
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('Allowed: GHSA-mrhx-c7xc-m3w5 (high) zod');
    const other = check(
      { audit: fixture('npm-audit-slotlock-0.2.0.json') },
      '--allow',
      'GHSA-aaaa-bbbb-cccc',
    );
    expect(other.status).toBe(1);
  });

  it('refuses a tarball that is not the one the release tested', () => {
    const changed = check({ releaseSha: 'a'.repeat(64) });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(`the staged tarball's sha256 is ${changed.sha}`);
    const missing = check({ noRelease: true });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('the GitHub release v0.2.0 has no SHA256SUMS');
  });

  it('refuses a latest stage that would move latest backwards', () => {
    // 0.3.0 was approved first; the 0.2.1 stage still carries the tag it was staged with.
    const backwards = check({ version: '0.2.1', tag: 'latest', latest: '0.3.0' });
    expect(backwards.status).toBe(1);
    expect(backwards.stderr).toContain('approving it would move latest from 0.3.0 back to 0.2.1');
    expect(backwards.stderr).toContain('scripts/dist-tag.sh gives it latest-0.2');
    expect(backwards.read('npm.log')).not.toContain('stage download');
    // The same version staged under its line tag is fine.
    const line = check({ version: '0.2.1', tag: 'latest-0.2', latest: '0.3.0' });
    expect(line.stderr).toBe('');
    expect(line.status).toBe(0);
  });

  it('refuses another package, and a malformed stage id', () => {
    const other = check({ packageName: 'not-slotlock' });
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('is not-slotlock, not slotlock');
    for (const id of ['', '--allow', 'a b', '../x']) {
      const result = spawnSync('sh', [join(root, 'scripts', 'check-stage.sh'), id], {
        encoding: 'utf8',
      });
      expect(result.status, id).toBe(2);
    }
  });
});

describe('the approval runbook', () => {
  it('asks for the check before every approval', () => {
    const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('scripts/check-stage.sh <stage-id>');
    const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(release).toMatch(/echo "scripts\/check-stage\.sh \$\{stage_id:-<stage-id>\}"/);
  });
});
