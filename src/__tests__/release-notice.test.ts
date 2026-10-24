// NOTICE follows package.json and package-lock.json. A runtime dependency bump, such as the zod
// 4.6.5 to 4.6.7 bump that left main red (the packaged NOTICE still named 4.6.5), must build a
// packed NOTICE that names the new version with no hand edit, while a packed NOTICE that names the
// wrong version still fails scripts/verify-package.mjs.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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

interface Lock {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

/**
 * A copy of the build inputs prepare-package.mjs reads, with zod moved to `zod` in package.json and
 * package-lock.json the way Dependabot moves it, and nothing else edited.
 */
function bumped(zod: string) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-notice-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts'));
  for (const file of readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs'))) {
    cpSync(join(root, 'scripts', file), join(dir, 'scripts', file));
  }
  for (const file of [
    'README.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'SPEC.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'GOVERNANCE.md',
    'MAINTAINERS.md',
    'openapi.json',
    'slotlock.manifest.json',
    'slotlock-manifest.schema.json',
  ]) {
    cpSync(join(root, file), join(dir, file));
  }
  const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
  manifest.dependencies.zod = zod;
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(read('package-lock.json')) as Lock;
  (lock.packages[''] as { dependencies: Record<string, string> }).dependencies.zod = zod;
  (lock.packages['node_modules/zod'] as { version: string }).version = zod;
  writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  mkdirSync(join(dir, 'dist'));
  // The built entry point verify-package.mjs reads before it reaches NOTICE.
  writeFileSync(join(dir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  const node = (...args: string[]) =>
    spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  return { dir, node };
}

describe('NOTICE', () => {
  it('names a bumped runtime dependency in the packed NOTICE with no hand edit', () => {
    const copy = bumped('4.6.99');
    const prepared = copy.node('scripts/prepare-package.mjs');
    expect(prepared.status, prepared.stderr).toBe(0);
    const packed = readFileSync(join(copy.dir, 'dist', 'NOTICE'), 'utf8');
    // The assertion scripts/verify-package.mjs makes for each dependency.
    expect(packed).toContain('zod 4.6.99,');
    expect(packed).not.toContain('zod 4.6.7');
    expect(packed).toMatch(/^Copyright \d{4} TREFT LTD$/m);
    expect(packed).toContain('postgres ^3.4.5,');
    // The repository's own NOTICE needed no edit for the bump.
    const check = copy.node('scripts/notice.mjs', '--check');
    expect(check.status, check.stderr).toBe(0);
  });

  it('still fails verify-package when the packed NOTICE names the wrong version', () => {
    const copy = bumped('4.6.99');
    expect(copy.node('scripts/prepare-package.mjs').status).toBe(0);
    const path = join(copy.dir, 'dist', 'NOTICE');
    writeFileSync(path, readFileSync(path, 'utf8').replace('zod 4.6.99,', 'zod 4.6.5,'));
    const verified = copy.node('scripts/verify-package.mjs');
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain('NOTICE must list zod 4.6.99');
  });

  it('lists every runtime dependency and its licence, and is the file scripts/notice.mjs writes', () => {
    const notice = read('NOTICE');
    for (const line of [
      '- ical.js, Mozilla Public License 2.0, https://github.com/kewisch/ical.js',
      '- rrule, BSD 3-Clause License, https://github.com/jakubroztocil/rrule',
      '  - tslib (via rrule), BSD Zero Clause License (0BSD), https://github.com/Microsoft/tslib',
      '- zod, MIT License, https://github.com/colinhacks/zod',
      '- postgres ^3.4.5, The Unlicense, https://github.com/porsager/postgres',
    ]) {
      expect(notice.split('\n')).toContain(line);
    }
    const check = spawnSync(process.execPath, ['scripts/notice.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr).toBe(0);
  });

  it('refuses a runtime dependency under a licence nobody has reviewed', () => {
    const copy = bumped('4.6.7');
    const lock = JSON.parse(readFileSync(join(copy.dir, 'package-lock.json'), 'utf8')) as Lock;
    (lock.packages['node_modules/zod'] as { license?: string }).license = 'SSPL-1.0';
    writeFileSync(join(copy.dir, 'package-lock.json'), JSON.stringify(lock));
    const prepared = copy.node('scripts/prepare-package.mjs');
    expect(prepared.status).not.toBe(0);
    expect(prepared.stderr).toContain('zod is under SSPL-1.0');
  });
});
