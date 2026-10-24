// What users of the already-published versions are told (GAP0-2, GAP0-4): 0.2.0 double-books
// around daylight-saving changes and pins zod 4.6.5 (GHSA-mrhx-c7xc-m3w5), and 0.0.0-stage, 0.1.0
// and 0.1.1 are older still. The notice must be reachable from the README (npm and GitHub), the
// site, the v0.2.0 release notes and an advisory, and the maintainer's deprecation runbook must
// cover every published version with commands that run as written.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** A section of a Markdown document: from its heading to the next heading of its level or above. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  expect(start, `canary: ${heading} exists`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/** GitHub's heading anchor: lower case, punctuation but hyphens dropped, spaces to hyphens. */
const githubAnchor = (heading: string) =>
  heading
    .replace(/^#+ /, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

const HEADING = '## Known issues in 0.2.0';
const ANCHOR = `https://github.com/PILOTAAI/slotlock#${githubAnchor(HEADING)}`;
const zod = (JSON.parse(read('package.json')) as { dependencies: Record<string, string> })
  .dependencies.zod as string;
const WORKAROUND = `"overrides": {"zod": "${zod}"}`;

/** The five double-booking classes, each by words only its description uses. */
const CLASSES: [string, RegExp][] = [
  ['P1 first occurrence across a change', /first occurrence[^.]*spans a daylight-saving change/],
  ['P2 repeated autumn hour', /repeated hour of an autumn change/],
  ['P3 skipped-hour exception', /cannot cancel or move an occurrence[^.]*skipped/],
  ['P4 occurrence longer than the gap', /longer than the skipped hour/],
  ['P5 date-only UNTIL', /date-only `UNTIL`/],
];

describe('the 0.2.0 known-issues notice', () => {
  const notice = () => flat(section(read('README.md'), HEADING));

  it('names every double-booking class, the zod pin and its workaround, and 0.3.0', () => {
    const readme = notice();
    for (const [name, words] of CLASSES) expect(readme, name).toMatch(words);
    expect(readme).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(readme).toContain('zod 4.6.5');
    // The override names the zod the repository ships and tests, which is past the advisory.
    expect(zod).not.toBe('4.6.5');
    expect(readme).toContain(WORKAROUND);
    expect(readme).toContain('0.3.0');
  });

  it('sits ahead of the install instructions, so npm and GitHub readers meet it first', () => {
    const text = read('README.md');
    expect(text.indexOf(HEADING)).toBeGreaterThan(0);
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf('## Install\n'));
  });

  it('is a docs page on the site, linked from the landing page while 0.2 is current', () => {
    const page = read('site/docs-src/known-issues.md');
    expect(page).toContain(`<!-- include README.md#${githubAnchor(HEADING)} body -->`);
    expect(read('site/astro.config.mjs')).toContain("'docs/known-issues'");
    expect(read('site/src/data/landing.ts')).toContain('/docs/known-issues/');
  });

  it('gives the v0.2.0 release-notes text and the advisory drafts the same facts', () => {
    const notes = flat(read('docs/release/0.2.0-known-issues.md'));
    for (const [name, words] of CLASSES) expect(notes, name).toMatch(words);
    expect(notes).toContain(WORKAROUND);
    expect(notes).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(notes).toMatch(/gh release edit v0\.2\.0 [^\n]*--notes-file notes\.md/);
    // Two advisories: the inherited zod one and the double booking, each for every release so far.
    expect(notes.match(/Affected versions: `<= 0\.2\.0`/g)).toHaveLength(2);
    expect(notes).toContain(ANCHOR);
  });
});

describe('the deprecation runbook', () => {
  // Read once; a missing runbook reads as empty, so each test fails on what it checks.
  const runbook = existsSync(new URL('../../docs/release/deprecations.md', import.meta.url))
    ? read('docs/release/deprecations.md')
    : '';
  // The commands to run now; the runbook's last section is for when 0.3.0 is out.
  const now = runbook.split('\n## When 0.3.0 is published\n')[0] ?? '';
  const commands = [...now.matchAll(/^npm deprecate slotlock@(\S+) "([^"\n]+)"$/gm)];
  const deprecated = new Map(commands.map(([, version, message]) => [version, message as string]));
  // Every release in the CHANGELOG up to 0.2.0, plus the staging placeholder npm also serves.
  const released = [...read('CHANGELOG.md').matchAll(/^## (\d+\.\d+\.\d+) - \d{4}-\d{2}-\d{2}$/gm)]
    .map(([, version]) => version as string)
    .filter((version) => ['0.1.0', '0.1.1', '0.2.0'].includes(version));

  it('deprecates every published version, each once', () => {
    expect(released.sort()).toEqual(['0.1.0', '0.1.1', '0.2.0']);
    expect([...deprecated.keys()].sort()).toEqual(['0.0.0-stage', ...released].sort());
    expect(commands).toHaveLength(deprecated.size);
  });

  it('says in each message what to install instead and where the notice is', () => {
    for (const version of ['0.1.0', '0.1.1', '0.2.0']) {
      const message = deprecated.get(version) ?? '';
      expect(message, version).toContain(ANCHOR);
      expect(message.length, version).toBeLessThanOrEqual(240);
    }
    expect(deprecated.get('0.0.0-stage')).toContain('slotlock@latest');
    for (const version of ['0.1.0', '0.1.1']) {
      expect(deprecated.get(version), version).toMatch(/0\.2\.0 or later|slotlock@latest/);
    }
    expect(deprecated.get('0.2.0')).toContain('0.3.0');
  });

  it('previews, undoes, and deprecates the 0.1 entries in the MCP Registry too', () => {
    expect(runbook).toContain('--dry-run');
    expect(runbook).toContain('npm undeprecate slotlock@0.2.0');
    for (const version of ['0.1.0', '0.1.1']) {
      expect(runbook).toMatch(
        new RegExp(
          `mcp-publisher status --status deprecated --message "[^"]+" io\\.github\\.PILOTAAI/slotlock ${version.replace(/\./g, '\\.')}`,
        ),
      );
    }
  });
});
