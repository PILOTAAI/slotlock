// A blog post as a file (RFC 0006, 4.5): site/content/blog/<slug>.md, a few lines of frontmatter and
// a Markdown body. The site renders it here at build time, and the admin console's editor renders it
// here too for its preview and its checks, so the preview is the page and the checks are the site's.
//
// The Markdown is a strict subset, rendered without any library and without raw HTML: every
// character of the source is escaped, so a post can never carry a script, a style or an iframe of its
// own. What it takes:
//   ## and ### headings; paragraphs; - and 1. lists; > quotes; --- dividers; GitHub tables (which
//   scroll sideways on a narrow screen);
//   ``` code fences, optionally ```sql caption="What it shows";
//   on a line of its own, ![alt text](target "An optional caption"), where the target is
//     a file of the post, /blog/<slug>/<name>.png, .jpg, .jpeg, .webp, .avif or .gif: an image;
//     a file of the post, /blog/<slug>/<name>.mp4 or .webm: a video with its controls;
//     a YouTube or Vimeo address: the video's player, from youtube-nocookie.com or with Vimeo's
//     do-not-track, the only frames the site's CSP lets in (public/_headers);
//   `code`, **strong**, *emphasis*, [links](/site/path), [links](https://…) inline, and links to the
//   post's own files, [The slides (PDF)](/blog/<slug>/<name>.pdf), which download;
//   {{facts.name}}: a number or text generated from Slotlock's code (site/src/generated/facts.json).
// Alt text (a player's title) is required. A post's files are known by their first bytes, never by
// their names, and each kind has a size it may not pass (POST_FILE_KINDS): the console checks them
// before it commits anything, and the site's build checks them again (posts.ts).
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
/** Where a post's own files live, in the repository (site/public/blog/<slug>/) and on the site. */
export const postImagePath = (slug: string) => `/blog/${slug}/`;

/** What a post's file is, by its name's extension: what it shows as, its media type, and its largest size in bytes. */
export interface PostFileKind {
  kind: 'image' | 'video' | 'file';
  /** The canonical extension its first bytes name (jpeg is jpg). */
  type: PostFileType;
  mime: string;
  max: number;
}
export type PostFileType = 'png' | 'jpg' | 'webp' | 'avif' | 'gif' | 'mp4' | 'webm' | 'pdf';

const MB = 1_000_000;
// The caps sit under what carries a file from the console to a reader, as their docs said on
// 2026-11-14:
//   - Cloudflare Workers static assets serve a file of at most 25 MiB, on every plan
//     (https://developers.cloudflare.com/workers/platform/limits/#static-assets).
//   - GitHub's contents API reads a file of up to 1 MB as JSON, and one of 1 to 100 MB only as raw
//     bytes (https://docs.github.com/en/rest/repos/contents); a blob is read up to 100 MB
//     (https://docs.github.com/en/rest/git/blobs); GitHub blocks files over 100 MiB, warns past 50 MiB
//     and would keep a repository under 1 GB
//     (https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
//   - The console is a Worker: 128 MB of memory an isolate, and a request body of up to 100 MB on the
//     Free and Pro plans (https://developers.cloudflare.com/workers/platform/limits/). An upload holds
//     the file about three times over while it is committed, so a 20 MB video stays well inside it.
// So: a picture 5 MB, a GIF or a PDF 10 MB, a video 20 MB (the 25 MiB asset limit with room), and a
// post's files 20 in number and 50 MB together.
export const POST_FILE_KINDS: Readonly<Record<string, PostFileKind>> = Object.freeze({
  png: { kind: 'image', type: 'png', mime: 'image/png', max: 5 * MB },
  jpg: { kind: 'image', type: 'jpg', mime: 'image/jpeg', max: 5 * MB },
  jpeg: { kind: 'image', type: 'jpg', mime: 'image/jpeg', max: 5 * MB },
  webp: { kind: 'image', type: 'webp', mime: 'image/webp', max: 5 * MB },
  avif: { kind: 'image', type: 'avif', mime: 'image/avif', max: 5 * MB },
  gif: { kind: 'image', type: 'gif', mime: 'image/gif', max: 10 * MB },
  mp4: { kind: 'video', type: 'mp4', mime: 'video/mp4', max: 20 * MB },
  webm: { kind: 'video', type: 'webm', mime: 'video/webm', max: 20 * MB },
  pdf: { kind: 'file', type: 'pdf', mime: 'application/pdf', max: 10 * MB },
});
/** The most files a post may have, and the most bytes they may hold together. */
export const POST_FILES_MAX = 20;
export const POST_FILES_TOTAL = 50 * MB;
/** A post's file name: lowercase words and hyphens, then one of POST_FILE_KINDS' extensions. */
export const POST_FILE = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp|avif|gif|mp4|webm|pdf)$/;
/** The kind of a post's file, by its name, or null for a name a post's file cannot have. */
export const postFileKind = (name: string): PostFileKind | null =>
  POST_FILE.test(name) ? (POST_FILE_KINDS[name.slice(name.lastIndexOf('.') + 1)] ?? null) : null;

