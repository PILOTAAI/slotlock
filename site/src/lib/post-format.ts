// A blog post as a file (RFC 0006, 4.5): site/content/blog/<slug>.md, a few lines of frontmatter and
// a Markdown body. The site renders it here at build time, and the admin console's editor renders it
// here too for its preview and its checks, so the preview is the page and the checks are the site's.
//
// The Markdown is a strict subset, rendered without any library and without raw HTML: every
// character of the source is escaped, so a post can never carry a script, a style or an iframe, and
// the site's CSP needs nothing for it. What it takes:
//   ## and ### headings; paragraphs; - and 1. lists; > quotes; GitHub tables;
//   ``` code fences, optionally ```sql caption="What it shows";
//   ![alt text](/blog/<slug>/<file>.png) images on a line of their own (alt text required);
//   `code`, **strong**, *emphasis*, [links](/site/path), [links](https://…) inline;
//   {{facts.name}}: a number or text generated from Slotlock's code (site/src/generated/facts.json).
// Dependency-free, so the admin Worker bundles it as it is.
import { BANNED_WORDS, EMPTY_PHRASES } from '../data/copy-rules.mjs';

/** A post's frontmatter: what the page's head, card, feed and structured data say. */
export interface PostFront {
  title: string;
  /** The <title>, when the headline is longer than 65 characters. */
  seoTitle?: string;
  description: string;
  /** ISO dates, YYYY-MM-DD. */
  date: string;
  updated?: string;
  /** A key of site/src/data/authors.json. */
  author: string;
  tags: string[];
  /** The Open Graph image's name, public/og/<image>.png, drawn by scripts/og-images.mjs. */
  image: string;
  imageAlt: string;
  /** The image's small heading: Blog unless given (a case study says so). */
  eyebrow?: string;
  /** Only published posts are built. Drafts live on the CMS's branches, never on main. */
  status: 'draft' | 'published';
  /** When a scheduled post may be merged (ISO 8601, UTC). */
  publishAt?: string;
  related: { label: string; href: string }[];
}

export interface ParsedPost {
  slug: string;
  front: PostFront;
  body: string;
}

export interface PostAuthor {
  name: string;
  url: string;
  type: 'Person' | 'Organization';
}

export class PostFormatError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
  }
}

/** A post's slug: its file name and its path, /blog/<slug>/. */
export const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/;
const IMAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;
/** Where a post's own images live, in the repository and on the site. */
export const postImagePath = (slug: string) => `/blog/${slug}/`;
const IMAGE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp)$/;
/** A link a post may make: a site path, an anchor, or an https address. Authors' URLs keep to it too. */
export const POST_LINK = /^(?:\/[^\s<>"']*|#[A-Za-z0-9_-]+|https:\/\/[^\s<>"']+)$/;
const LINK = POST_LINK;
/** A field on one line: no control character (a newline above all), nor a line or paragraph separator. */
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;
const FACT = /\{\{facts\.([A-Za-z][A-Za-z0-9]{0,63})\}\}/g;

const SCALARS = ['title', 'seoTitle', 'description', 'date', 'updated', 'author', 'image', 'imageAlt', 'eyebrow', 'status', 'publishAt'] as const;
const LISTS = ['tags', 'related'] as const;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON: the text as it is.
    }
  }
  return value;
}

/** A value written so the parser reads it back exactly: plain when it can be, JSON-quoted when not. */
function quote(value: string): string {
  return value !== '' && value === value.trim() && !value.startsWith('"') && !value.includes('\n') ? value : JSON.stringify(value);
}

/**
 * Read a post's file: `---`, `key: value` lines and `key:` lists of `  - item` lines, `---`, then
 * the body. A related link is `  - Label | /path`. Throws PostFormatError on anything else.
 */
