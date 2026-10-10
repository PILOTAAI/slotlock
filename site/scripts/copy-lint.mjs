// Pylota's voice rules, applied to the words a visitor reads on slotlock.pylota.io.
//
// A port of the text rules in @pylota/copy-lint (packages/copy-lint/src/index.ts on PILOTAAI/pylota
// main at 4808094c8): no em dash, no literal double hyphen, none of its banned filler words and
// none of its empty phrases. Code (<pre>, <code>) is not copy and is skipped, as are the pages
// rendered verbatim from the repository's README/SPEC/CHANGELOG (they are linted where they live).
//
// It also counts the landing page's words, the budget the design brief sets (about 1,200).
//
//   npm run check:copy        run after `npm run build`; exits 1 on any finding
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BANNED_WORDS = [
  'leverage',
  'leverages',
  'leveraged',
  'leveraging',
  'delve',
  'delves',
  'delved',
  'delving',
  'utilize',
  'utilise',
  'utilizes',
  'utilises',
  'utilized',
  'utilised',
  'utilizing',
  'utilising',
  'facilitate',
  'facilitates',
  'facilitated',
  'facilitating',
  'streamline',
  'streamlines',
  'streamlined',
  'streamlining',
  'elevate',
  'elevates',
  'elevated',
  'elevating',
  'supercharge',
  'supercharges',
  'supercharged',
  'supercharging',
  'unleash',
  'unleashes',
  'unleashed',
  'unleashing',
  'revolutionize',
  'revolutionise',
  'revolutionizes',
  'revolutionises',
  'revolutionizing',
  'revolutionising',
  'empower',
  'empowers',
  'empowered',
  'empowering',
  'empowerment',
  'embark',
  'embarks',
  'embarked',
  'embarking',
  'seamless',
  'seamlessly',
  'robust',
  'cutting-edge',
  'state-of-the-art',
  'best-in-class',
  'world-class',
  'realm',
  'tapestry',
  'testament',
  'ever-evolving',
  'game-changer',
  'game changer',
  'game-changing',
  'paradigm',
  'transformative',
  'synergy',
  'holistic',
  'myriad',
  'plethora',
  'meticulous',
  'meticulously',
];

const EMPTY_PHRASES = [
  "it's important to note",
  'it is important to note',
  "it's worth noting",
  'it is worth noting',
  'at the end of the day',
  'when it comes to',
  'in the world of',
  "in today's fast-paced world",
  'needless to say',
  'it goes without saying',
  'the fact of the matter is',
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (terms) =>
  new RegExp(
    `\\b(?:${[...new Set(terms)]
      .map(escape)
      .sort((a, b) => b.length - a.length)
      .join('|')})\\b`,
    'gi',
  );
const BANNED_RE = alternation(BANNED_WORDS);
const EMPTY_RE = alternation(EMPTY_PHRASES);

/** Lint one string; same rules and messages as @pylota/copy-lint's lintCopy. */
export function lintCopy(text) {
  const findings = [];
  for (const m of text.matchAll(/—/g))
    findings.push({ rule: 'em-dash', match: m[0], index: m.index });
  for (const m of text.matchAll(/--/g))
    findings.push({ rule: 'double-hyphen', match: m[0], index: m.index });
  for (const m of text.matchAll(BANNED_RE))
    findings.push({ rule: 'banned-word', match: m[0], index: m.index });
  for (const m of text.matchAll(EMPTY_RE))
    findings.push({ rule: 'empty-phrase', match: m[0], index: m.index });
  return findings.sort((a, b) => a.index - b.index);
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** The visible prose of an HTML page: no scripts, styles, code, or tags. */
export function visibleProse(html) {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|pre|code|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (_, name) => entities[name] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text a person reads but that is not in the page body: titles, descriptions, aria-labels. */
function attributeCopy(html) {
  const out = [];
  for (const m of html.matchAll(/\b(?:aria-label|title|content|alt)="([^"]*)"/g)) out.push(m[1]);
  for (const m of html.matchAll(/<title>([^<]*)<\/title>/g)) out.push(m[1]);
  return out.join(' \n ');
}

const DIST = new URL('../dist/', import.meta.url);
// Pages written for this site. Several mix site copy with README sections, and the tools
// reference adds the registry's descriptions; the README is held to the same rules in its own
// repository review.
const PAGES = [
  'index.html',
  'index.md',
  'docs/index.html',
  'docs/quickstart/index.html',
  'docs/connect/index.html',
  'docs/library/index.html',
  'docs/concepts/index.html',
  'docs/security/index.html',
  'docs/tools/index.html',
  'docs/reference/index.html',
  '404.html',
  'llms.txt',
];
const LANDING_SOURCES = ['../src/data/landing.ts'];

let failures = 0;
for (const page of PAGES) {
  const raw = await readFile(new URL(page, DIST), 'utf8');
  const text = page.endsWith('.html')
    ? `${visibleProse(raw)}\n${attributeCopy(raw)}`
    : raw
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        // Markdown table delimiter rows (| --- |) are syntax, not copy.
        .replace(/^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*$/gm, ' ');
  for (const finding of lintCopy(text)) {
    failures += 1;
    const context = text
      .slice(Math.max(0, finding.index - 40), finding.index + 40)
      .replace(/\s+/g, ' ');
    console.log(`${page}: ${finding.rule} "${finding.match}" in "…${context}…"`);
  }
}
for (const source of LANDING_SOURCES) {
  const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
  for (const finding of lintCopy(text)) {
    failures += 1;
    console.log(`${source}: ${finding.rule} "${finding.match}"`);
  }
}

const landing = await readFile(new URL('index.html', DIST), 'utf8');
const main = /<main[\s\S]*?<\/main>/.exec(landing)?.[0] ?? '';
const footer = /<footer[\s\S]*?<\/footer>/.exec(landing)?.[0] ?? '';
const words = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.:/_-]*/gu) ?? []).length;
const prose = words(visibleProse(`${main}${footer}`));
const withCode = words(
  `${main}${footer}`
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, ' '),
);
const labels = [...main.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(' ');
console.log(
  `Landing page words: ${prose} of visible prose (code samples excluded), ${withCode} including code samples; scene descriptions for screen readers add ${words(labels)}.`,
);
console.log(failures === 0 ? 'Copy lint: no findings.' : `Copy lint: ${failures} finding(s).`);
process.exit(failures === 0 ? 0 : 1);