const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));
/** ISO base media brands an MP4 may carry (QuickTime's "qt  " and HEIF's still pictures are not among them). */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'M4V ', 'MSNV']);

/**
 * A file's type from its first bytes, never from its name or a browser's word: PNG, JPEG, WebP,
 * AVIF, GIF, MP4, WebM or PDF. Anything else (an SVG, HTML, a QuickTime .mov, a Matroska .mkv, HEIC)
 * is null.
 */
export function postFileType(bytes: Uint8Array): PostFileType | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  if (ascii(bytes, 4, 4) === 'ftyp' && bytes.length >= 16) {
    // An ISO base media file: its ftyp box names a major brand and the brands it is compatible with.
    const size = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
    if (size < 16 || size > 4096 || size > bytes.length) return null;
    const major = ascii(bytes, 8, 4);
    const brands = [major];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(bytes, at, 4));
    if (major === 'avif' || major === 'avis' || ((major === 'mif1' || major === 'msf1') && brands.some((brand) => brand === 'avif' || brand === 'avis'))) return 'avif';
    if (major === 'qt  ' || brands.some((brand) => brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1')) return null;
    return brands.some((brand) => MP4_BRANDS.has(brand)) ? 'mp4' : null;
  }
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) {
    // EBML: WebM only when its DocType element (0x4282) says so; Matroska says "matroska".
    for (let at = 4; at < Math.min(bytes.length - 2, 64); at += 1) {
      if (bytes[at] !== 0x42 || bytes[at + 1] !== 0x82) continue;
      const length = (bytes[at + 2] ?? 0) & 0x7f;
      return ((bytes[at + 2] ?? 0) & 0x80) && ascii(bytes, at + 3, length) === 'webm' ? 'webm' : null;
    }
  }
  return null;
}

const KIND_WORDS = 'a PNG, JPEG, WebP, AVIF or GIF picture, an MP4 or WebM video, or a PDF';
/** A size as people read it: "12 KB" under a megabyte, "1.5 MB" from one. */
export const postFileSize = (bytes: number) => (bytes < MB ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${Number((bytes / MB).toFixed(1))} MB`);

/**
 * What is wrong with a file a post would carry, or null when nothing is: its name is a post file's,
 * its first bytes are what its extension says, and it is no larger than its kind may be.
 */
export function postFileProblem(name: string, bytes: Uint8Array): string | null {
  const kind = postFileKind(name);
  if (!kind) return `${name}: a post's file is named in lowercase words and hyphens, and is ${KIND_WORDS}`;
  const found = postFileType(bytes);
  if (!found) return `${name}: its bytes are not ${KIND_WORDS} (an SVG, a QuickTime .mov or anything else is refused)`;
  if (found !== kind.type) return `${name}: its bytes are a ${found.toUpperCase()} file, not ${kind.type.toUpperCase()}: name it .${found}`;
  if (bytes.length === 0 || bytes.length > kind.max) {
    // Just over reads as its bytes, not as "5 MB, over the 5 MB".
    const size = postFileSize(bytes.length) === postFileSize(kind.max) ? `${bytes.length.toLocaleString('en-GB')} bytes` : postFileSize(bytes.length);
    return `${name}: ${size}, over the ${postFileSize(kind.max)} a ${kind.type === 'gif' ? 'GIF' : kind.kind === 'image' ? 'picture' : kind.kind === 'video' ? 'video' : 'PDF'} may be`;
  }
  return null;
}

