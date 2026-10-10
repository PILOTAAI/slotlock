// After `astro build`: pin the CSP to the inline code Starlight actually ships, and refuse a
// landing page that needs any inline code at all.
//
// 1. Collect the SHA-256 of every inline <script>, <style> and style="" value in dist/**/*.html.
//    Style attributes are allowed through `style-src-attr 'unsafe-hashes'` with their exact hashes
//    (Starlight sets CSS custom properties such as --sl-icon-size that way).
// 2. Fail if the landing page (dist/index.html) has an inline script, style block or style attribute.
// 3. Write the hashes into dist/_headers and check every line fits Cloudflare's 2,000 characters.
// 4. Fail if a built stylesheet ships -webkit-backdrop-filter without backdrop-filter beside it.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

async function* filesEndingWith(dir, suffix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesEndingWith(path, suffix);
    else if (entry.name.endsWith(suffix)) yield path;
  }
}
const htmlFiles = (dir) => filesEndingWith(dir, '.html');

const decode = (text) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
const sha = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const scripts = new Set();
const styles = new Set();
const attrs = new Set();
const problems = [];
const ids = new Map();
const links = [];
let pages = 0;

for await (const file of htmlFiles(DIST)) {
  pages += 1;
  const html = await readFile(file, 'utf8');
  const page = `/${relative(DIST, file)}`;
  const isLanding = page === '/index.html';
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attributes, body] = match;
    if (/type="application\/(ld\+)?json"/.test(attributes)) continue;
    if (isLanding) problems.push(`${page}: inline <script>`);
    scripts.add(sha(body));
  }
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    if (isLanding) problems.push(`${page}: inline <style>`);
    styles.add(sha(match[1]));
  }
  for (const match of html.matchAll(/\sstyle="([^"]*)"/g)) {
    if (isLanding) problems.push(`${page}: style="${match[1]}"`);
    attrs.add(sha(decode(match[1])));
  }
  ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))));
  for (const match of html.matchAll(/\shref="([^"]+)"/g)) {
    const href = decode(match[1]);
    if (href.startsWith('/') || href.startsWith('#')) links.push({ page, href });
  }
}

if (problems.length > 0) {
  console.error(
    `postbuild: the landing page must not need inline code:\n  ${problems.join('\n  ')}`,
  );
  process.exit(1);
}

// Every internal link must reach a built file, and every #fragment an id on that page.
async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
async function targetPage(pathname) {
  const clean = decodeURIComponent(pathname);
  const candidates = /\.[a-z0-9]+$/i.test(clean)
    ? [clean]
    : [`${clean.replace(/\/?$/, '/')}index.html`, `${clean.replace(/\/$/, '')}.html`];
  for (const candidate of candidates) {
    if (await exists(join(DIST, candidate))) return candidate;
  }
  return null;
}
const broken = [];
for (const { page, href } of links) {
  const [pathname, fragment] = href.split('#');
  const target = pathname ? await targetPage(pathname) : page;
  if (!target) {
    broken.push(`${page} → ${href} (no such file)`);
    continue;
  }
  if (fragment && target.endsWith('.html') && !ids.get(target)?.has(fragment)) {
    broken.push(`${page} → ${href} (no id "${fragment}" on ${target})`);
  }
}
if (broken.length > 0) {
  console.error(
    `postbuild: ${broken.length} broken internal link(s):\n  ${[...new Set(broken)].join('\n  ')}`,
  );
  process.exit(1);
}

// Lightning CSS, Vite's CSS minifier, keeps only the last of a property's prefixed and unprefixed
// declarations. The header once declared backdrop-filter before -webkit-backdrop-filter, shipped
// only the prefixed one, and lost its blur in Chrome and Firefox (the live page computed
// backdrop-filter: none in Chrome, 2026-10-10). Listed here: properties whose -webkit- form only
// Safari reads, so it must ship beside the unprefixed one. (Chrome reads -webkit-user-select, so a
// lone one in a dependency's stylesheet is not this defect.)
const STANDARD_PROPERTIES = ['backdrop-filter'];
const unpaired = [];
let rules = 0;
for await (const file of filesEndingWith(DIST, '.css')) {
  const css = await readFile(file, 'utf8');
  for (const [, block] of css.matchAll(/\{([^{}]*)\}/g)) {
    rules += 1;
    for (const property of STANDARD_PROPERTIES) {
      const declares = (name) => new RegExp(`(?:^|;)\\s*${name}\\s*:`).test(block);
      if (declares(`-webkit-${property}`) && !declares(property)) {
        unpaired.push(`${relative(DIST, file)}: -webkit-${property} without ${property} in {${block.slice(0, 100)}}`);
      }
    }
  }
}
if (rules === 0) {
  console.error('postbuild: found no CSS rules in dist, so the prefix check checked nothing');
  process.exit(1);
}
if (unpaired.length > 0) {
  console.error(
    `postbuild: ${unpaired.length} prefixed declaration(s) without the standard one, which Chrome and Firefox ignore (declare only the unprefixed property):\n  ${unpaired.join('\n  ')}`,
  );
  process.exit(1);
}

const headersPath = join(DIST, '_headers');
const template = await readFile(headersPath, 'utf8');
for (const placeholder of ['__SCRIPT_HASHES__', '__STYLE_HASHES__', '__STYLE_ATTR_HASHES__']) {
  if (!template.includes(placeholder)) {
    console.error(`postbuild: public/_headers lost its ${placeholder} placeholder`);
    process.exit(1);
  }
}
const headers = template
  .replaceAll('__SCRIPT_HASHES__', [...scripts].sort().join(' '))
  .replaceAll('__STYLE_HASHES__', [...styles].sort().join(' '))
  .replaceAll(
    '__STYLE_ATTR_HASHES__',
    attrs.size ? `'unsafe-hashes' ${[...attrs].sort().join(' ')}` : "'none'",
  );
const tooLong = headers.split('\n').filter((line) => line.length > 2000);
if (tooLong.length > 0) {
  console.error(
    `postbuild: ${tooLong.length} _headers line(s) exceed Cloudflare's 2,000 characters`,
  );
  process.exit(1);
}
await writeFile(headersPath, headers);
console.log(
  `postbuild: ${pages} pages; CSP allows ${scripts.size} inline script, ${styles.size} style and ${attrs.size} style-attribute hash(es), all from Starlight; the landing page has none.`,
);
