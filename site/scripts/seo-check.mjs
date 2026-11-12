// After `npm run build`: what search engines and link previews read, on every page, so a change
// cannot quietly drop a canonical, an image or the sitemap (docs/rfc/0005-search.md, Part 4).
//
//   npm run check:seo        exits 1 on any finding
//
// Every HTML page except the 404 page:
//   - one <title>, at most 65 characters, unique; one description of 70 to 160, unique;
//   - <html lang="en-GB">, exactly one <h1>, no noindex;
//   - a canonical that is absolute, on https://slotlock.pylota.io, ends in a slash, is the page's
//     own address, and is in the sitemap with a lastmod;
//   - og:title, og:description, og:url (the canonical), og:image (a 1200 × 630 PNG in dist/) and
//     twitter:card;
//   - JSON-LD that parses, on https://schema.org, with known types, and prices equal to the plans.
// The 404 page: noindex and no canonical. The sitemap: exactly the indexable pages. Links: every
// internal page link ends in a slash (each one without costs a redirect). robots.txt names the
// sitemap and shuts nothing. _headers keeps the Markdown twins and agent files out of the index.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://slotlock.pylota.io';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const FACTS = JSON.parse(await readFile(new URL('../src/generated/facts.json', import.meta.url), 'utf8'));
const TYPES = new Set([
  'Organization',
  'WebSite',
  'WebPage',
  'AboutPage',
  'CollectionPage',
  'ItemPage',
  'SoftwareApplication',
  'SoftwareSourceCode',
  'WebAPI',
  'Offer',
  'UnitPriceSpecification',
  'BreadcrumbList',
  'ListItem',
  'TechArticle',
  'BlogPosting',
  'FAQPage',
  'Question',
  'Answer',
]);

const problems = [];
const fail = (page, message) => problems.push(`${page}: ${message}`);

async function* html(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* html(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

const decode = (text) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
const head = (page) => page.split('</head>')[0] ?? '';
const meta = (h, key, value) => {
  const tag = new RegExp(`<meta[^>]*\\b${key}="${value}"[^>]*>`).exec(h)?.[0];
  return tag ? decode(/\bcontent="([^"]*)"/.exec(tag)?.[1] ?? '') : undefined;
};
const link = (h, rel) => {
  const tag = new RegExp(`<link[^>]*\\brel="${rel}"[^>]*>`).exec(h)?.[0];
  return tag ? decode(/\bhref="([^"]*)"/.exec(tag)?.[1] ?? '') : undefined;
};

