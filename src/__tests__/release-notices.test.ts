// What users of the already-published versions are told (GAP0-2, GAP0-4): 0.2.0 double-books
// around daylight-saving changes and pins zod 4.6.5 (GHSA-mrhx-c7xc-m3w5), and 0.0.0-stage, 0.1.0
// and 0.1.1 are older still. The notice lives in docs/release/0.2.0-known-issues.md, and must be
// reachable from the README (npm and GitHub, one line under "Supported versions", no longer its
// opening), the site, the v0.2.0 release notes and an advisory, and the maintainer's deprecation
// runbook must cover every published version with commands that run as written.
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

const NOTICE_FILE = 'docs/release/0.2.0-known-issues.md';
const HEADING = '## The known issues';
const ANCHOR = `https://github.com/PILOTAAI/slotlock/blob/main/${NOTICE_FILE}#${githubAnchor(HEADING)}`;
// The workaround is a fixed fact about published versions, not about the zod this repository pins
// today, so a Dependabot bump of zod leaves these documents alone. GHSA-mrhx-c7xc-m3w5 covers zod
// below 4.6.6, its first patched version (GitHub's advisory database, read 2026-10-24).
const OVERRIDE = /"overrides": \{"zod": "(\d+)\.(\d+)\.(\d+)"\}/;
const FIRST_PATCHED_ZOD = [4, 6, 6];
const patched = (version: number[]) => {
  for (const [index, part] of version.entries()) {
    const floor = FIRST_PATCHED_ZOD[index] as number;
    if (part !== floor) return part > floor;
  }
  return true;
};

/** The six double-booking classes, each by words only its description uses. */
const CLASSES: [string, RegExp][] = [
  [
    'P1 first occurrence across a change (ENG-1)',
    /first occurrence[^.]*spans a daylight-saving change/,
  ],
  ['P2 repeated autumn hour (ENG-2)', /repeated hour of an autumn change/],
  ['P3 skipped-hour exception (ENG-3)', /cannot cancel or move an occurrence[^.]*skipped/],
  ['P4 occurrence longer than the gap (ENG-5)', /longer than the skipped hour/],
  ['P5 date-only UNTIL (ENG-7)', /date-only `UNTIL`/],
  // A one-off event too, so the notice must not say only recurring events are affected.
  [
    'P6 hour DURATION (ENG-6)',
    /`DURATION`[^.]*hours[^.]*single event[^.]*`DURATION:PT48H` occupies 47 hours/,
  ],
];

describe('the 0.2.0 known-issues notice', () => {
  const notice = () => flat(section(read(NOTICE_FILE), HEADING));

  it('names every double-booking class, the zod pin and its workaround, and 0.3.0', () => {
    const readme = notice();
    for (const [name, words] of CLASSES) expect(readme, name).toMatch(words);
    expect(readme).not.toMatch(/less time than a recurring event/);
    expect(readme).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(readme).toContain('zod 4.6.5');
    // The override moves a consumer to a zod past the advisory.
    const override = OVERRIDE.exec(readme);
    expect(override, 'the notice gives the override').not.toBeNull();
    expect(patched((override ?? []).slice(1).map(Number))).toBe(true);
    expect(readme).toContain('0.3.0');
  });

  it('stays true after 0.3.0: no audit date, no waiting for 0.3.0, no pin to it', () => {
    const readme = notice();
    expect(readme).not.toMatch(
      /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/,
    );
    expect(readme).not.toMatch(/once it is published|until 0\.3\.0|until then/i);
    expect(readme).not.toContain('slotlock@0.3.0');
  });

  it('is one line under the README\'s "Supported versions", not the README\'s opening', () => {
    // scripts/prepare-package.mjs packs README.md into every release: npm readers see it.
    expect(read('scripts/prepare-package.mjs')).toMatch(/^ {2}'README\.md',$/m);
    const text = read('README.md');
    expect(text).not.toContain('## Known issues');
    expect(text).not.toContain('slotlock@0.3.0');
    const supported = section(text, '## Supported versions');
    const pointers = supported.split('\n').filter((line) => line.includes(ANCHOR));
    expect(pointers).toHaveLength(1);
  });

  it('is a docs page on the site, linked from the landing page while 0.2 is current', () => {
    const page = read('site/docs-src/known-issues.md');
    expect(page).toContain(`<!-- include ${NOTICE_FILE}#${githubAnchor(HEADING)} body -->`);
    expect(read('site/astro.config.mjs')).toContain("'docs/known-issues'");
    expect(read('site/src/data/landing.ts')).toContain('/docs/known-issues/');
  });

  it('gives the v0.2.0 release-notes text and the advisory drafts the same facts', () => {
    // The notice is quoted there: read it without the quote markers.
    const notes = flat(read(NOTICE_FILE).replace(/^> ?/gm, ''));
    for (const [name, words] of CLASSES) expect(notes, name).toMatch(words);
    // The same override as the README's, wherever the notes give it.
    const workaround = OVERRIDE.exec(notice())?.[0] ?? 'the README override';
    expect(notes).toContain(workaround);
    expect(
      notes.match(new RegExp(OVERRIDE.source, 'g'))?.every((found) => found === workaround),
    ).toBe(true);
    expect(notes).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(notes).toMatch(/gh release edit v0\.2\.0 [^\n]*--notes-file notes\.md/);
    expect(notes).not.toMatch(/less time than a recurring event/);
    // The advisory counts the classes the notice lists.
    expect(CLASSES).toHaveLength(6);
    expect(notes).toContain('The cases are the six in the notice above');
    // Two advisories: the inherited zod one and the double booking, each for every release so far.
    expect(notes.match(/Affected versions: `<= 0\.2\.0`/g)).toHaveLength(2);
    expect(notes).toContain(ANCHOR);
  });
});

describe('the zod fix', () => {
  it('ships a zod past GHSA-mrhx-c7xc-m3w5, and the release notes after 0.2.0 say so', () => {
    const zod = (JSON.parse(read('package.json')) as { dependencies: Record<string, string> })
      .dependencies.zod as string;
    expect(patched(zod.split('.').map(Number)), `zod ${zod}`).toBe(true);
    // Everything above 0.2.0's heading: Unreleased now, the release that shipped the fix later.
    const changelog = read('CHANGELOG.md');
    const later = changelog.slice(0, changelog.search(/^## 0\.2\.0 - /m));
    expect(later, 'canary: 0.2.0 has a heading').not.toBe(changelog);
    const security = flat(section(later, '### Security'));
    expect(security).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(security).toMatch(/zod[^.]*4\.6\.5[^.]*4\.6\.7/);
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