/**
 * What is wrong with a post's folder of files, as the site's build reads it: each file as
 * postFileProblem says, no more than POST_FILES_MAX of them and POST_FILES_TOTAL bytes together, and,
 * given the rendered body, every file it shows or links to among them.
 */
export function postFilesProblems(slug: string, files: readonly { name: string; bytes: Uint8Array }[], rendered?: RenderedBody): string[] {
  const problems = files.flatMap((file) => postFileProblem(file.name, file.bytes) ?? []);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (files.length > POST_FILES_MAX) problems.push(`${files.length} files, over the ${POST_FILES_MAX} a post may have`);
  if (total > POST_FILES_TOTAL) problems.push(`${postFileSize(total)} of files, over the ${postFileSize(POST_FILES_TOTAL)} a post may have`);
  if (rendered) {
    const there = new Set(files.map((file) => file.name));
    const named = [...rendered.images.map((image) => image.src.slice(postImagePath(slug).length)), ...rendered.files];
    for (const name of new Set(named)) if (!there.has(name)) problems.push(`${name} is not in public/blog/${slug}/`);
  }
  return problems;
}

/** A YouTube or Vimeo video a post embeds: its player's address, which only the two hosts below serve. */
export interface PostEmbed {
  provider: 'youtube' | 'vimeo';
  id: string;
  src: string;
}
/** The frames the site's CSP allows (public/_headers frame-src): exactly these two. */
export const POST_EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'] as const;
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^[1-9][0-9]{5,11}$/;

/** The start of a YouTube link (t=90, t=1m30s, start=90) in seconds, or null. */
function startSeconds(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d{1,5}s?$/.test(value)) return Number.parseInt(value, 10);
  const parts = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/.exec(value);
  if (!parts || value === '') return null;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
}

/**
 * The player for a YouTube or Vimeo address, or null for anything else: https only, no user, port
 * or other host, and an id of exactly the shape each site gives (YouTube's 11 characters, Vimeo's
 * digits). The address written in the post never reaches the page: the player's is built from the id.
 */