/** Width and height of a PNG from its IHDR chunk. */
async function pngSize(path) {
  const bytes = await readFile(path);
  if (bytes.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const sitemapXml = (await readdir(DIST))
  .filter((file) => /^sitemap-\d+\.xml$/.test(file))
  .map((file) => file);
const sitemap = new Map();
for (const file of sitemapXml) {
  const xml = await readFile(join(DIST, file), 'utf8');
  for (const url of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(url[1])?.[1];
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(url[1])?.[1];
    if (loc) sitemap.set(loc, lastmod);
  }
}
if (sitemap.size === 0) fail('sitemap', 'no URLs in dist/sitemap-*.xml');

const prices = new Map(
  (FACTS.plans ?? []).map((plan) => [plan.id, String(plan.monthly)]),
);
const titles = new Map();
const descriptions = new Map();
const indexable = new Set();
const images = new Map();
let pages = 0;

for await (const file of html(DIST)) {
  const page = `/${relative(DIST, file)}`;
  const text = await readFile(file, 'utf8');
  const h = head(text);
  pages += 1;

  if (page === '/404.html') {
    if (meta(h, 'name', 'robots') !== 'noindex') fail(page, 'the not-found page needs <meta name="robots" content="noindex">');
    if (link(h, 'canonical')) fail(page, 'the not-found page must have no canonical');
    continue;
  }

  const url = `${SITE}${page.replace(/index\.html$/, '')}`;
  indexable.add(url);

  const titleTags = [...h.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1]));
  if (titleTags.length !== 1) fail(page, `${titleTags.length} <title> elements`);
  const title = titleTags[0] ?? '';
  if (title.length > 65) fail(page, `title is ${title.length} characters (at most 65): "${title}"`);
  if (titles.has(title)) fail(page, `title "${title}" is also ${titles.get(title)}'s`);
  titles.set(title, page);

  const description = meta(h, 'name', 'description') ?? '';
  if (description.length < 70 || description.length > 160) {
    fail(page, `description is ${description.length} characters (70 to 160): "${description}"`);
  }
  if (descriptions.has(description)) fail(page, `description is also ${descriptions.get(description)}'s`);
  descriptions.set(description, page);

  if (!/<html[^>]*\blang="en-GB"/.test(text)) fail(page, '<html> is not lang="en-GB"');
  const h1 = (text.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1) fail(page, `${h1} <h1> elements`);
  if (/noindex/.test(meta(h, 'name', 'robots') ?? '')) fail(page, 'noindex on a page in the sitemap');

  const canonical = link(h, 'canonical');
  if (canonical !== url) fail(page, `canonical ${canonical ?? '(none)'} is not ${url}`);
  if (!sitemap.has(url)) fail(page, 'not in the sitemap');
  else if (!sitemap.get(url)) fail(page, 'no lastmod in the sitemap');

  for (const property of ['og:title', 'og:description', 'og:image']) {
    if (!meta(h, 'property', property)) fail(page, `no ${property}`);
  }
  if (meta(h, 'property', 'og:url') !== url) fail(page, `og:url is not ${url}`);
  if (!meta(h, 'name', 'twitter:card')) fail(page, 'no twitter:card');
  const image = meta(h, 'property', 'og:image') ?? '';
  if (image) {
    if (!image.startsWith(`${SITE}/og/`)) fail(page, `og:image ${image} is not in /og/`);
    else images.set(image.slice(SITE.length), page);
  }

  for (const match of text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (error) {
      fail(page, `JSON-LD does not parse: ${error.message}`);
      continue;
    }
    if (data['@context'] !== 'https://schema.org') fail(page, 'JSON-LD @context is not https://schema.org');
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node['@type'] && !TYPES.has(node['@type'])) fail(page, `JSON-LD type ${node['@type']} is not one this site uses`);
      if (node['@type'] === 'Offer' && /Slotlock Cloud (\w+)/.test(node.name ?? '')) {
        const id = /Slotlock Cloud (\w+)/.exec(node.name)[1].toLowerCase();
        if (prices.get(id) !== node.price) fail(page, `offer ${node.name} is ${node.price}, the plan is ${prices.get(id)}`);
      }
      Object.values(node).forEach(walk);
    };
    walk(data);
  }

  for (const match of text.matchAll(/\shref="(\/[^"#?]*)/g)) {
    const href = decode(match[1]);
    const last = href.split('/').at(-1) ?? '';
    if (href !== '/' && !href.endsWith('/') && !last.includes('.')) {
      fail(page, `link ${href} has no trailing slash (a redirect for every visitor and crawler)`);
    }
  }
}

for (const [image, page] of images) {
  const size = await pngSize(join(DIST, image)).catch(() => null);
  if (!size) fail(page, `og:image ${image} is not a PNG in dist/`);
  else if (size.width !== 1200 || size.height !== 630) fail(page, `og:image ${image} is ${size.width} × ${size.height}, not 1200 × 630`);
}
for (const url of sitemap.keys()) {
  if (!indexable.has(url)) fail('sitemap', `${url} is not a page (or is the not-found page)`);
}

const robots = await readFile(join(DIST, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${SITE}/sitemap-index.xml`)) fail('robots.txt', 'does not name the sitemap');
if (/^Disallow:\s*\/\s*$/m.test(robots)) fail('robots.txt', 'shuts the whole site');

const headers = await readFile(join(DIST, '_headers'), 'utf8');
for (const rule of ['/:page.md', '/docs/:page.md', '/docs/api/:page.md', '/blog/:page.md', '/use-cases/:page.md', '/compare/:page.md']) {
  if (!headers.includes(`\n${rule}\n  Link: <${SITE}`)) fail('_headers', `no canonical Link for ${rule}`);
}
for (const file of ['/llms.txt', '/llms-full.txt', '/openapi.json']) {
  const block = headers.split(`\n${file}\n`)[1]?.split('\n\n')[0] ?? '';
  if (!block.includes('X-Robots-Tag: noindex')) fail('_headers', `${file} is not noindex`);
}

if (problems.length > 0) {
  console.log(problems.join('\n'));
  console.log(`SEO check: ${problems.length} finding(s) in ${pages} pages.`);
  process.exit(1);
}
console.log(
  `SEO check: ${pages} pages, ${indexable.size} in the sitemap with lastmod, ${images.size} preview images; no findings.`,
);