export function parsePost(source: string, slug: string): ParsedPost {
  if (!POST_SLUG.test(slug)) throw new PostFormatError(`"${slug}" is not a post slug (lowercase words and hyphens)`);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') throw new PostFormatError('a post starts with a --- line', 1);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new PostFormatError('the frontmatter has no closing --- line');
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let list: string | null = null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] as string;
    const number = index + 1;
    if (line.trim() === '' || line.startsWith('#')) continue;
    const item = /^ {2}- (.+)$/.exec(line);
    if (item) {
      if (!list) throw new PostFormatError('a list item belongs under a key', number);
      (lists[list] as string[]).push(unquote((item[1] as string).trim()));
      continue;
    }
    const pair = /^([A-Za-z]+):(?: (.*))?$/.exec(line);
    if (!pair) throw new PostFormatError(`"${line}" is not "key: value"`, number);
    const key = pair[1] as string;
    const value = (pair[2] ?? '').trim();
    if ((SCALARS as readonly string[]).includes(key)) {
      if (key in scalars) throw new PostFormatError(`${key} is given twice`, number);
      if (value === '') throw new PostFormatError(`${key} has no value`, number);
      scalars[key] = unquote(value);
      list = null;
    } else if ((LISTS as readonly string[]).includes(key)) {
      if (key in lists) throw new PostFormatError(`${key} is given twice`, number);
      if (value !== '') throw new PostFormatError(`${key} is a list: put each item on its own "  - " line`, number);
      lists[key] = [];
      list = key;
    } else {
      throw new PostFormatError(`${key} is not a field of a post`, number);
    }
  }
  const required = (key: string) => {
    const value = scalars[key];
    if (value === undefined) throw new PostFormatError(`${key} is missing`);
    return value;
  };
  const status = scalars.status ?? 'draft';
  if (status !== 'draft' && status !== 'published') throw new PostFormatError('status is draft or published');
  const front: PostFront = {
    title: required('title'),
    description: required('description'),
    date: required('date'),
    author: required('author'),
    tags: lists.tags ?? [],
    image: scalars.image ?? `blog-${slug}`,
    imageAlt: scalars.imageAlt ?? required('title'),
    status,
    related: (lists.related ?? []).map((entry) => {
      const split = entry.lastIndexOf(' | ');
      if (split < 0) throw new PostFormatError(`related "${entry}" is "Label | /path"`);
      return { label: entry.slice(0, split).trim(), href: entry.slice(split + 3).trim() };
    }),
  };
  for (const key of ['seoTitle', 'updated', 'eyebrow', 'publishAt'] as const) {
    if (scalars[key] !== undefined) front[key] = scalars[key];
  }
  // Every field but the body is one line: a newline in a title would reach the commit message the
  // console writes, and a page's head, as more than the title.
  const oneLine: [string, string][] = [
    ['title', front.title], ['seoTitle', front.seoTitle ?? ''], ['description', front.description],
    ['author', front.author], ['imageAlt', front.imageAlt], ['eyebrow', front.eyebrow ?? ''],
    ...front.tags.map((tag): [string, string] => ['tags', tag]),
    ...front.related.flatMap((link): [string, string][] => [['related', link.label], ['related', link.href]]),
  ];
  for (const [key, value] of oneLine) {
    if (NOT_ONE_LINE.test(value)) throw new PostFormatError(`${key} holds a line break or another control character`);
  }
  for (const link of front.related) {
    if (!LINK.test(link.href)) throw new PostFormatError(`related "${link.label}" links to "${link.href}": a /path, a #anchor or an https:// address`);
  }
  if (!DATE.test(front.date)) throw new PostFormatError('date is YYYY-MM-DD');
  if (front.updated !== undefined && !DATE.test(front.updated)) throw new PostFormatError('updated is YYYY-MM-DD');
  if (front.publishAt !== undefined && !DATETIME.test(front.publishAt)) throw new PostFormatError('publishAt is YYYY-MM-DDTHH:MMZ, in UTC');
  if (!IMAGE_NAME.test(front.image)) throw new PostFormatError('image is a name of lowercase words and hyphens');
  return { slug, front, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/** Write a post's file, frontmatter then body, so parsePost reads it back the same. */
export function serializePost(post: ParsedPost): string {
  const { front } = post;
  const lines = ['---', `title: ${quote(front.title)}`];
  if (front.seoTitle) lines.push(`seoTitle: ${quote(front.seoTitle)}`);
  lines.push(`description: ${quote(front.description)}`, `date: ${front.date}`);
  if (front.updated) lines.push(`updated: ${front.updated}`);
  lines.push(`author: ${quote(front.author)}`);
  lines.push('tags:', ...front.tags.map((tag) => `  - ${quote(tag)}`));
  lines.push(`image: ${front.image}`, `imageAlt: ${quote(front.imageAlt)}`);
  if (front.eyebrow) lines.push(`eyebrow: ${quote(front.eyebrow)}`);
  lines.push(`status: ${front.status}`);
  if (front.publishAt) lines.push(`publishAt: ${front.publishAt}`);
  lines.push('related:', ...front.related.map((link) => `  - ${quote(`${link.label} | ${link.href}`)}`));
  lines.push('---', '');
  return `${lines.join('\n')}${post.body.replace(/\n*$/, '\n')}`;
}

/** {{facts.name}} with its value; one with no value is left as it is, and named in `unknown`. */
export function resolveFacts(text: string, facts: Readonly<Record<string, unknown>>): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const resolved = text.replace(FACT, (whole, name: string) => {
    const value = facts[name];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    unknown.push(name);
    return whole;
  });
  return { text: resolved, unknown };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** What rendering a body found: what the checks look at. */
export interface RenderedBody {
  html: string;
  images: { src: string; alt: string }[];
  links: string[];
  /** The prose a reader reads (no code), for the copy rules and the word count. */
  prose: string;
  /** Problems the source has that the renderer worked around, each with its line. */
  problems: string[];
}

/** One line of text: `code`, [links](…), **strong** and *emphasis*, everything else escaped. */
function inline(text: string, found: { links: string[]; problems: string[]; prose: string[] }, line: number): string {
  return text
    .split('`')
    .map((part, index) => {
      if (index % 2 === 1) return `<code>${escapeHtml(part)}</code>`;
      let out = '';
      let last = 0;
      for (const link of part.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        out += emphasis(part.slice(last, link.index), found);
        const label = link[1] as string;
        const href = link[2] as string;
        found.prose.push(label);
        if (LINK.test(href)) {
          found.links.push(href);
          out += `<a href="${escapeHtml(href)}">${emphasis(label, { prose: [] })}</a>`;
        } else {
          found.problems.push(`line ${line}: the link "${href}" is not a site path, #anchor or https:// address`);
          out += escapeHtml(label);
        }
        last = link.index + link[0].length;
      }
      return out + emphasis(part.slice(last), found);
    })
    .join('');
}

function emphasis(text: string, found: { prose: string[] }): string {
  found.prose.push(text);
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;

/**
 * The body as HTML, in the shapes the site's article styles (pages.css) expect: h2, h3, p, ul, ol,
 * blockquote, figure with figcaption and pre > code, figure with img, and table with thead and tbody.
 */
export function renderPostBody(body: string, options: { slug: string; facts?: Readonly<Record<string, unknown>> }): RenderedBody {
  const facts = options.facts ? resolveFacts(body, options.facts) : { text: body, unknown: [] as string[] };
  const lines = facts.text.replace(/\r\n?/g, '\n').split('\n');
  const found = { links: [] as string[], problems: [] as string[], prose: [] as string[] };
  for (const name of facts.unknown) found.problems.push(`{{facts.${name}}} is not a fact the site knows`);
  const images: { src: string; alt: string }[] = [];
  const out: string[] = [];
  let paragraph: string[] = [];
  let paragraphLine = 0;
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '), found, paragraphLine)}</p>`);
    paragraph = [];
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const number = index + 1;
    const fence = /^```([a-z0-9+-]*)(?:\s+caption="([^"]*)")?\s*$/.exec(line);
    if (fence) {
      flush();
      const close = lines.indexOf('```', index + 1);
      if (close < 0) {
        found.problems.push(`line ${number}: a code block is not closed with \`\`\``);
        break;
      }
      const code = lines.slice(index + 1, close).join('\n');
      const language = fence[1] ? ` class="language-${fence[1]}"` : '';
      const caption = fence[2] ? `<figcaption class="post-meta">${escapeHtml(fence[2])}</figcaption>` : '';
      if (fence[2]) found.prose.push(fence[2]);
      out.push(`<figure>${caption}<pre><code${language}>${escapeHtml(code)}</code></pre></figure>`);
      index = close;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      if (level !== 2 && level !== 3) found.problems.push(`line ${number}: use ## or ### for a heading (the title is the page's only #)`);
      const tag = level <= 2 ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(heading[2] as string, found, number)}</${tag}>`);
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
    if (image) {
      flush();
      const alt = (image[1] as string).trim();
      const src = image[2] as string;
      images.push({ src, alt });
      const local = src.startsWith(postImagePath(options.slug)) && IMAGE_FILE.test(src.slice(postImagePath(options.slug).length));
      if (!local) found.problems.push(`line ${number}: an image is a file of this post, ${postImagePath(options.slug)}<name>.png, .jpg or .webp`);
      if (!alt) found.problems.push(`line ${number}: an image needs alt text: ![what it shows](${src})`);
      if (local) out.push(`<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></figure>`);
      continue;
    }
    if (line.trimStart().startsWith('|') && TABLE_RULE.test((lines[index + 1] ?? '').trim())) {
      flush();
      const columns = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] as string).trimStart().startsWith('|')) {
        rows.push(tableCells(lines[index] as string));
        index += 1;
      }
      index -= 1;
      out.push(
        `<table><thead><tr>${columns.map((column) => `<th scope="col">${inline(column, found, number)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${columns.map((_, cell) => `<td>${inline(row[cell] ?? '', found, number)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    const bullet = /^- (.+)$/.exec(line);
    const numbered = /^\d+\. (.+)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(((bullet ?? numbered) as RegExpExecArray)[1] as string, found, number));
      continue;
    }
    if (list && /^ {2,}\S/.test(line)) {
      // A list item's text continued on the next line.
      list.items[list.items.length - 1] += ` ${inline(line.trim(), found, number)}`;
      continue;
    }
    const quoted = /^> ?(.*)$/.exec(line);
    if (quoted) {
      flush();
      out.push(`<blockquote><p>${inline(quoted[1] as string, found, number)}</p></blockquote>`);
      continue;
    }
    if (/^\s*<\/?[A-Za-z]/.test(line)) found.problems.push(`line ${number}: HTML is shown as text, never run: write Markdown instead`);
    if (!paragraph.length) paragraphLine = number;
    paragraph.push(line.trim());
  }
  flush();
  return { html: out.join('\n'), images, links: found.links, prose: found.prose.join(' '), problems: found.problems };
}

/** A site link as an absolute one, for the Markdown twin. */
const absoluteLinks = (text: string, site: string) => text.replace(/\]\(\//g, `](${site}/`);

/**
 * The post as Markdown, for /blog/<slug>.md and llms.txt: the title, description, date and author,
 * the body with facts filled in and site links made absolute, and its related pages.
 */
export function postTwin(post: ParsedPost, options: { site: string; author: PostAuthor; longDate: string; facts?: Readonly<Record<string, unknown>> }): string {
  const body = options.facts ? resolveFacts(post.body, options.facts).text : post.body;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  for (const line of lines) {
    const fence = /^```([a-z0-9+-]*)(?:\s+caption="([^"]*)")?\s*$/.exec(line);
    if (fence && !inCode) {
      inCode = true;
      if (fence[2]) out.push(`${fence[2]}:`, '');
      out.push(`\`\`\`${fence[1] ?? ''}`);
      continue;
    }
    if (line === '```' && inCode) {
      inCode = false;
      out.push(line);
      continue;
    }
    out.push(inCode ? line : absoluteLinks(line, options.site));
  }
  return `${[
    `# ${post.front.title}`,
    `> ${post.front.description}`,
    `${options.longDate} · ${options.author.name}`,
    out.join('\n').trim(),
    `Related: ${post.front.related.map((link) => `[${link.label}](${link.href.startsWith('/') ? `${options.site}${link.href}` : link.href})`).join(' · ')}`,
    `Page: ${options.site}/blog/${post.slug}/`,
  ].join('\n\n')}\n`;
}

/** One check's result, as the console lists it before a post is submitted. */
export interface PostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (terms: readonly string[]) =>
  new RegExp(`\\b(?:${[...new Set(terms)].map(escapeRegex).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');
const BANNED = alternation(BANNED_WORDS);
const EMPTY = alternation(EMPTY_PHRASES);
/**
 * The fewest words a post's body has. The site's copy lint asks 400 of the whole page
 * (scripts/copy-lint.mjs), which the title, description, related links and closing add to.
 */
export const POST_MIN_WORDS = 300;

/** The copy rules of scripts/copy-lint.mjs on some text: each finding, in words. */
export function copyFindings(text: string): string[] {
  const findings: string[] = [];
  if (text.includes('—')) findings.push('an em dash (—): use a colon, a comma or two sentences');
  if (text.includes('--')) findings.push('a double hyphen (--)');
  for (const match of text.matchAll(BANNED)) findings.push(`"${match[0]}", a word the site does not use`);
  for (const match of text.matchAll(EMPTY)) findings.push(`"${match[0]}", a phrase that says nothing`);
  return findings;
}

/**
 * The checks a post must pass before it is submitted, the same the site's build runs: the copy
 * rules, the title and description lengths of the SEO check, alt text on every image, links to
 * pages that exist (when the site's paths are given), a description no other post has, related
 * links, a known author, and enough words.
 */
export function checkPost(
  post: ParsedPost,
  rendered: RenderedBody,
  context: {
    authors: Readonly<Record<string, PostAuthor>>;
    /** Every path the site has, /blog/x/ style; leave out to skip the link check. */
    sitePaths?: ReadonlySet<string>;
    /** Other posts' descriptions, by slug. */
    otherDescriptions?: Readonly<Record<string, string>>;
    /** The file names in the post's image folder; leave out to skip checking each image is there. */
    imageFiles?: ReadonlySet<string>;
  },
): PostCheck[] {
  const { front } = post;
  const title = front.seoTitle ?? front.title;
  const words = rendered.prose.split(/\s+/).filter(Boolean).length;
  const copy = copyFindings([front.title, front.seoTitle ?? '', front.description, front.imageAlt, rendered.prose].join('\n'));
  const pathOf = (href: string) => href.split('#')[0]?.split('?')[0] ?? '';
  const missing = context.sitePaths
    ? [...new Set(rendered.links.filter((href) => href.startsWith('/') && !href.startsWith(postImagePath(post.slug))).map(pathOf))]
        .filter((path) => {
          const known = context.sitePaths as ReadonlySet<string>;
          return !known.has(path) && !known.has(path.endsWith('/') ? path : `${path}/`);
        })
    : [];
  const same = Object.entries(context.otherDescriptions ?? {}).find(([slug, description]) => slug !== post.slug && description.trim() === front.description.trim());
  const related = front.related;
  const absent = context.imageFiles
    ? rendered.images.map((image) => image.src.slice(postImagePath(post.slug).length)).filter((file) => !(context.imageFiles as ReadonlySet<string>).has(file))
    : [];
  const altless = rendered.images.filter((image) => image.alt.length === 0 || image.alt.length > 200).length;
  return [
    { name: 'Markdown', ok: rendered.problems.length === 0, detail: rendered.problems.join('; ') || 'Every line renders as written.' },
    { name: 'Copy rules', ok: copy.length === 0, detail: copy.join('; ') || 'No em dashes, filler words or empty phrases.' },
    { name: 'Search title', ok: title.length >= 20 && title.length <= 65, detail: `${title.length} characters (20 to 65)${front.seoTitle ? ', the search title' : ''}.` },
    { name: 'Description', ok: front.description.length >= 70 && front.description.length <= 160, detail: `${front.description.length} characters (70 to 160).` },
    { name: 'Unique description', ok: !same, detail: same ? `The same as the post ${same[0]}.` : 'No other post has it.' },
    {
      name: 'Images',
      ok: altless === 0 && absent.length === 0,
      detail: absent.length
        ? `Not uploaded: ${absent.join(', ')}.`
        : altless
          ? `${altless} without alt text of 1 to 200 characters.`
          : rendered.images.length ? `${rendered.images.length} with alt text of 1 to 200 characters.` : 'No images.',
    },
    { name: 'Links', ok: missing.length === 0, detail: context.sitePaths ? (missing.length ? `No page at ${missing.join(', ')}.` : `${rendered.links.length} links, each to a page that exists.`) : 'Not checked: the site\'s pages could not be read.' },
    { name: 'Related pages', ok: related.length >= 1 && related.length <= 4 && related.every((link) => LINK.test(link.href) && link.label.length > 0), detail: `${related.length} (1 to 4, each "Label | /path").` },
    { name: 'Author', ok: Object.hasOwn(context.authors, front.author), detail: Object.hasOwn(context.authors, front.author) ? (context.authors[front.author] as PostAuthor).name : `"${front.author}" is not in site/src/data/authors.json.` },
    { name: 'Tags', ok: front.tags.length >= 1 && front.tags.length <= 5, detail: `${front.tags.length} (1 to 5).` },
    { name: 'Length', ok: words >= POST_MIN_WORDS, detail: `${words} words (at least ${POST_MIN_WORDS}).` },
  ];
}