export function postEmbed(address: string): PostEmbed | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const segments = url.pathname.split('/').slice(1);
  let id: string | null = null;
  if (url.hostname === 'youtu.be' && segments.length === 1) id = segments[0] ?? null;
  else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (segments.length === 2 && ['embed', 'shorts', 'live'].includes(segments[0] ?? '')) id = segments[1] ?? null;
  } else if (url.hostname === 'vimeo.com' || url.hostname === 'www.vimeo.com') {
    if (segments.length === 1 && VIMEO_ID.test(segments[0] ?? '')) return { provider: 'vimeo', id: segments[0] as string, src: `https://player.vimeo.com/video/${segments[0]}?dnt=1` };
    return null;
  } else if (url.hostname === 'player.vimeo.com') {
    if (segments.length === 2 && segments[0] === 'video' && VIMEO_ID.test(segments[1] ?? '')) return { provider: 'vimeo', id: segments[1] as string, src: `https://player.vimeo.com/video/${segments[1]}?dnt=1` };
    return null;
  } else {
    return null;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const start = startSeconds(url.searchParams.get('t') ?? url.searchParams.get('start'));
  return { provider: 'youtube', id, src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}` };
}
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
  /** Each picture and video of the post's own files, with its alt text. */
  images: { src: string; alt: string; kind: 'image' | 'video' }[];
  /** Each YouTube or Vimeo player, with its title. */
  embeds: (PostEmbed & { title: string })[];
  /** The names of the post's own files its text links to (a PDF to download). */
  files: string[];
  links: string[];
  /** The prose a reader reads (no code), for the copy rules and the word count. */
  prose: string;
  /** Problems the source has that the renderer worked around, each with its line. */
  problems: string[];
}

interface Found {
  slug: string;
  links: string[];
  files: string[];
  problems: string[];
  prose: string[];
}

/** One line of text: `code`, [links](…), **strong** and *emphasis*, everything else escaped. */
function inline(text: string, found: Found, line: number): string {
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
        const own = postImagePath(found.slug);
        const file = href.startsWith(own) && !/^[#?]/.test(href.slice(own.length)) && href.length > own.length ? href.slice(own.length) : null;
        if (file !== null) {
          // A file of this post: one it carries, which a PDF's link downloads.
          const kind = postFileKind(file);
          if (kind) {
            found.files.push(file);
            const download = kind.kind === 'file' ? ` type="${kind.mime}" download` : '';
            out += `<a href="${escapeHtml(href)}"${download}>${emphasis(label, { prose: [] })}</a>`;
          } else {
            found.problems.push(`line ${line}: "${href}" is not a file a post carries: ${own}<name>.pdf, or a picture or video`);
            out += escapeHtml(label);
          }
        } else if (LINK.test(href)) {
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

/** A media line: ![alt](target) or ![alt](target "caption"), alone on its line. */
const MEDIA_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})$/;
/** A player's frame: no more than it needs to play (its scripts and storage, full screen, opening the video on its own site). */
const EMBED_ATTRIBUTES = 'width="560" height="315" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen';

/**
 * The body as HTML, in the shapes the site's article styles (pages.css) expect: h2, h3, p, ul, ol,
 * blockquote, hr, figure with figcaption and pre > code, figure with img, video or a player's iframe
 * (and its figcaption), and a scrolling region around a table with thead and tbody.
 */
export function renderPostBody(body: string, options: { slug: string; facts?: Readonly<Record<string, unknown>> }): RenderedBody {
  const facts = options.facts ? resolveFacts(body, options.facts) : { text: body, unknown: [] as string[] };
  const lines = facts.text.replace(/\r\n?/g, '\n').split('\n');
  const found: Found = { slug: options.slug, links: [], files: [], problems: [], prose: [] };
  for (const name of facts.unknown) found.problems.push(`{{facts.${name}}} is not a fact the site knows`);
  const images: RenderedBody['images'] = [];
  const embeds: RenderedBody['embeds'] = [];
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
    const media = MEDIA_LINE.exec(line) ?? (/^https:\/\/\S+$/.test(line.trim()) && postEmbed(line.trim()) ? ([line, '', line.trim()] as unknown as RegExpExecArray) : null);
    if (media) {
      flush();
      const alt = (media[1] as string).trim();
      const target = media[2] as string;
      const caption = media[3] === undefined || media[3].trim() === '' ? '' : `<figcaption>${inline(media[3].trim(), found, number)}</figcaption>`;
      const own = postImagePath(options.slug);
      const kind = target.startsWith(own) ? postFileKind(target.slice(own.length)) : null;
      const embed = kind ? null : postEmbed(target);
      if (embed) {
        if (!alt) found.problems.push(`line ${number}: a video from ${embed.provider === 'youtube' ? 'YouTube' : 'Vimeo'} needs a title: ![What it shows](${target})`);
        embeds.push({ ...embed, title: alt });
        out.push(`<figure class="embed"><iframe src="${escapeHtml(embed.src)}" title="${escapeHtml(alt || (embed.provider === 'youtube' ? 'A video on YouTube' : 'A video on Vimeo'))}" ${EMBED_ATTRIBUTES}></iframe>${caption}</figure>`);
        continue;
      }
      if (!kind || kind.kind === 'file') {
        found.problems.push(
          kind
            ? `line ${number}: a PDF is a link to download, [What it is (PDF)](${target}), not a picture`
            : /^https?:\/\//.test(target)
              ? `line ${number}: "${target}" is not a YouTube or Vimeo video: a picture or video is a file of this post, ${own}<name>.png`
              : `line ${number}: a picture or video is a file of this post, ${own}<name>.png, .jpg, .webp, .avif, .gif, .mp4 or .webm, or a YouTube or Vimeo address`,
        );
        continue;
      }
      if (!alt) found.problems.push(`line ${number}: ${kind.kind === 'video' ? 'a video' : 'an image'} needs alt text: ![what it shows](${target})`);
      images.push({ src: target, alt, kind: kind.kind });
      out.push(
        kind.kind === 'video'
          ? `<figure><video src="${escapeHtml(target)}" controls preload="metadata" playsinline aria-label="${escapeHtml(alt)}"></video>${caption}</figure>`
          : `<figure><img src="${escapeHtml(target)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">${caption}</figure>`,
      );
      continue;
    }
    if (DIVIDER.test(line.trim())) {
      flush();
      out.push('<hr>');
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
      // A region of its own that scrolls sideways when the table is wider than the screen, which a
      // keyboard can reach and a screen reader names by the table's columns.
      const label = `Table: ${columns.map((column) => column.replace(/[`*]/g, '')).join(', ')}`.slice(0, 120);
      out.push(
        `<div class="table-scroll" role="region" aria-label="${escapeHtml(label)}" tabindex="0"><table><thead><tr>${columns.map((column) => `<th scope="col">${inline(column, found, number)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${columns.map((_, cell) => `<td>${inline(row[cell] ?? '', found, number)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
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
  return { html: out.join('\n'), images, embeds, files: [...new Set(found.files)], links: found.links, prose: found.prose.join(' '), problems: found.problems };
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
    /** The file names in the post's folder; leave out to skip checking each file is there. */
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
  const named = [...new Set([...rendered.images.map((image) => image.src.slice(postImagePath(post.slug).length)), ...rendered.files])];
  const absent = context.imageFiles ? named.filter((file) => !(context.imageFiles as ReadonlySet<string>).has(file)) : [];
  const described = [...rendered.images.map((image) => image.alt), ...rendered.embeds.map((embed) => embed.title)];
  const altless = described.filter((alt) => alt.length === 0 || alt.length > 200).length;
  const shown = [
    [rendered.images.filter((image) => image.kind === 'image').length, 'picture'],
    [rendered.images.filter((image) => image.kind === 'video').length, 'video'],
    [rendered.embeds.length, 'player'],
    [rendered.files.length, 'file'],
  ].filter(([n]) => Number(n) > 0).map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`);
  return [
    { name: 'Markdown', ok: rendered.problems.length === 0, detail: rendered.problems.join('; ') || 'Every line renders as written.' },
    { name: 'Copy rules', ok: copy.length === 0, detail: copy.join('; ') || 'No em dashes, filler words or empty phrases.' },
    { name: 'Search title', ok: title.length >= 20 && title.length <= 65, detail: `${title.length} characters (20 to 65)${front.seoTitle ? ', the search title' : ''}.` },
    { name: 'Description', ok: front.description.length >= 70 && front.description.length <= 160, detail: `${front.description.length} characters (70 to 160).` },
    { name: 'Unique description', ok: !same, detail: same ? `The same as the post ${same[0]}.` : 'No other post has it.' },
    {
      name: 'Media',
      ok: altless === 0 && absent.length === 0,
      detail: absent.length
        ? `Not uploaded: ${absent.join(', ')}.`
        : altless
          ? `${altless} without alt text, or a player without a title, of 1 to 200 characters.`
          : shown.length ? `${shown.join(', ')}, each described in 1 to 200 characters.` : 'No pictures, videos or files.',
    },
    { name: 'Links', ok: missing.length === 0, detail: context.sitePaths ? (missing.length ? `No page at ${missing.join(', ')}.` : `${rendered.links.length} links, each to a page that exists.`) : 'Not checked: the site\'s pages could not be read.' },
    { name: 'Related pages', ok: related.length >= 1 && related.length <= 4 && related.every((link) => LINK.test(link.href) && link.label.length > 0), detail: `${related.length} (1 to 4, each "Label | /path").` },
    { name: 'Author', ok: Object.hasOwn(context.authors, front.author), detail: Object.hasOwn(context.authors, front.author) ? (context.authors[front.author] as PostAuthor).name : `"${front.author}" is not in site/src/data/authors.json.` },
    { name: 'Tags', ok: front.tags.length >= 1 && front.tags.length <= 5, detail: `${front.tags.length} (1 to 5).` },
    { name: 'Length', ok: words >= POST_MIN_WORDS, detail: `${words} words (at least ${POST_MIN_WORDS}).` },
  ];
}
