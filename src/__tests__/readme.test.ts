// The README is the front door: what Slotlock is, how to run it, and where each topic is
// documented. Topics live on the docs site (site/docs-src); these checks keep the README short
// and every link in it working, on GitHub and on npm, which packs it into every release.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const readme = read('README.md');
const DOCS = 'https://slotlock.pylota.io/docs/';
/** The README without its code blocks, which are commands and examples, not prose. */
const prose = readme.replace(/```[\s\S]*?```/g, '');

/** GitHub's and Starlight's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

const headings = (markdown: string) =>
  [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)].map(([, text]) =>
    slug(text as string),
  );

describe('the README', () => {
  it('stays short', () => {
    const lines = readme.split('\n').length;
    const words = readme.split(/\s+/).filter(Boolean).length;
    const instead = 'document the topic on its docs page instead';
    expect(lines, `README lines: ${instead}`).toBeLessThanOrEqual(250);
    expect(words, `README words: ${instead}`).toBeLessThanOrEqual(2_000);
  });

  it('has no long paragraph or list item', () => {
    const blocks = prose
      .split(/\n\s*\n/)
      .filter((block) => !/^\s*(\||#|<!--)/.test(block))
      .flatMap((block) => block.split(/\n(?=- |\d+\. )/));
    for (const block of blocks) {
      const words = block.split(/\s+/).filter(Boolean).length;
      const message = `a ${words}-word paragraph belongs on a docs page:\n${block}`;
      expect(words, message).toBeLessThanOrEqual(120);
    }
  });

  it('keeps its sections, so a new topic goes on a docs page', () => {
    const sections = [...prose.matchAll(/^## (.+)$/gm)].map(([, text]) => text);
    expect(sections).toEqual([
      'Why it is built for agents',
      'Get started',
      'Connect an agent',
      'Documentation',
      'Supported versions',
      'Project status and boundaries',
      'License',
    ]);
  });

  it('links only to docs pages and headings that exist', () => {
    const pages = new Set(
      readdirSync(join(root, 'site', 'docs-src'))
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.replace(/\.md$/, '')),
    );
    // The REST reference is generated from openapi.json (site/scripts/api-reference.mjs).
    pages.add('api');
    const links = [...readme.matchAll(/\]\((https:\/\/slotlock\.pylota\.io\/docs\/[^)\s]*)\)/g)].map(
      ([, url]) => url as string,
    );
    expect(links.length, 'canary: the README links the docs').toBeGreaterThan(10);
    for (const url of links) {
      const [path = '', fragment] = url.slice(DOCS.length).split('#');
      const page = path.replace(/\/$/, '') || 'index';
      expect(pages.has(page), `${url}: no site/docs-src/${page}.md`).toBe(true);
      if (fragment !== undefined && page !== 'api') {
        expect(headings(read(`site/docs-src/${page}.md`)), `${url}: no such heading`).toContain(
          fragment,
        );
      }
    }
  });

  it('links only to files and sections that exist', () => {
    const own = headings(readme);
    for (const [, target] of readme.matchAll(/\]\(((?!https?:|mailto:)[^)\s]+)\)/g)) {
      const [path = '', fragment] = (target as string).split('#');
      if (path === '') {
        expect(own, `#${fragment}: no such README heading`).toContain(fragment);
      } else {
        expect(existsSync(join(root, path)), `${target}: no such file`).toBe(true);
      }
    }
  });
});
