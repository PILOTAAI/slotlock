// The admin console's CMS (RFC 0006, M8 and 4.5): blog posts stay files in the repository, and the
// console writes them through the "Slotlock CMS" GitHub App (github-app.ts).
//
//   Write (Owner, Editor): the editor saves a post to cms/<slug>, authored and signed off as the
//     staff member, and opens a pull request the site's checks run on. Saving keeps it a draft;
//     submitting, which needs every check below to pass, marks it ready (status: published in the
//     file, so merging it publishes it). Its pictures, GIFs, videos and PDFs go beside it in
//     site/public/blog/<slug>/, each checked by its first bytes and its size before it is committed
//     (post-format.ts, POST_FILE_KINDS): uploaded from the editor's toolbar, dropped on it or pasted
//     into it (a screenshot), and listed in its Media panel to insert or delete.
//   Publish (Owner only, E5): merges the pull request at the commit the Owner saw, once its checks
//     on GitHub pass and it changes nothing but blog files. A post with a later publish date is
//     scheduled instead: a label, and a comment from the App naming the commit, which the hourly
//     CMS workflow (scripts/cms-scheduled-merge.mjs) merges when the date comes.
//
// The preview and the checks are the site's own (site/src/lib/post-format.ts), so the preview is
// the page. Every step is recorded in the staff log before GitHub is asked, and the database checks
// the role again as it records it.
import {
  POST_EMBED_ORIGINS,
  POST_FILE,
  POST_FILES_MAX,
  POST_FILES_TOTAL,
  POST_FILE_KINDS,
  POST_SLUG,
  type ParsedPost,
  type PostAuthor,
  type PostCheck,
  type PostFront,
  PostFormatError,
  checkPost,
  parsePost,
  postFileKind,
  postFileProblem,
  postFileSize,
  postFileType,
  postImagePath,
  renderPostBody,
  serializePost,
} from '../../site/src/lib/post-format.js';
import type { SlotlockContentStep, SlotlockStaffRole } from '../staff-ddl.js';
import { slotlockStaffMay } from '../staff-ddl.js';
import {
  type SlotlockCmsChange,
  type SlotlockCmsChecks,
  type SlotlockCmsEntry,
  type SlotlockCmsFile,
  type SlotlockCmsGitHub,
  type SlotlockCmsPullRequest,
  SlotlockCmsError,
  slotlockSignOff,
} from './github-app.js';
import { type Crumb, Html, day, emptyState, facts, field, html, info, pill, popover, table, tabs } from './ui.js';
import { SLOTLOCK_ADMIN_SETUP_DOCS as SLOTLOCK_CMS_SETUP_DOCS } from './system.js';

export type { SlotlockCmsChange } from './github-app.js';

export const SLOTLOCK_CMS_POSTS = 'site/content/blog';
export const SLOTLOCK_CMS_IMAGES = 'site/public/blog';
export const SLOTLOCK_CMS_AUTHORS = 'site/src/data/authors.json';
export const SLOTLOCK_CMS_REDIRECTS = 'site/public/_redirects';
/** The label on a scheduled post's pull request; the comment beside it names the commit. */
export const SLOTLOCK_CMS_SCHEDULED_LABEL = 'cms:scheduled';
/**
 * The largest upload the console reads: the largest file a post may carry (a video, POST_FILE_KINDS)
 * and the form's other fields. Larger is refused before its body is read.
 */
export const SLOTLOCK_CMS_UPLOAD_MAX = Math.max(...Object.values(POST_FILE_KINDS).map((kind) => kind.max)) + 64 * 1024;
/** Slugs the console's own routes use. */
const RESERVED_SLUGS = new Set(['new', 'preview']);
const IMAGE_FILE = POST_FILE;
const SHA = /^[0-9a-f]{40}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SITE_CACHE_MS = 60 * 60 * 1000;
const CONTEXT_CACHE_MS = 2 * 60 * 1000;

/**
 * The files a CMS pull request may change at all: posts, their images and the redirects a rename
 * writes. The author list is not among them: the console never writes it, so a change to it goes
 * through an ordinary pull request.
 */
export function slotlockCmsPathAllowed(path: string): boolean {
  return (
    /^site\/content\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.md$/.test(path) ||
    /^site\/public\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp|avif|gif|mp4|webm|pdf)$/.test(path) ||
    path === SLOTLOCK_CMS_REDIRECTS
  );
}

const CHANGE_POST = /^site\/content\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\.md$/;
const CHANGE_IMAGE = /^site\/public\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp|avif|gif|mp4|webm|pdf)$/;
/** A redirect line: a site path, a post's address, and a redirect status. */
const REDIRECT_LINE = /^(\/[^\s]{0,300}) (\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}(?:\/|\.md)) (30[1278])$/;

/**
 * Whether the console (or the hourly workflow) may merge what a cms/<slug> commit changes: its own
 * post and that post's images, and nothing of another post but, for a rename, the old post's files
 * going away with redirects from the old address to this one. Every redirect line it adds leads to
 * this post, from the old address or from an address that led to the old one. scripts/
 * cms-scheduled-merge.mjs applies the same rule (cmsChangeAllowed).
 */
export function slotlockCmsChangeAllowed(slug: string, files: readonly SlotlockCmsChange[]): boolean {
  if (files.length === 0) return false;
  let from: string | null = null;
  let redirects: SlotlockCmsChange | null = null;
  for (const file of files) {
    for (const path of [file.path, ...(file.previous ? [file.previous] : [])]) {
      if (path === SLOTLOCK_CMS_REDIRECTS) {
        if (file.status !== 'modified' && file.status !== 'added') return false;
        redirects = file;
        continue;
      }
      const owner = CHANGE_POST.exec(path)?.[1] ?? CHANGE_IMAGE.exec(path)?.[1];
      if (!owner) return false;
      if (owner === slug) continue;
      // Another post's file: only one going away in a rename, and only one other post.
      const leaving = (file.status === 'removed' && path === file.path) || (file.status === 'renamed' && path === file.previous);
      if (!leaving || (from !== null && from !== owner)) return false;
      from = owner;
    }
  }
  // Redirects only with a rename, and a rename always with its redirects.
  if ((redirects === null) !== (from === null)) return false;
  if (redirects === null || from === null) return true;
  if (redirects.patch === null) return false;
  const old = new Set([`/blog/${from}/`, `/blog/${from}.md`]);
  const own = new Set([`/blog/${slug}/`, `/blog/${slug}.md`]);
  const sources = new Set(old);
  const added: [string, string][] = [];
  for (const line of redirects.patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---') || line.startsWith(' ') || line.startsWith('\\') || line === '') continue;
    const text = line.slice(1).trim();
    if (line.startsWith('-')) {
      // A line that led to the old post is rewritten to lead to this one, and one from this post's
      // own address (a post renamed back, or into an address that redirected) goes; nothing else.
      const found = REDIRECT_LINE.exec(text);
      if (!found || !(old.has(found[2] as string) || own.has(found[1] as string))) return false;
      if (old.has(found[2] as string)) sources.add(found[1] as string);
      continue;
    }
    if (!line.startsWith('+')) return false;
    const found = REDIRECT_LINE.exec(text);
    if (!found) return false;
    added.push([found[1] as string, found[2] as string]);
  }
  return added.length > 0 && added.every(([source, target]) =>
    sources.has(source) && !own.has(source) && target === `/blog/${slug}${target.endsWith('.md') ? '.md' : '/'}`);
}

/** The comment the App leaves when an Owner schedules a post: the commit it may merge, and when. */
export function slotlockScheduleComment(input: { sha: string; at: string; by: string }): string {
  return [
    `<!-- slotlock-cms:schedule sha=${input.sha} at=${input.at} by=${input.by} -->`,
    `Scheduled from the admin console by ${input.by} for ${input.at.replace('T', ' ').replace('Z', ' UTC')}.`,
    'The hourly CMS workflow merges this pull request then, if the post is still as it is in this commit and its checks pass. A change to the post cancels the schedule; bringing in main does not.',
  ].join('\n');
}

/**
 * The commit, time and Owner the App's latest schedule comment names, or null when there is none or
 * an unschedule came after it. scripts/cms-scheduled-merge.mjs reads the same comment.
 */
export function slotlockScheduleOf(comments: readonly string[]): { sha: string; at: string; by: string } | null {
  for (const body of [...comments].reverse()) {
    const found = /^<!-- slotlock-cms:(?:schedule sha=([0-9a-f]{40}) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z) by=([A-Za-z0-9-]{1,39})|unschedule) -->/.exec(body);
    if (!found) continue;
    return found[1] && found[2] && found[3] ? { sha: found[1], at: found[2], by: found[3] } : null;
  }
  return null;
}

/** A post file's type from its first bytes, never from its name or the browser's word (post-format.ts). */
export const slotlockFileType = postFileType;

/**
 * Add a slug change to _redirects: the page and its Markdown twin, and any redirect that led to the
 * old page now leads to the new one. A line that would lead an address to itself, or away from the
 * new page's own addresses (a post renamed back), is dropped, so no redirect loops.
 */
export function slotlockRedirectsWith(text: string, from: string, to: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '').split('\n').filter((line, index, all) => !(all.length === 1 && line === ''));
  const own = new Set([`/blog/${to}/`, `/blog/${to}.md`]);
  const moved = lines.flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (line.trim().startsWith('#') || parts.length < 2) return [line];
    if (parts[1] === `/blog/${from}/`) parts[1] = `/blog/${to}/`;
    if (parts[1] === `/blog/${from}.md`) parts[1] = `/blog/${to}.md`;
    if (parts[0] === parts[1] || own.has(parts[0] as string)) return [];
    return [parts.join(' ')];
  });
  moved.push(`/blog/${from}/ /blog/${to}/ 301`, `/blog/${from}.md /blog/${to}.md 301`);
  return `${moved.join('\n')}\n`;
}

interface Notice {
  kind: 'done' | 'warn';
  text: string;
}

/** A 16px stroke glyph, drawn as the console's icons are (ui.ts). */
const glyph = (path: string) => new Html(`<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`);
const GLYPHS = {
  link: 'M6.8 9.2a2.5 2.5 0 0 0 3.6 0l2.3-2.3a2.5 2.5 0 0 0-3.6-3.6l-.8.8M9.2 6.8a2.5 2.5 0 0 0-3.6 0L3.3 9.1a2.5 2.5 0 0 0 3.6 3.6l.8-.8',
  ul: 'M6 4h7.6M6 8h7.6M6 12h7.6M2.6 4h.8M2.6 8h.8M2.6 12h.8',
  ol: 'M6.4 4h7.2M6.4 8h7.2M6.4 12h7.2M2.4 3l1-.6v3.2M2.3 9.4c.2-.7 1.7-.8 1.7.1 0 .7-1.7 1.8-1.7 1.8h1.8',
  quote: 'M3 4v8M6 5h7.2M6 8h7.2M6 11h4.8',
  code: 'M5.4 4.6 2.2 8l3.2 3.4M10.6 4.6 13.8 8l-3.2 3.4M9 3.2 7 12.8',
  table: 'M2.4 3.2h11.2v9.6H2.4zM2.4 6.4h11.2M2.4 9.6h11.2M6.4 3.2v9.6',
  divider: 'M2.4 8h11.2M5.6 4.8h4.8M5.6 11.2h4.8',
  upload: 'M2.4 3.2h11.2v9.6H2.4zM2.4 10.6l3-3 2.6 2.6 1.8-1.8 3.8 3.8M10.4 5.8h.01',
  embed: 'M2.4 3.6h11.2v8.8H2.4zM6.8 6v4l3.4-2z',
  video: 'M2.4 3.6h11.2v8.8H2.4zM6.8 6v4l3.4-2z',
  file: 'M4 1.9h5.6l3 3v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.5a.6.6 0 0 1 .6-.6zM9.2 2v3.3h3.3',
  trash: 'M2.8 4.4h10.4M6.2 4.4V2.8h3.6v1.6M4.2 4.4l.6 9h6.4l.6-9',
} as const;

/** The editor's toolbar (editor.js does what each names): its label, its shortcut after Ctrl or ⌘, and its glyph. */
const TOOLS: readonly { action: string; label: string; keys?: string; text?: string; glyph?: keyof typeof GLYPHS; group?: boolean }[] = [
  { action: 'h2', label: 'H2 heading', keys: 'Alt+2', text: 'H2' },
  { action: 'h3', label: 'H3 subheading', keys: 'Alt+3', text: 'H3' },
  { action: 'bold', label: 'Bold', keys: 'B', text: 'B', group: true },
  { action: 'italic', label: 'Italic', keys: 'I', text: 'I' },
  { action: 'link', label: 'Link', keys: 'K', glyph: 'link' },
  { action: 'ul', label: 'Bulleted list', keys: 'Shift+8', glyph: 'ul', group: true },
  { action: 'ol', label: 'Numbered list', keys: 'Shift+7', glyph: 'ol' },
  { action: 'quote', label: 'Quote', keys: 'Shift+.', glyph: 'quote' },
  { action: 'code', label: 'Code block', keys: 'E', glyph: 'code' },
  { action: 'table', label: 'Table', keys: 'Alt+T', glyph: 'table', group: true },
  { action: 'divider', label: 'Divider', keys: 'Alt+-', glyph: 'divider' },
  { action: 'upload', label: 'Upload a picture, GIF, video or PDF', keys: 'Alt+U', glyph: 'upload', group: true },
  { action: 'embed', label: 'Embed a YouTube or Vimeo video', keys: 'Alt+V', glyph: 'embed' },
];
const ARIA_KEYS: Readonly<Record<string, string>> = { '.': 'Period', '-': 'Minus' };
const ariaKeys = (keys: string) => {
  const parts = keys.split('+').map((part) => ARIA_KEYS[part] ?? part);
  return `Control+${parts.join('+')} Meta+${parts.join('+')}`;
};

/**
 * The editor's page adds to the console's CSP what its preview needs to show a post as the site does:
 * the post's videos (from the console, media-src 'self') and the YouTube and Vimeo players (frame-src
 * for exactly their two hosts, as the site's own CSP). No other page of the console gets either.
 */
export const SLOTLOCK_CMS_EDITOR_CSP = `media-src 'self'; frame-src ${POST_EMBED_ORIGINS.join(' ')}`;
function withMedia(response: Response): Response {
  const policy = response.headers.get('Content-Security-Policy');
  if (policy && !/(?:^|;)\s*(?:media|frame)-src/.test(policy)) response.headers.set('Content-Security-Policy', `${policy}; ${SLOTLOCK_CMS_EDITOR_CSP}`);
  return response;
}

/** The types the upload control offers; the console still reads each file's bytes. */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,application/pdf';

const NOTICES: Readonly<Record<string, Notice>> = Object.freeze({
  saved: { kind: 'done', text: 'Saved as a draft on its pull request. The site’s checks are running on it.' },
  submitted: { kind: 'done', text: 'Submitted. An Owner can publish it once the checks on GitHub pass.' },
  image_added: { kind: 'done', text: 'File added. Insert it into the post from Media.' },
  image_removed: { kind: 'done', text: 'File deleted from the post.' },
  renamed: { kind: 'done', text: 'Renamed on a new pull request, with redirects from the old address. Publish it to make the change live.' },
  discarded: { kind: 'done', text: 'Draft discarded: its pull request is closed and its branch deleted.' },
  published: { kind: 'done', text: 'Published. The site deploys in a few minutes.' },
  scheduled: { kind: 'done', text: 'Scheduled. The hourly workflow publishes it when its date comes.' },
  unscheduled: { kind: 'done', text: 'Unscheduled. It waits for an Owner to publish it.' },
  invalid: { kind: 'warn', text: 'Check the form: a field was missing or not valid.' },
  image_invalid: { kind: 'warn', text: 'That upload was not a file the console takes. Choose a picture, a GIF, a video or a PDF.' },
  file_type: { kind: 'warn', text: 'Only PNG, JPEG, WebP, AVIF and GIF pictures, MP4 and WebM videos, and PDFs: an SVG, a QuickTime .mov or anything else is refused.' },
  file_large: { kind: 'warn', text: 'Too large: a picture is up to 5 MB, a GIF or a PDF 10 MB, a video 20 MB.' },
  file_full: { kind: 'warn', text: 'A post holds at most 20 files and 50 MB. Delete one from Media first.' },
  save_first: { kind: 'warn', text: 'Save the post first, then add its pictures and videos.' },
  slug_taken: { kind: 'warn', text: 'There is a post or a draft at that address already. Choose another.' },
  rename_draft: { kind: 'warn', text: 'Only a published post with no open draft is renamed here. Discard or publish the draft first.' },
  changed: { kind: 'warn', text: 'The pull request changed since you opened the page. Look at it again, then publish.' },
  not_content: { kind: 'warn', text: 'That pull request changes more than this post: files outside the blog, another post, or redirects a rename did not write. The console does not merge it; review and merge it on GitHub.' },
  not_submitted: { kind: 'warn', text: 'It is still a draft. Submit it for review first.' },
  checks_pending: { kind: 'warn', text: 'Its checks on GitHub have not all finished. Publish when they pass.' },
  checks_failing: { kind: 'warn', text: 'A check failed, on GitHub or in the console. Fix the post, then publish.' },
  merge_refused: { kind: 'warn', text: 'GitHub would not merge it: a branch rule or a conflict stops it. Open the pull request to see why.' },
  updating: { kind: 'warn', text: 'It was behind main, so the console brought it up to date. Its checks run again; publish when they pass.' },
  conflict: { kind: 'warn', text: 'It conflicts with main. Open the pull request on GitHub to resolve it, then publish.' },
  github: { kind: 'warn', text: 'GitHub did not take that change, and nothing was published. Try again in a minute.' },
});

/** What a CMS page puts in the console's top bar. */
export interface SlotlockCmsHead {
  crumbs?: Crumb[];
  pills?: Html;
  actions?: Html;
}

/** What the console gives the CMS for one request. */
export interface SlotlockCmsRequest {
  /** staff_ref: github:<id> */
  staff: string;
  login: string;
  role: SlotlockStaffRole;
  /** A passkey sign-in in the last 15 minutes. */
  fresh: boolean;
  csrfOk(token: string): boolean;
  csrf: string;
  page(title: string, path: string, body: Html, notice?: Notice, status?: number, head?: SlotlockCmsHead): Response;
  redirect(location: string): Response;
  json(value: unknown, status?: number): Response;
  /** Record a step in the staff log; the database checks the role and throws 42501 if it is not allowed. */
  record(step: SlotlockContentStep, slug: string, extra?: Record<string, string | number>): Promise<void>;
}

export interface SlotlockAdminCmsOptions {
  /** Null when the CMS App is not configured: the pages say what to set. */
  github: SlotlockCmsGitHub | null;
  /** The live site, https://slotlock.pylota.io: its sitemap for the link check, its facts. */
  siteUrl: string;
  /** The preview Worker's workers.dev host; each CMS pull request is at https://pr-<n>-<host>/. */
  previewHost?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The editor's fields, as the form and the live preview send them. */
interface Fields {
  slug: string;
  title: string;
  seoTitle: string;
  description: string;
  date: string;
  updated: string;
  publishAt: string;
  author: string;
  tags: string;
  eyebrow: string;
  imageAlt: string;
  related: string;
  body: string;
}
const FIELD_NAMES = ['slug', 'title', 'seoTitle', 'description', 'date', 'updated', 'publishAt', 'author', 'tags', 'eyebrow', 'imageAlt', 'related', 'body'] as const;
const FIELD_LIMITS: Readonly<Record<keyof Fields, number>> = {
  slug: 120, title: 200, seoTitle: 200, description: 400, date: 10, updated: 10, publishAt: 20, author: 60,
  tags: 300, eyebrow: 60, imageAlt: 300, related: 2000, body: 100_000,
};

/** What a post's page needs besides the post: who writes, what else is published, its files. */
interface PostContext {
  authors: Record<string, PostAuthor>;
  descriptions: Record<string, string>;
  /** The post's pictures, videos and PDFs, by name, with their sizes and blobs. */
  files: SlotlockCmsEntry[];
}

interface PostState {
  slug: string;
  /** The post as it is on its branch, or on main when there is no branch. */
  post: ParsedPost | null;
  /** Why the file would not read, when it would not. */
  broken: string | null;
  onMain: ParsedPost | null;
  branchHead: string | null;
  pull: SlotlockCmsPullRequest | null;
  checks: SlotlockCmsChecks;
  schedule: { sha: string; at: string } | null;
  context: PostContext;
}

const postPath = (slug: string) => `${SLOTLOCK_CMS_POSTS}/${slug}.md`;
const branchOf = (slug: string) => `cms/${slug}`;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const slugOk = (slug: string) => POST_SLUG.test(slug) && !RESERVED_SLUGS.has(slug);

function parseAuthors(text: string | null): Record<string, PostAuthor> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, PostAuthor>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function tryParse(text: string | null, slug: string): { post: ParsedPost | null; broken: string | null } {
  if (text === null) return { post: null, broken: null };
  try {
    return { post: parsePost(text, slug), broken: null };
  } catch (error) {
    return { post: null, broken: error instanceof Error ? error.message : 'it does not read' };
  }
}

/** A post is live when it is published and its date, if any, has come. */
const isLive = (post: ParsedPost, now: number) =>
  post.front.status === 'published' && (!post.front.publishAt || Date.parse(post.front.publishAt) <= now);

const fieldsOf = (post: ParsedPost | null, slug: string, now: number): Fields => ({
  slug,
  title: post?.front.title ?? '',
  seoTitle: post?.front.seoTitle ?? '',
  description: post?.front.description ?? '',
  date: post?.front.date ?? today(now),
  updated: post?.front.updated ?? '',
  publishAt: post?.front.publishAt?.replace(/(?::\d{2})?Z$/, '') ?? '',
  author: post?.front.author ?? '',
  tags: post?.front.tags.join(', ') ?? '',
  eyebrow: post?.front.eyebrow ?? '',
  imageAlt: post?.front.imageAlt ?? '',
  related: post?.front.related.map((link) => `${link.label} | ${link.href}`).join('\n') ?? '',
  body: post?.body ?? '',
});

function readFields(get: (name: string) => string | null | undefined): Fields | null {
  const out = {} as Fields;
  for (const name of FIELD_NAMES) {
    const value = String(get(name) ?? '').replace(/\r\n?/g, '\n');
    if (value.length > FIELD_LIMITS[name]) return null;
    out[name] = name === 'body' || name === 'related' ? value : value.trim();
  }
  return out;
}

/**
 * The post the fields make, checked by writing it out and reading it back with the site's own
 * reader, so the file the console commits is one the site builds.
 */
export function slotlockPostFromFields(
  fields: Fields,
  slug: string,
  options: { status: PostFront['status']; image?: string },
): { post: ParsedPost } | { error: string } {
  const required = (['title', 'description', 'date', 'author', 'imageAlt'] as const).filter((name) => fields[name] === '');
  if (required.length) return { error: `Fill in ${required.join(', ')}.` };
  const publishAt = fields.publishAt === '' ? '' : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fields.publishAt) ? `${fields.publishAt}Z` : null;
  if (publishAt === null) return { error: 'The publish time is a date and a time, in UTC.' };
  const related: { label: string; href: string }[] = [];
  for (const line of fields.related.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const split = line.lastIndexOf('|');
    if (split < 0) return { error: `Write each related page as "Label | /path": "${line.slice(0, 80)}".` };
    related.push({ label: line.slice(0, split).trim(), href: line.slice(split + 1).trim() });
  }
  const front: PostFront = {
    title: fields.title,
    description: fields.description,
    date: fields.date,
    author: fields.author,
    tags: fields.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    image: options.image ?? `blog-${slug}`,
    imageAlt: fields.imageAlt,
    status: options.status,
    related,
  };
  if (fields.seoTitle) front.seoTitle = fields.seoTitle;
  if (fields.updated) front.updated = fields.updated;
  if (fields.eyebrow) front.eyebrow = fields.eyebrow;
  if (publishAt) front.publishAt = publishAt;
  for (const value of [front.date, front.updated ?? '', front.author]) {
    if (/\s/.test(value.trim()) || value.includes('"')) return { error: 'A date or the author holds a character it cannot.' };
  }
  const post: ParsedPost = { slug, front, body: fields.body.replace(/^\n+/, '') };
  try {
    const back = parsePost(serializePost(post), slug);
    if (JSON.stringify(back.front) !== JSON.stringify(front)) return { error: 'A field holds characters the post file cannot keep.' };
    return { post: back };
  } catch (error) {
    if (error instanceof PostFormatError) return { error: `The post would not read back: ${error.message}.` };
    throw error;
  }
}

export interface SlotlockAdminCms {
  /** Whether the CMS answers this path (app.ts checks content.write before calling handle). */
  owns(path: string): boolean;
  handle(request: Request, url: URL, context: SlotlockCmsRequest): Promise<Response>;
}

export function createSlotlockAdminCms(options: SlotlockAdminCmsOptions): SlotlockAdminCms {
  const now = options.now ?? (() => Date.now());
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const site = new URL(options.siteUrl).origin;
  let sitePaths: { value: Set<string> | null; until: number } | null = null;
  let siteFacts: { value: Record<string, unknown> | null; until: number } | null = null;
  const contexts = new Map<string, { value: PostContext; until: number }>();

  async function readSite<T>(path: string, parse: (text: string) => T): Promise<T | null> {
    try {
      const response = await fetcher(`${site}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const text = await response.text();
      return text.length > 2_000_000 ? null : parse(text);
    } catch {
      return null;
    }
  }

  /** Every path the live site has, from its sitemap, kept an hour; null when it cannot be read. */
  async function livePaths(): Promise<Set<string> | null> {
    if (sitePaths && sitePaths.until > now()) return sitePaths.value;
    const value = await readSite('/sitemap-0.xml', (text) => {
      const paths = new Set<string>();
      for (const match of text.matchAll(/<loc>([^<]{1,500})<\/loc>/g)) {
        try {
          const found = new URL(match[1] as string);
          if (found.origin === site) paths.add(found.pathname);
        } catch {
          // Not a URL: skipped.
        }
      }
      return paths.size ? paths : null;
    });
    sitePaths = { value, until: now() + (value ? SITE_CACHE_MS : 60_000) };
    return value;
  }

  /** The facts a post may name, from the live site's /facts.json, kept an hour. */
  async function liveFacts(): Promise<Record<string, unknown> | null> {
    if (siteFacts && siteFacts.until > now()) return siteFacts.value;
    const value = await readSite('/facts.json', (text) => {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    });
    siteFacts = { value, until: now() + (value ? SITE_CACHE_MS : 60_000) };
    return value;
  }

  // ---------- Reading ----------
  function requireGithub(): SlotlockCmsGitHub {
    if (!options.github) throw new SlotlockCmsError('The CMS App is not configured', 503);
    return options.github;
  }

  async function postState(slug: string): Promise<PostState> {
    const github = requireGithub();
    const pull = await github.pullRequestFor(branchOf(slug));
    const branchHead = pull?.headSha ?? (await github.branchHead(branchOf(slug)));
    const ref = branchHead ?? 'main';
    const snap = await github.snapshot({
      directory: { ref: 'main', path: SLOTLOCK_CMS_POSTS },
      files: [
        { ref, path: postPath(slug) },
        { ref, path: SLOTLOCK_CMS_AUTHORS },
      ],
      commits: pull ? [pull.headSha] : [],
    });
    const descriptions: Record<string, string> = {};
    let onMain: ParsedPost | null = null;
    for (const entry of snap.directory) {
      const other = entry.name.endsWith('.md') ? entry.name.slice(0, -3) : null;
      if (!other || !POST_SLUG.test(other)) continue;
      const read = tryParse(entry.text, other).post;
      if (!read) continue;
      if (other === slug) onMain = read;
      else descriptions[other] = read.front.description;
    }
    const { post, broken } = tryParse(snap.files[0] ?? null, slug);
    const [files, schedule, changes] = await Promise.all([
      github.listFiles(`${SLOTLOCK_CMS_IMAGES}/${slug}`, ref),
      pull?.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? github.appComments(pull.number).then(slotlockScheduleOf) : Promise.resolve(null),
      pull ? github.commitFiles(pull.headSha).catch(() => null) : Promise.resolve(null),
    ]);
    // A post this pull request takes away (a rename's old address) is no other post once it merges:
    // its description is not one the post must differ from.
    for (const change of changes ?? []) {
      const gone = change.status === 'removed' ? change.path : change.status === 'renamed' ? change.previous : null;
      const other = gone ? /^site\/content\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\.md$/.exec(gone)?.[1] : undefined;
      if (other) delete descriptions[other];
    }
    const context: PostContext = {
      authors: parseAuthors(snap.files[1] ?? null),
      descriptions,
      files: files.filter((entry) => IMAGE_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)),
    };
    contexts.set(slug, { value: context, until: now() + CONTEXT_CACHE_MS });
    if (contexts.size > 200) contexts.delete(contexts.keys().next().value as string);
    return { slug, post, broken, onMain, branchHead, pull, checks: snap.checks[0] ?? 'none', schedule, context };
  }

  async function contextFor(slug: string): Promise<PostContext> {
    const kept = contexts.get(slug);
    if (kept && kept.until > now()) return kept.value;
    if (!slugOk(slug)) {
      const main = await requireGithub().snapshot({ directory: { ref: 'main', path: SLOTLOCK_CMS_POSTS }, files: [{ ref: 'main', path: SLOTLOCK_CMS_AUTHORS }] });
      const descriptions: Record<string, string> = {};
      for (const entry of main.directory) {
        const other = entry.name.slice(0, -3);
        const read = entry.name.endsWith('.md') && POST_SLUG.test(other) ? tryParse(entry.text, other).post : null;
        if (read) descriptions[other] = read.front.description;
      }
      return { authors: parseAuthors(main.files[0] ?? null), descriptions, files: [] };
    }
    return (await postState(slug)).context;
  }

  /** The preview, the checks and the counters for a post as the editor holds it. */
  async function evaluate(post: ParsedPost, context: PostContext) {
    const [paths, facts] = await Promise.all([livePaths(), liveFacts()]);
    const rendered = renderPostBody(post.body, { slug: post.slug, ...(facts ? { facts } : {}) });
    const known = paths ? new Set([...paths, ...Object.keys(context.descriptions).map((other) => `/blog/${other}/`)]) : null;
    const checks = checkPost(post, rendered, {
      authors: context.authors,
      otherDescriptions: context.descriptions,
      imageFiles: new Set(context.files.map((entry) => entry.name)),
      ...(known ? { sitePaths: known } : {}),
    });
    return { html: rendered.html, checks };
  }

  // ---------- Pages ----------
  const statusPill = (state: { post: ParsedPost | null; pull: SlotlockCmsPullRequest | null; schedule: { sha: string } | null; onMain: ParsedPost | null }) => {
    if (state.pull) {
      if (state.pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL)) {
        return state.schedule ? pill('Scheduled', 'info') : pill('Labelled, not scheduled here', 'warn');
      }
      return state.post?.front.status === 'published' ? pill('In review', 'info') : pill('Draft', 'muted');
    }
    if (state.onMain) return isLive(state.onMain, now()) ? pill('Published', 'good') : pill(state.onMain.front.status === 'draft' ? 'Draft on main' : 'Waiting for its date', 'warn');
    return pill('Draft', 'muted');
  };
  const checksPill = (checks: SlotlockCmsChecks) =>
    checks === 'passing' ? pill('Checks pass', 'good') : checks === 'failing' ? pill('Checks fail', 'bad') : checks === 'pending' ? pill('Checks running', 'warn') : pill('No checks yet', 'muted');
  const previewUrl = (pull: SlotlockCmsPullRequest, slug: string) =>
    options.previewHost ? `https://pr-${pull.number}-${options.previewHost}/blog/${slug}/` : null;

  function notConnected(context: SlotlockCmsRequest, path: string): Response {
    return context.page('Content', path, emptyState(
      html`The CMS is not connected. ${info('Connecting the CMS', html`Install Slotlock's GitHub App on the site's repository, then set <code>SLOTLOCK_ADMIN_CMS_APP_ID</code> and the secret <code>SLOTLOCK_ADMIN_CMS_APP_KEY</code> on the console's Worker (RFC 0006, Phase 0).`)}`,
      html`<a class="btn primary" href="${SLOTLOCK_CMS_SETUP_DOCS}" rel="noreferrer">Connect GitHub</a>`,
    ));
  }

  async function listPage(context: SlotlockCmsRequest, url: URL): Promise<Response> {
    const github = requireGithub();
    const pulls = (await github.pullRequests()).slice(0, 50);
    const slugOfPull = (pull: SlotlockCmsPullRequest) => pull.branch.slice('cms/'.length);
    const snap = await github.snapshot({
      directory: { ref: 'main', path: SLOTLOCK_CMS_POSTS },
      files: pulls.map((pull) => ({ ref: pull.headSha, path: postPath(slugOfPull(pull)) })),
      commits: pulls.map((pull) => pull.headSha),
    });
    const schedules = await Promise.all(
      pulls.map((pull) => (pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? github.appComments(pull.number).then(slotlockScheduleOf) : Promise.resolve(null))),
    );
    const rows = new Map<string, { slug: string; post: ParsedPost | null; onMain: ParsedPost | null; pull: SlotlockCmsPullRequest | null; checks: SlotlockCmsChecks; schedule: { sha: string; at: string } | null }>();
    for (const entry of snap.directory) {
      const slug = entry.name.slice(0, -3);
      if (!entry.name.endsWith('.md') || !POST_SLUG.test(slug)) continue;
      const read = tryParse(entry.text, slug).post;
      rows.set(slug, { slug, post: read, onMain: read, pull: null, checks: 'none', schedule: null });
    }
    pulls.forEach((pull, index) => {
      const slug = slugOfPull(pull);
      const kept = rows.get(slug);
      rows.set(slug, {
        slug,
        post: tryParse(snap.files[index] ?? null, slug).post,
        onMain: kept?.onMain ?? null,
        pull,
        checks: snap.checks[index] ?? 'none',
        schedule: schedules[index] ?? null,
      });
    });
    const ordered = [...rows.values()].sort((a, b) =>
      Number(Boolean(b.pull)) - Number(Boolean(a.pull)) || (b.post?.front.date ?? '').localeCompare(a.post?.front.date ?? '') || a.slug.localeCompare(b.slug));
    const published = (row: (typeof ordered)[number]) => Boolean(row.onMain && isLive(row.onMain, now()));
    const view = url.searchParams.get('view') === 'drafts' ? 'drafts' : url.searchParams.get('view') === 'published' ? 'published' : 'all';
    const shown = ordered.filter((row) => view === 'all' || (view === 'published' ? published(row) : Boolean(row.pull) || !published(row)));
    const code = url.searchParams.get('done') ?? url.searchParams.get('error');
    const body = html`
      ${tabs('Views', [
        { label: 'All', href: '/content', current: view === 'all', count: ordered.length },
        { label: 'Drafts', href: '/content?view=drafts', current: view === 'drafts', count: ordered.filter((row) => Boolean(row.pull) || !published(row)).length },
        { label: 'Published', href: '/content?view=published', current: view === 'published', count: ordered.filter(published).length },
      ], 'views')}
      ${table('Posts', ['Post', 'Status', 'Checks', 'Author', 'Updated'], shown.map((row) => [
        html`<span class="ac-text"><a href="/content/${row.slug}">${row.post?.front.title ?? row.slug}</a><span class="sub mono">/blog/${row.slug}/</span></span>`,
        html`${statusPill(row)}${row.schedule && row.pull?.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? html`<span class="sub">${row.schedule.at.replace('T', ' ').replace('Z', ' UTC')}</span>` : ''}`,
        row.pull ? html`${checksPill(row.checks)}<span class="sub"><a href="${row.pull.url}" rel="noreferrer">#${row.pull.number}</a></span>` : html`–`,
        html`${row.post?.front.author ?? '–'}`,
        html`${row.post ? day(row.post.front.updated ?? row.post.front.date) : '–'}`,
      ]), view === 'all' ? emptyState('No posts yet.', html`<a class="btn primary" href="/content/new">New post</a>`) : 'Nothing here.', { hrefs: shown.map((row) => `/content/${row.slug}`) })}`;
    return context.page('Content', '/content', body, code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined, 200, {
      actions: html`<a class="btn primary" href="/content/new">New post</a>`,
    });
  }

  function editorPage(context: SlotlockCmsRequest, input: {
    state: PostState | null;
    /** Who may be named as the author, and the post's images. */
    postContext: PostContext;
    fields: Fields;
    evaluation: { html: string; checks: PostCheck[] } | null;
    notice?: Notice;
    status?: number;
    problem?: string;
  }): Response {
    const { state, fields, evaluation } = input;
    const slug = state?.slug ?? null;
    const action = slug ? `/content/${slug}` : '/content/new';
    const authors = input.postContext.authors;
    const canPublish = slotlockStaffMay(context.role, 'content.publish');
    const pull = state?.pull ?? null;
    const searchTitle = fields.seoTitle || fields.title;
    const counter = (name: string, value: string, low: number, high: number) =>
      html`<span class="counter${value.length < low || value.length > high ? ' off' : ''}" data-counter="${name}" data-low="${String(low)}" data-high="${String(high)}">${String(value.length)} / ${String(low)} to ${String(high)}</span>`;
    /** A field of the post that sits outside its form (in the inspector), joined to it by the form attribute. */
    const text = (name: keyof Fields, label: string, options: { type?: string; optional?: boolean; extra?: Html | null; attrs?: Html | string } = {}) => field({
      id: `f-${name}`, label, ...(options.optional ? { optional: true } : {}), ...(options.extra ? { extra: options.extra } : {}),
      control: html`<input id="f-${name}" name="${name}" form="post-form" type="${options.type ?? 'text'}" value="${fields[name]}" maxlength="${String(FIELD_LIMITS[name])}" ${options.attrs ?? ''}>`,
    });
    const uploadable = Boolean(slug && state && (state.branchHead || state.onMain));
    const toolbar = html`<div class="md-toolbar" role="toolbar" aria-label="Formatting" aria-controls="f-body" hidden
        data-upload="${uploadable && slug ? `/content/${slug}/images` : ''}" data-limits="${JSON.stringify(Object.fromEntries(Object.entries(POST_FILE_KINDS).map(([ext, kind]) => [ext, kind.max])))}">
        ${TOOLS.map((tool, index) => html`${tool.group ? html`<span class="md-sep" aria-hidden="true"></span>` : ''}<button class="md-tool${tool.text ? ` md-${tool.action}` : ''}" type="button" data-md="${tool.action}" aria-label="${tool.label}" title="${tool.label}${tool.keys ? ` (Ctrl+${tool.keys})` : ''}"${tool.keys ? html` aria-keyshortcuts="${ariaKeys(tool.keys)}"` : ''} tabindex="${index === 0 ? '0' : '-1'}">${tool.text ? html`<span aria-hidden="true">${tool.text}</span>` : tool.glyph ? glyph(GLYPHS[tool.glyph]) : ''}</button>`)}
        <input class="md-file" id="md-file" type="file" accept="${ACCEPT}" multiple hidden tabindex="-1" aria-label="Choose files to upload">
      </div>`;
    const help = info('Writing a post', html`<p><strong>Markdown</strong>: ## and ### headings, **bold**, *italic*, [links](/docs/), - and 1. lists, &gt; quotes, \`\`\` code, tables, --- dividers, {{facts.name}}.</p>
      <p><strong>On a line of its own</strong>: <code>![Alt text](/blog/${slug ?? '…'}/file.png "Caption")</code> shows a picture, a GIF or a video; <code>![Title](https://youtu.be/…)</code> a YouTube or Vimeo player. <code>[Slides (PDF)](/blog/${slug ?? '…'}/slides.pdf)</code> links a PDF to download.</p>
      <p><strong>Files</strong>: paste or drop a screenshot, or upload one. PNG, JPEG, WebP and AVIF up to 5 MB, GIF and PDF 10 MB, MP4 and WebM 20 MB; 20 files and 50 MB a post. SVG and anything else is refused.</p>
      <p><strong>Keys</strong>: Ctrl or ⌘ with B, I, K (link), E (code), Alt+2 and Alt+3 (headings), Shift+8, Shift+7, Shift+. (lists, quote).</p>
      ${options.github ? html`<p><a href="https://github.com/${options.github.repository}/blob/main/site/README.md#write-a-post" rel="noreferrer">How to write a post</a></p>` : ''}`);
    const later = state?.post?.front.publishAt && Date.parse(state.post.front.publishAt) > now();
    const publishing = Boolean(slug && state && pull && canPublish);
    const actions = html`
      <button class="btn" type="submit" form="post-form" name="intent" value="save">Save draft</button>
      <button class="btn${publishing ? '' : ' primary'}" type="submit" form="post-form" name="intent" value="submit">Submit for review</button>
      ${publishing && state && pull ? html`<form class="inline publish" method="post" action="/content/${state.slug}/publish">
          <input type="hidden" name="csrf" value="${context.csrf}">
          <input type="hidden" name="sha" value="${pull.headSha}">
          <button class="btn primary" type="submit" title="Merges commit ${pull.headSha.slice(0, 7)} into main once the checks pass">${later ? 'Schedule' : 'Publish'}</button>
        </form>` : ''}`;
    const statusFacts = slug && state ? html`<section>
        ${facts([
          ['Status', html`${statusPill(state)}${state.schedule && pull?.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? html`<span class="sub">For ${state.schedule.at.replace('T', ' ').replace('Z', ' UTC')}</span>` : ''}`],
          pull ? ['Pull request', html`<a href="${pull.url}" rel="noreferrer">#${pull.number}</a> ${checksPill(state.checks)}`] : null,
          pull && previewUrl(pull, slug) ? ['Preview deploy', html`<a href="${previewUrl(pull, slug) ?? ''}" rel="noreferrer">The whole site, with this post</a>`] : null,
          state.onMain && isLive(state.onMain, now()) ? ['Live', html`<a href="${site}/blog/${slug}/" rel="noreferrer">${site.replace('https://', '')}/blog/${slug}/</a>`] : null,
          pull && canPublish ? ['Publishes', html`<code>${pull.headSha.slice(0, 7)}</code>${info('Publishing', `Merges this commit into main${later ? ', or schedules it for its publish time' : ''}. It needs the checks to pass and a passkey in the last 15 minutes.`)}`] : null,
        ])}
        ${pull && canPublish && pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? html`<form method="post" action="/content/${state.slug}/unschedule"><input type="hidden" name="csrf" value="${context.csrf}"><button class="link" type="submit">Unschedule</button></form>` : ''}
      </section>` : '';
    const body = html`
      <link rel="stylesheet" href="/editor.css">
      ${input.problem ? html`<div class="callout warn" role="alert"><p>${input.problem}</p></div>` : ''}
      <div class="editor">
        <form id="post-form" class="editor-main form" method="post" action="${action}" data-slug="${slug ?? ''}">
          <input type="hidden" name="csrf" value="${context.csrf}">
          <input type="hidden" name="head" value="${state?.branchHead ?? ''}">
          ${slug ? html`<input type="hidden" name="slug" value="${slug}">` : field({ id: 'f-slug', label: 'Address', extra: info('The address', html`/blog/<em>this</em>/: lowercase words and hyphens.`), control: html`<input id="f-slug" name="slug" type="text" value="${fields.slug}" maxlength="${String(FIELD_LIMITS.slug)}" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false">` })}
          ${field({ id: 'f-title', label: 'Title', extra: counter('title', fields.title, 20, 65), control: html`<input id="f-title" class="title-input" name="title" type="text" value="${fields.title}" maxlength="200" required>` })}
          ${field({ id: 'f-body', label: 'Post', extra: help, control: html`<div class="md-box">${toolbar}<textarea id="f-body" class="cms-body" name="body" rows="26" maxlength="100000" spellcheck="true">${fields.body}</textarea><p class="md-drop" aria-hidden="true">Drop to upload</p></div>` })}
          <p class="readback" id="preview-status" role="status"></p>
        </form>
        <section class="preview-pane" aria-label="Preview">
          <fieldset class="ptabs"><legend class="sr-only">Preview as</legend>
            <label><input type="radio" name="preview-as" id="pt-article" checked><span>Article</span></label>
            <label><input type="radio" name="preview-as" id="pt-serp"><span>Search result</span></label>
            <label><input type="radio" name="preview-as" id="pt-card"><span>Link card</span></label>
          </fieldset>
          <div class="ppanel pp-article"><article class="article" id="preview">${new Html(evaluation?.html ?? '')}</article></div>
          <div class="ppanel pp-serp"><div class="serp" id="serp">
            <span class="serp-url">${site.replace('https://', '')} › blog › ${slug ?? fields.slug}</span>
            <span class="serp-title" data-serp="title">${searchTitle || 'The title'}</span>
            <span class="serp-text" data-serp="description">${fields.description || 'The description.'}</span>
          </div></div>
          <div class="ppanel pp-card"><div class="og" aria-hidden="true"><span class="og-eyebrow" data-serp="eyebrow">${fields.eyebrow || 'Blog'}</span><span class="og-title" data-serp="og-title">${fields.title || 'The title'}</span><span class="og-site">slotlock.pylota.io</span></div></div>
        </section>
        <aside class="inspector" aria-label="Post">
          <fieldset class="ptabs"><legend class="sr-only">Settings</legend>
            <label><input type="radio" name="inspect" id="it-post" checked><span>Post</span></label>
            <label><input type="radio" name="inspect" id="it-seo"><span>SEO</span></label>
            <label><input type="radio" name="inspect" id="it-images"><span>Media</span></label>
          </fieldset>
          <div class="itabs-panel ip-post form">
            ${statusFacts}
            <div class="form-grid">
              ${text('date', 'Date', { type: 'date', attrs: 'required' })}
              ${text('updated', 'Updated', { type: 'date', optional: true })}
            </div>
            ${text('publishAt', 'Publish at, UTC', { type: 'datetime-local', optional: true })}
            ${field({ id: 'f-author', label: 'Author', control: html`<select id="f-author" name="author" form="post-form" required>
                <option value="">Choose</option>
                ${Object.entries(authors).map(([key, author]) => html`<option value="${key}" ${fields.author === key ? new Html('selected') : ''}>${author.name}</option>`)}
              </select>` })}
            ${text('tags', 'Tags', { extra: info('Tags', 'One to five, with a comma between.') })}
            ${text('eyebrow', 'Eyebrow', { optional: true })}
            <section aria-labelledby="checks-title"><h2 id="checks-title">Checks ${info('Checks', 'The site’s own rules. Submitting needs every one to pass; GitHub runs the site’s build on the pull request too.')}</h2>
              <ul class="checks" id="checks">${checksList(evaluation?.checks ?? null)}</ul></section>
            ${slug && state ? dangerPanel(context, state) : ''}
          </div>
          <div class="itabs-panel ip-seo form">
            ${text('seoTitle', 'Search title', { optional: true, extra: info('Search title', 'For a title over 65 characters: what search results show instead.') })}
            ${field({ id: 'f-description', label: 'Description', extra: counter('description', fields.description, 70, 160), control: html`<textarea id="f-description" name="description" form="post-form" rows="3" maxlength="400" required>${fields.description}</textarea>` })}
            ${text('imageAlt', 'Link card alt text')}
            ${field({ id: 'f-related', label: 'Related pages', extra: info('Related pages', 'One to four, each "Label | /path" on its own line.'), control: html`<textarea id="f-related" name="related" form="post-form" rows="4" maxlength="2000" placeholder="Label | /path">${fields.related}</textarea>` })}
          </div>
          <div class="itabs-panel ip-images form" id="images">
            <div id="media-list">${mediaList(context, slug ?? '', input.postContext.files)}</div>
            ${uploadable && slug ? html`<form class="form media-upload" id="media-upload" method="post" action="/content/${slug}/images" enctype="multipart/form-data">
              <input type="hidden" name="csrf" value="${context.csrf}">
              ${field({ id: 'f-image', label: 'File', extra: info('Files', html`PNG, JPEG, WebP or AVIF up to 5 MB; GIF or PDF up to 10 MB; MP4 or WebM up to 20 MB. Known by its bytes: an SVG, a QuickTime .mov or anything else is refused. A post holds 20 files and 50 MB.`), control: html`<input id="f-image" name="image" type="file" accept="${ACCEPT}" required>` })}
              ${field({ id: 'f-image-name', label: 'File name', optional: true, control: html`<input id="f-image-name" name="name" type="text" maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false">` })}
              <div class="form-actions"><button class="btn sm" type="submit">Upload</button></div>
            </form>` : html`<p class="muted">Save the post first, then add its pictures and videos.</p>`}
          </div>
        </aside>
      </div>
      ${dialogs()}`;
    return withMedia(context.page(state?.post?.front.title || (slug ?? 'New post'), '/content', body, input.notice, input.status ?? 200, {
      crumbs: [{ label: 'Content', href: '/content' }],
      ...(state ? { pills: html`${statusPill(state)}${pull ? checksPill(state.checks) : ''}` } : {}),
      actions,
    }));
  }

  /** The post's files in its Media panel: each to insert (with the script) or delete, and its Markdown. */
  function mediaList(context: SlotlockCmsRequest, slug: string, files: readonly SlotlockCmsEntry[]): Html {
    if (!files.length) return html`<p class="muted">No files yet. Paste or drop a screenshot into the post, or upload one.</p>`;
    return html`<ul class="list media-list">${files.map((entry) => {
      const kind = postFileKind(entry.name);
      const src = `${postImagePath(slug)}${entry.name}`;
      const markdown = kind?.kind === 'file' ? `[What it is (PDF)](${src})` : `![Describe it](${src})`;
      return html`<li class="media-item">
        <span class="media-thumb">${kind?.kind === 'image' ? html`<img src="${src}" alt="" loading="lazy" decoding="async" width="40" height="40">` : glyph(GLYPHS[kind?.kind === 'video' ? 'video' : 'file'])}</span>
        <span class="media-text"><span class="media-name">${entry.name}</span><span class="sub">${(kind?.type ?? '').toUpperCase()} · ${postFileSize(entry.size)}</span><code class="media-md">${markdown}</code></span>
        <span class="media-actions">
          <button class="btn sm" type="button" data-insert="${src}" data-kind="${kind?.kind ?? 'image'}" hidden>Insert</button>
          <form method="post" action="/content/${slug}/images/remove" class="media-remove" data-name="${entry.name}"><input type="hidden" name="csrf" value="${context.csrf}"><input type="hidden" name="name" value="${entry.name}"><button class="icon-btn ghost sm" type="submit" title="Delete ${entry.name}" aria-label="Delete ${entry.name}">${glyph(GLYPHS.trash)}</button></form>
        </span>
      </li>`;
    })}</ul>`;
  }

  /** The dialogs the editor's script opens: alt text for a file, and a video's address and title. */
  function dialogs(): Html {
    return html`<dialog class="md-dialog" id="file-dialog" aria-labelledby="file-dialog-title">
      <form method="dialog" class="form">
        <h2 id="file-dialog-title">Add a picture</h2>
        <div class="md-dialog-file"><img id="file-dialog-img" alt="" hidden><span id="file-dialog-name" class="mono"></span></div>
        ${field({ id: 'fd-alt', label: 'Alt text', extra: info('Alt text', 'What it shows, for someone who cannot see it. A PDF\u2019s is the link\u2019s words.'), control: html`<input id="fd-alt" type="text" maxlength="200" required autocomplete="off">` })}
        ${field({ id: 'fd-caption', label: 'Caption', optional: true, control: html`<input id="fd-caption" type="text" maxlength="200" autocomplete="off">` })}
        <div class="form-actions"><button class="btn primary" id="file-dialog-ok" value="ok">Upload</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
      </form>
    </dialog>
    <dialog class="md-dialog" id="embed-dialog" aria-labelledby="embed-dialog-title">
      <form method="dialog" class="form">
        <h2 id="embed-dialog-title">Embed a video</h2>
        ${field({ id: 'ed-url', label: 'YouTube or Vimeo address', control: html`<input id="ed-url" type="url" maxlength="300" required autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…">` })}
        ${field({ id: 'ed-title', label: 'Title', control: html`<input id="ed-title" type="text" maxlength="200" required autocomplete="off">` })}
        ${field({ id: 'ed-caption', label: 'Caption', optional: true, control: html`<input id="ed-caption" type="text" maxlength="200" autocomplete="off">` })}
        <p class="readback" id="embed-dialog-problem" role="alert"></p>
        <div class="form-actions"><button class="btn primary" value="ok">Insert</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
      </form>
    </dialog>`;
  }

  function checksList(checks: PostCheck[] | null): Html {
    if (!checks) return html`<li class="muted">Shown once the post has a title and a body.</li>`;
    return html`${checks.map((check) => html`<li class="${check.ok ? 'ok' : 'bad'}"><span class="mark" aria-hidden="true">${check.ok ? '✓' : '✗'}</span><span><strong>${check.name}</strong><span class="sr-only">${check.ok ? ': passes.' : ': fails.'}</span> <span class="sub">${check.detail}</span></span></li>`)}`;
  }

  function dangerPanel(context: SlotlockCmsRequest, state: PostState): Html {
    const renameable = state.onMain && isLive(state.onMain, now()) && !state.branchHead;
    if (!renameable && !state.branchHead) return html``;
    return html`<section aria-labelledby="post-danger">
      <h2 id="post-danger">${renameable ? 'Address' : 'Draft'}</h2>
      ${renameable ? popover('Rename', html`<form class="form" method="post" action="/content/${state.slug}/rename">
        <input type="hidden" name="csrf" value="${context.csrf}">
        ${field({ id: 'f-rename', label: 'New address', extra: info('Renaming', 'Opens a pull request that moves the post and its files, and redirects the old address.'), control: html`<input id="f-rename" name="to" type="text" required maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false">` })}
        <div class="form-actions"><button class="btn primary" type="submit">Rename</button></div>
      </form>`, { size: 'sm', align: 'left' }) : ''}
      ${state.branchHead ? popover('Discard draft', html`<form class="form" method="post" action="/content/${state.slug}/discard">
        <input type="hidden" name="csrf" value="${context.csrf}">
        <p class="muted">Closes the pull request and deletes the branch. ${state.onMain ? 'The published post stays as it is.' : 'The post was never published, so it goes.'}</p>
        <div class="form-actions"><button class="btn danger" type="submit">Discard draft</button></div>
      </form>`, { tone: 'danger', size: 'sm', align: 'left' }) : ''}
    </section>`;
  }

  // ---------- Requests ----------
  async function formOf(request: Request, limit: number): Promise<URLSearchParams | null> {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;
    const text = await request.text();
    return text.length > limit ? null : new URLSearchParams(text);
  }

  /** Publishing, renaming and discarding need a passkey in the last 15 minutes, as every action does. */
  const passkeyAgain = (context: SlotlockCmsRequest, slug: string) =>
    context.redirect(`/passkey?${new URLSearchParams({ next: `/content/${slug}`, fresh: '1' }).toString()}`);

  const back = (context: SlotlockCmsRequest, to: string, code: keyof typeof NOTICES, ok: boolean) =>
    context.redirect(`${to}?${new URLSearchParams({ [ok ? 'done' : 'error']: code }).toString()}`);

  function githubFailed(error: unknown): boolean {
    if (!(error instanceof SlotlockCmsError)) return false;
    console.error('slotlock-admin-cms', error.status, error.message);
    return true;
  }

  async function save(request: Request, context: SlotlockCmsRequest, slugInPath: string | null): Promise<Response> {
    const form = await formOf(request, 600 * 1024);
    if (!form) return context.redirect(`${slugInPath ? `/content/${slugInPath}` : '/content/new'}?error=invalid`);
    if (!context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    const fields = readFields((name) => form.get(name));
    const slug = slugInPath ?? fields?.slug ?? '';
    if (!fields || !slugOk(slug)) {
      return editorPage(context, { state: null, postContext: await contextFor('new'), fields: fields ?? fieldsOf(null, '', now()), evaluation: null, problem: 'The address is lowercase words and hyphens, and every field has a length it fits in.', status: 422 });
    }
    const intent = form.get('intent') === 'submit' ? 'submit' : 'save';
    const head = form.get('head') ?? '';
    if (head !== '' && !SHA.test(head)) return context.redirect(`/content/${slug}?error=invalid`);
    const github = requireGithub();
    const state = await postState(slug);
    if (!slugInPath && (state.onMain || state.branchHead)) {
      return editorPage(context, { state: null, postContext: state.context, fields, evaluation: null, ...(NOTICES.slug_taken ? { notice: NOTICES.slug_taken } : {}), status: 409 });
    }
    const made = slotlockPostFromFields(fields, slug, { status: intent === 'submit' ? 'published' : 'draft', ...(state.post ? { image: state.post.front.image } : {}) });
    const shown = slugInPath ? state : null;
    if ('error' in made) {
      return editorPage(context, { state: shown, postContext: state.context, fields, evaluation: null, problem: made.error, status: 422 });
    }
    const evaluation = await evaluate(made.post, state.context);
    if (intent === 'submit' && evaluation.checks.some((check) => !check.ok)) {
      return editorPage(context, { state: shown, postContext: state.context, fields, evaluation, problem: 'Not submitted: fix the checks marked ✗, or save it as a draft.', status: 422 });
    }
    await context.record(intent === 'submit' ? 'content.submitted' : 'content.saved', slug, state.pull ? { pr: state.pull.number } : {});
    try {
      await github.commit({
        branch: branchOf(slug),
        base: 'main',
        files: [{ path: postPath(slug), content: serializePost(made.post) }],
        message: `Blog: ${intent === 'submit' ? 'submit' : 'save'} "${made.post.front.title}"`,
        author: { login: context.login, id: context.staff.slice('github:'.length) },
        expectHead: head === '' ? null : head,
      });
      let pull = state.pull;
      if (!pull) {
        pull = await github.openPullRequest({
          branch: branchOf(slug),
          title: `Blog: ${made.post.front.title}`,
          body: [
            `A blog post written in the admin console by ${context.login}: \`site/content/blog/${slug}.md\`.`,
            '',
            'Saving keeps it a draft (`status: draft`); submitting marks it ready (`status: published`). An Owner publishes it from the console, which merges this pull request once its checks pass. Change it in the console, not here: the console refuses to merge a pull request that changes anything but blog files.',
          ].join('\n'),
        });
      } else if (pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL)) {
        // A new commit cancels a schedule: an Owner looks at it again.
        await github.removeLabel(pull.number, SLOTLOCK_CMS_SCHEDULED_LABEL);
      }
    } catch (error) {
      if (error instanceof SlotlockCmsError && error.status === 409) {
        return editorPage(context, { state: shown, postContext: state.context, fields, evaluation, problem: 'Not saved: the post changed on GitHub since you opened it. Copy your text, reload the page, and save again.', status: 409 });
      }
      if (!githubFailed(error)) throw error;
      return editorPage(context, { state: shown, postContext: state.context, fields, evaluation, ...(NOTICES.github ? { notice: NOTICES.github } : {}), status: 502 });
    }
    contexts.delete(slug);
    return back(context, `/content/${slug}`, intent === 'submit' ? 'submitted' : 'saved', true);
  }

  async function preview(request: Request, context: SlotlockCmsRequest): Promise<Response> {
    if (request.headers.get('x-slotlock-admin') !== '1' || !(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return context.json({ error: 'Refused.' }, 400);
    }
    const text = await request.text();
    if (text.length > 600 * 1024) return context.json({ error: 'Too large.' }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return context.json({ error: 'Not JSON.' }, 400);
    }
    if (!context.csrfOk(typeof body.csrf === 'string' ? body.csrf : '')) return context.json({ error: 'Reload the page.' }, 403);
    const fields = readFields((name) => (typeof body[name] === 'string' ? (body[name] as string) : ''));
    if (!fields) return context.json({ error: 'A field is too long.' }, 422);
    const slug = slugOk(fields.slug) ? fields.slug : 'new-post';
    const made = slotlockPostFromFields(fields, slug, { status: 'draft' });
    const context_ = await contextFor(slugOk(fields.slug) ? slug : 'new');
    if ('error' in made) {
      const rendered = renderPostBody(fields.body, { slug });
      return context.json({ html: rendered.html, checks: checksList([{ name: 'Settings', ok: false, detail: made.error }]).value });
    }
    const evaluation = await evaluate(made.post, context_);
    return context.json({ html: evaluation.html, checks: checksList(evaluation.checks).value });
  }

  /** A request from the editor's own script, which wants JSON back instead of a page. */
  const fromScript = (request: Request) =>
    request.headers.get('x-slotlock-admin') === '1' && (request.headers.get('accept') ?? '').includes('application/json');

  /** A file name from what was asked or the file's own name: lowercase words and hyphens, and the extension its bytes name. */
  function fileName(asked: string, original: string, type: string, taken: ReadonlySet<string>, replace: boolean): string | null {
    const kind = POST_FILE_KINDS[type];
    const stem = (asked || original.replace(/\.[A-Za-z0-9]+$/, ''))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 12).join('-').slice(0, 60).replace(/-+$/, '')
      || (kind?.kind === 'video' ? 'video' : kind?.kind === 'file' ? 'file' : 'image');
    const first = `${stem}.${type}`;
    if (!IMAGE_FILE.test(first)) return null;
    if (replace || !taken.has(first)) return first;
    // A second screenshot named image.png is image-2.png, never the first one replaced.
    for (let index = 2; index < 100; index += 1) {
      const next = `${stem}-${index}.${type}`;
      if (IMAGE_FILE.test(next) && !taken.has(next)) return next;
    }
    return null;
  }

  async function upload(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const script = fromScript(request);
    const fail = (code: keyof typeof NOTICES, status = 422, detail?: string) =>
      script ? context.json({ error: detail ?? NOTICES[code]?.text ?? 'Not uploaded.' }, status) : back(context, `/content/${slug}`, code, false);
    if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return fail('image_invalid', 400);
    const length = Number(request.headers.get('content-length') ?? 'NaN');
    if (!Number.isFinite(length) || length > SLOTLOCK_CMS_UPLOAD_MAX) return fail('file_large', 413);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail('image_invalid', 400);
    }
    const token = form.get('csrf');
    if (!context.csrfOk(typeof token === 'string' ? token : '')) return script ? context.json({ error: 'Reload the page.' }, 403) : context.redirect('/content?error=invalid');
    const file = form.get('image');
    if (!file || typeof file === 'string' || file.size === 0) return fail('image_invalid', 400);
    // Known by its first bytes before the rest is read: an SVG or a .mov named .png goes no further.
    const type = postFileType(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
    const kind = type ? POST_FILE_KINDS[type] : undefined;
    if (!type || !kind) return fail('file_type', 415, `${file.name || 'That file'}: ${NOTICES.file_type?.text ?? ''}`);
    if (file.size > kind.max) return fail('file_large', 413, `${file.name || 'That file'} is ${postFileSize(file.size)}: ${NOTICES.file_large?.text ?? ''}`);
    const state = await postState(slug);
    if (!state.post) return fail('save_first', 409);
    const replace = form.get('replace') === '1';
    const taken = new Set(state.context.files.map((entry) => entry.name));
    const name = fileName(String(form.get('name') ?? '').trim(), file.name, type, taken, replace);
    if (!name) return fail('image_invalid', 422, 'Name the file in lowercase words and hyphens.');
    const others = state.context.files.filter((entry) => entry.name !== name);
    if (others.length + 1 > POST_FILES_MAX || others.reduce((sum, entry) => sum + entry.size, 0) + file.size > POST_FILES_TOTAL) return fail('file_full', 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = postFileProblem(name, bytes);
    if (problem) return fail('file_type', 422, problem);
    await context.record('content.image_added', slug, { image: name, bytes: bytes.length });
    let head: string;
    try {
      head = await commitAndOpen(context, state, [{ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, content: bytes }], `Blog: add ${name} to "${state.post.front.title}"`);
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return script ? context.json({ error: NOTICES.github?.text ?? 'GitHub did not take it.' }, 502) : back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    if (!script) return context.redirect(`/content/${slug}?done=image_added#images`);
    const files = [...others, { name, size: bytes.length, sha: '' }].sort((a, b) => a.name.localeCompare(b.name));
    return context.json({ name, src: `${postImagePath(slug)}${name}`, kind: kind.kind, size: bytes.length, head, media: mediaList(context, slug, files).value });
  }

  /** Commit to the post's branch, opening its pull request when it has none; the branch's new head. */
  async function commitAndOpen(context: SlotlockCmsRequest, state: PostState, files: SlotlockCmsFile[], message: string): Promise<string> {
    const github = requireGithub();
    const head = await github.commit({
      branch: branchOf(state.slug),
      base: 'main',
      files,
      message,
      author: { login: context.login, id: context.staff.slice('github:'.length) },
      expectHead: state.branchHead,
    });
    if (!state.pull) {
      await github.openPullRequest({
        branch: branchOf(state.slug),
        title: `Blog: ${state.post?.front.title ?? state.slug}`,
        body: `A change to the blog post \`site/content/blog/${state.slug}.md\`, made in the admin console by ${context.login}. An Owner publishes it from the console.`,
      });
    } else if (state.pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL)) {
      await github.removeLabel(state.pull.number, SLOTLOCK_CMS_SCHEDULED_LABEL);
    }
    return head;
  }

  async function removeImage(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const script = fromScript(request);
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return script ? context.json({ error: 'Reload the page.' }, 403) : context.redirect('/content?error=invalid');
    const name = form.get('name') ?? '';
    const state = await postState(slug);
    if (!IMAGE_FILE.test(name) || !state.context.files.some((entry) => entry.name === name) || !state.post) {
      return script ? context.json({ error: 'That file is not the post\'s.' }, 404) : back(context, `/content/${slug}`, 'invalid', false);
    }
    await context.record('content.image_removed', slug, { image: name });
    let head: string;
    try {
      head = await commitAndOpen(context, state, [{ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, content: null }], `Blog: delete ${name} from "${state.post.front.title}"`);
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return script ? context.json({ error: NOTICES.github?.text ?? 'GitHub did not take it.' }, 502) : back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    if (!script) return context.redirect(`/content/${slug}?done=image_removed#images`);
    return context.json({ name, head, media: mediaList(context, slug, state.context.files.filter((entry) => entry.name !== name)).value });
  }

  async function rename(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    if (!context.fresh) return passkeyAgain(context, slug);
    const to = (form.get('to') ?? '').trim();
    if (!slugOk(to) || to === slug) return back(context, `/content/${slug}`, 'invalid', false);
    const github = requireGithub();
    const state = await postState(slug);
    if (!state.onMain || !isLive(state.onMain, now()) || state.branchHead) return back(context, `/content/${slug}`, 'rename_draft', false);
    const target = await postState(to);
    if (target.onMain || target.branchHead) return back(context, `/content/${slug}`, 'slug_taken', false);
    await context.record('content.renamed', slug, { to });
    try {
      const old = postImagePath(slug);
      const moved: ParsedPost = { ...state.onMain, slug: to, body: state.onMain.body.split(`](${old}`).join(`](${postImagePath(to)}`) };
      const redirects = (await github.readFile(SLOTLOCK_CMS_REDIRECTS, 'main'))?.text ?? '';
      const files: SlotlockCmsFile[] = [
        { path: postPath(slug), content: null },
        { path: postPath(to), content: serializePost(moved) },
        { path: SLOTLOCK_CMS_REDIRECTS, content: slotlockRedirectsWith(redirects, slug, to) },
      ];
      // Each file moves as the blob it is: nothing is read or sent again, however large.
      for (const entry of state.context.files) {
        files.push({ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${entry.name}`, content: null }, { path: `${SLOTLOCK_CMS_IMAGES}/${to}/${entry.name}`, content: { blob: entry.sha } });
      }
      await github.commit({
        branch: branchOf(to),
        base: 'main',
        files,
        message: `Blog: move /blog/${slug}/ to /blog/${to}/`,
        author: { login: context.login, id: context.staff.slice('github:'.length) },
        expectHead: null,
      });
      await github.openPullRequest({
        branch: branchOf(to),
        title: `Blog: move /blog/${slug}/ to /blog/${to}/`,
        body: `Renamed in the admin console by ${context.login}: the post, its files, and redirects from the old address (\`site/public/_redirects\`). An Owner publishes it from the console.`,
      });
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    contexts.delete(to);
    return back(context, `/content/${to}`, 'renamed', true);
  }

  async function discard(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    if (!context.fresh) return passkeyAgain(context, slug);
    const github = requireGithub();
    const state = await postState(slug);
    if (!state.branchHead) return back(context, `/content/${slug}`, 'invalid', false);
    await context.record('content.discarded', slug, state.pull ? { pr: state.pull.number } : {});
    try {
      if (state.pull) await github.close(state.pull.number, branchOf(slug));
      else await github.deleteBranch(branchOf(slug));
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    return back(context, '/content', 'discarded', true);
  }

  async function publish(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    if (!slotlockStaffMay(context.role, 'content.publish')) return context.page('Not allowed', '/content', emptyState(`Your role (${context.role}) does not publish posts.`), undefined, 403, { crumbs: [{ label: 'Content', href: '/content' }] });
    if (!context.fresh) return passkeyAgain(context, slug);
    const sha = form.get('sha') ?? '';
    const github = requireGithub();
    const state = await postState(slug);
    const pull = state.pull;
    if (!pull || !SHA.test(sha) || pull.headSha !== sha) return back(context, `/content/${slug}`, 'changed', false);
    // What merging exactly this commit brings: its own post and images, or a rename's (never the
    // files of whatever the branch holds a moment later).
    const files = await github.commitFiles(sha);
    if (!files || !slotlockCmsChangeAllowed(slug, files)) return back(context, `/content/${slug}`, 'not_content', false);
    if (!state.post || state.post.front.status !== 'published') return back(context, `/content/${slug}`, 'not_submitted', false);
    const onGithub = await github.checks(sha);
    if (onGithub === 'pending' || onGithub === 'none') return back(context, `/content/${slug}`, 'checks_pending', false);
    const evaluation = await evaluate(state.post, state.context);
    if (onGithub === 'failing' || evaluation.checks.some((check) => !check.ok)) return back(context, `/content/${slug}`, 'checks_failing', false);
    const live = await github.pullState(pull.number);
    if (!live.open || live.headSha !== sha) return back(context, `/content/${slug}`, 'changed', false);
    if (live.mergeable === 'dirty') return back(context, `/content/${slug}`, 'conflict', false);
    const at = state.post.front.publishAt;
    if (at && Date.parse(at) > now()) {
      // The schedule names this commit's content: bringing the branch up to date with main later
      // (here, or by the hourly workflow) keeps it.
      await context.record('content.scheduled', slug, { pr: pull.number, sha, at });
      try {
        await github.comment(pull.number, slotlockScheduleComment({ sha, at, by: context.login }));
        await github.addLabel(pull.number, SLOTLOCK_CMS_SCHEDULED_LABEL);
        if (live.mergeable === 'behind') await github.updateBranch(pull.number, sha);
      } catch (error) {
        if (!githubFailed(error)) throw error;
        return back(context, `/content/${slug}`, 'github', false);
      }
      contexts.delete(slug);
      return back(context, `/content/${slug}`, 'scheduled', true);
    }
    if (live.mergeable === 'behind') {
      // Main's ruleset merges only a branch that is up to date with main, and its checks run again.
      await context.record('content.updated', slug, { pr: pull.number, sha });
      try {
        await github.updateBranch(pull.number, sha);
      } catch (error) {
        if (!githubFailed(error)) throw error;
        return back(context, `/content/${slug}`, 'github', false);
      }
      contexts.delete(slug);
      return back(context, `/content/${slug}`, 'updating', false);
    }
    await context.record('content.published', slug, { pr: pull.number, sha });
    let merged: { merged: boolean; message: string };
    try {
      const signOffs = new Set(await github.signOffs(pull.number));
      signOffs.add(slotlockSignOff({ login: context.login, id: context.staff.slice('github:'.length) }));
      merged = await github.merge({
        number: pull.number,
        sha,
        title: pull.title,
        message: [`Published from the admin console by ${context.login}.`, '', ...signOffs].join('\n'),
      });
      if (merged.merged) await github.deleteBranch(branchOf(slug));
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    if (!merged.merged) {
      console.error('slotlock-admin-cms', 'merge refused', merged.message);
      return back(context, `/content/${slug}`, 'merge_refused', false);
    }
    contexts.delete(slug);
    return back(context, `/content/${slug}`, 'published', true);
  }

  async function unschedule(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    if (!slotlockStaffMay(context.role, 'content.publish')) return context.page('Not allowed', '/content', emptyState(`Your role (${context.role}) does not publish posts.`), undefined, 403, { crumbs: [{ label: 'Content', href: '/content' }] });
    if (!context.fresh) return passkeyAgain(context, slug);
    const github = requireGithub();
    const pull = await github.pullRequestFor(branchOf(slug));
    if (!pull) return back(context, `/content/${slug}`, 'invalid', false);
    await context.record('content.unscheduled', slug, { pr: pull.number });
    try {
      await github.removeLabel(pull.number, SLOTLOCK_CMS_SCHEDULED_LABEL);
      await github.comment(pull.number, `<!-- slotlock-cms:unschedule -->\nUnscheduled from the admin console by ${context.login}.`);
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    return back(context, `/content/${slug}`, 'unscheduled', true);
  }

  /**
   * A post's file for the preview, from its branch (or main): served only as what its bytes are, and
   * a part of it when a player asks for a range (Safari plays a video only so).
   */
  async function postFile(request: Request, slug: string, name: string): Promise<Response> {
    const github = requireGithub();
    const kind = postFileKind(name);
    const branch = await github.branchHead(branchOf(slug));
    const bytes = kind ? await github.readBytes(`${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, branch ?? 'main') : null;
    if (!bytes || !kind || postFileType(bytes) !== kind.type) {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const headers: Record<string, string> = {
      'Content-Type': kind.mime,
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ...(kind.kind === 'file' ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
    };
    const range = request.headers.get('range');
    if (range === null) return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...headers, 'Content-Length': String(bytes.length) } });
    const asked = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(range.trim());
    let from = asked && asked[1] !== '' ? Number(asked[1]) : null;
    let to = asked && asked[2] !== '' ? Number(asked[2]) : null;
    if (asked && from === null && to !== null) {
      // The last bytes.
      from = Math.max(bytes.length - to, 0);
      to = bytes.length - 1;
    }
    if (!asked || from === null || from >= bytes.length || (to !== null && to < from)) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` } });
    }
    const last = Math.min(to ?? bytes.length - 1, bytes.length - 1);
    const part = bytes.subarray(from, last + 1);
    return new Response(request.method === 'HEAD' ? null : part, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${from}-${last}/${bytes.length}`, 'Content-Length': String(part.length) },
    });
  }

  async function editor(context: SlotlockCmsRequest, url: URL, slug: string | null): Promise<Response> {
    const code = url.searchParams.get('done') ?? url.searchParams.get('error');
    const notice = code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined;
    if (!slug) {
      return editorPage(context, { state: null, postContext: await contextFor('new'), fields: fieldsOf(null, '', now()), evaluation: null, ...(notice ? { notice } : {}) });
    }
    const state = await postState(slug);
    if (!state.post && !state.broken) {
      return context.page('Not found', '/content', emptyState('There is no post at this address.', html`<a class="btn" href="/content">All posts</a>`), undefined, 404, { crumbs: [{ label: 'Content', href: '/content' }] });
    }
    if (!state.post) {
      return context.page(slug, '/content', html`<div class="callout warn"><p>The post’s file does not read: ${state.broken ?? ''}</p></div>
        <p class="prose">Fix <code>site/content/blog/${slug}.md</code> on GitHub${state.pull ? html` (<a href="${state.pull.url}" rel="noreferrer">#${state.pull.number}</a>)` : ''}, then open it here again.</p>`, undefined, 422, { crumbs: [{ label: 'Content', href: '/content' }] });
    }
    const evaluation = await evaluate(state.post, state.context);
    return editorPage(context, { state, postContext: state.context, fields: fieldsOf(state.post, slug, now()), evaluation, ...(notice ? { notice } : {}) });
  }

  const IMAGE_ROUTE = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\/([a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp|avif|gif|mp4|webm|pdf))$/;
  const POST_ROUTE = /^\/content\/([a-z0-9]+(?:-[a-z0-9]+){0,15})(?:\/(images|images\/remove|rename|discard|publish|unschedule))?$/;

  return {
    owns(path) {
      return path === '/content' || path.startsWith('/content/') || IMAGE_ROUTE.test(path);
    },

    async handle(request, url, context) {
      const path = url.pathname;
      if (!options.github) return notConnected(context, path);
      const post = request.method === 'POST';
      try {
        if (path === '/content') return post ? context.redirect('/content') : await listPage(context, url);
        if (path === '/content/new') return post ? await save(request, context, null) : await editor(context, url, null);
        if (path === '/content/preview' && post) return await preview(request, context);
        const imageMatch = IMAGE_ROUTE.exec(path);
        if (imageMatch && !post) return await postFile(request, imageMatch[1] as string, imageMatch[2] as string);
        const match = POST_ROUTE.exec(path);
        const slug = match?.[1];
        if (!match || !slug || !slugOk(slug)) {
          return context.page('Not found', '/content', emptyState('There is no page at this address.', html`<a class="btn" href="/content">All posts</a>`), undefined, 404, { crumbs: [{ label: 'Content', href: '/content' }] });
        }
        if (!post) return match[2] ? context.redirect(`/content/${slug}`) : await editor(context, url, slug);
        switch (match[2]) {
          case undefined:
            return await save(request, context, slug);
          case 'images':
            return await upload(request, context, slug);
          case 'images/remove':
            return await removeImage(request, context, slug);
          case 'rename':
            return await rename(request, context, slug);
          case 'discard':
            return await discard(request, context, slug);
          case 'publish':
            return await publish(request, context, slug);
          default:
            return await unschedule(request, context, slug);
        }
      } catch (error) {
        if (error instanceof SlotlockCmsError) {
          console.error('slotlock-admin-cms', error.status, error.message);
          return context.page('GitHub did not answer', '/content', emptyState('The console could not read the blog from GitHub just now. Nothing was changed.', html`<a class="btn" href="/content">Try again</a>`), undefined, 502, { crumbs: [{ label: 'Content', href: '/content' }] });
        }
        throw error;
      }
    },
  };
}

/**
 * The editor's script. The live preview: after a pause in typing, the form goes to /content/preview,
 * and the preview and the checks come back rendered by the site's own renderer (only the blocks that
 * changed are replaced); the counters and the search result change as you type. The toolbar and its shortcuts write Markdown at the cursor. A
 * picture, GIF, video or PDF dropped on the post, pasted into it (a screenshot) or chosen from the
 * toolbar asks for its alt text, uploads to /content/<slug>/images and goes in at the cursor; the
 * Media panel inserts or deletes the post's files without leaving the page. Progressive: without
 * it, the forms save, upload and delete the same. No template literal in it, and backticks written
 * as \x60, so it sits in this one (String.raw keeps its backslashes).
 */
export const SLOTLOCK_ADMIN_EDITOR_JS = String.raw`(() => {
  const form = document.getElementById('post-form');
  if (!form) return;
  const preview = document.getElementById('preview');
  const checks = document.getElementById('checks');
  const status = document.getElementById('preview-status');
  const body = document.getElementById('f-body');
  const toolbar = document.querySelector('.md-toolbar');
  const field = (name) => form.elements.namedItem(name);
  const value = (name) => { const el = field(name); return el && 'value' in el ? el.value : ''; };
  const counters = () => {
    for (const counter of document.querySelectorAll('[data-counter]')) {
      const name = counter.getAttribute('data-counter');
      const length = value(name).length;
      const low = Number(counter.getAttribute('data-low'));
      const high = Number(counter.getAttribute('data-high'));
      counter.textContent = length + ' / ' + low + ' to ' + high;
      counter.classList.toggle('off', length < low || length > high);
    }
    const set = (key, text) => { const el = document.querySelector('[data-serp="' + key + '"]'); if (el) el.textContent = text; };
    set('title', value('seoTitle') || value('title') || 'The title');
    set('description', value('description') || 'The description.');
    set('og-title', value('title') || 'The title');
    set('eyebrow', value('eyebrow') || 'Blog');
  };
  /**
   * The preview's blocks that did not change stay as they are: a video keeps playing and a player's
   * frame is not loaded again while you type elsewhere. Only the run between the unchanged start and
   * the unchanged end is replaced.
   */
  const patch = (target, html) => {
    const template = document.createElement('template');
    template.innerHTML = html;
    const next = [...template.content.childNodes];
    const now = [...target.childNodes];
    const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType === 1 ? a.outerHTML === b.outerHTML : a.textContent === b.textContent);
    let start = 0;
    while (start < now.length && start < next.length && same(now[start], next[start])) start += 1;
    let endNow = now.length;
    let endNext = next.length;
    while (endNow > start && endNext > start && same(now[endNow - 1], next[endNext - 1])) { endNow -= 1; endNext -= 1; }
    const anchor = now[endNow] || null;
    for (const node of now.slice(start, endNow)) node.remove();
    for (const node of next.slice(start, endNext)) target.insertBefore(node, anchor);
  };
  let timer = 0;
  let sent = 0;
  const refresh = async () => {
    const mine = ++sent;
    const data = { csrf: value('csrf'), slug: form.dataset.slug || value('slug') };
    for (const name of ['title', 'seoTitle', 'description', 'date', 'updated', 'publishAt', 'author', 'tags', 'eyebrow', 'imageAlt', 'related', 'body']) data[name] = value(name);
    status.textContent = 'Updating the preview…';
    try {
      const response = await fetch('/content/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-slotlock-admin': '1' },
        body: JSON.stringify(data),
      });
      const answer = await response.json();
      if (mine !== sent) return;
      if (!response.ok) { status.textContent = answer.error || 'The preview could not be updated.'; return; }
      patch(preview, answer.html);
      checks.innerHTML = answer.checks;
      status.textContent = 'Preview up to date.';
    } catch {
      if (mine === sent) status.textContent = 'The preview could not be updated.';
    }
  };
  let dirty = false;
  // The post's settings sit in the inspector, joined to the form by its id: their input reaches the
  // document, not the form.
  document.addEventListener('input', (event) => {
    if (!event.target || event.target.form !== form) return;
    dirty = true;
    counters();
    clearTimeout(timer);
    timer = setTimeout(refresh, 700);
  });
  form.addEventListener('submit', () => { dirty = false; });
  window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });
  // A required setting in a tab out of sight: show its tab, so the browser can point at it.
  document.addEventListener('invalid', (event) => {
    const panel = event.target instanceof Element ? event.target.closest('.itabs-panel') : null;
    const tab = panel ? document.getElementById(panel.classList.contains('ip-seo') ? 'it-seo' : panel.classList.contains('ip-images') ? 'it-images' : 'it-post') : null;
    if (tab && !tab.checked) tab.checked = true;
  }, true);
  counters();
  if (!body || !toolbar) return;

  // ---------- Writing Markdown at the cursor ----------
  const tick = '\x60';
  const fence = tick + tick + tick;
  const say = (text) => { status.textContent = text; };
  /** Replace start..end with text, keeping the browser's undo, and select from..to within it. */
  const put = (start, end, text, from, to) => {
    body.focus();
    body.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { done = false; }
    if (!done || body.value.slice(start, start + text.length) !== text) {
      body.setRangeText(text, start, end, 'end');
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    body.setSelectionRange(start + from, start + to);
  };
  const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = (text, at) => { const found = text.indexOf('\n', at); return found < 0 ? text.length : found; };
  const wrap = (before, after, placeholder) => {
    const start = body.selectionStart, end = body.selectionEnd, text = body.value;
    if (start !== end && text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
      put(start - before.length, end + after.length, text.slice(start, end), 0, end - start);
      return;
    }
    const inner = text.slice(start, end) || placeholder;
    put(start, end, before + inner + after, before.length, before.length + inner.length);
  };
  const MARK = /^(#{1,6} |> |- |\d+\. )/;
  const lines = (make, all) => {
    const text = body.value;
    let start = body.selectionStart, end = body.selectionEnd;
    if (end > start && text[end - 1] === '\n') end -= 1;
    const from = lineStart(text, start), to = lineEnd(text, end);
    const rows = text.slice(from, to).split('\n');
    const undo = rows.every((row) => all.test(row));
    const next = rows.map((row, index) => (undo ? row.replace(all, '') : make(row.replace(MARK, ''), index))).join('\n');
    put(from, to, next, next === '' ? 0 : next.length, next.length);
  };
  const block = (text, from, to) => {
    const start = body.selectionStart, end = body.selectionEnd, value = body.value;
    const before = value.slice(0, start), after = value.slice(end);
    const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    put(start, end, lead + text + trail, lead.length + (from === undefined ? text.length : from), lead.length + (to === undefined ? text.length : to));
  };
  const selected = () => body.value.slice(body.selectionStart, body.selectionEnd);
  const actions = {
    h2: () => lines((row) => '## ' + row, /^## /),
    h3: () => lines((row) => '### ' + row, /^### /),
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('*', '*', 'italic text'),
    link: () => {
      const text = selected();
      if (/^https:\/\/\S+$/.test(text)) { put(body.selectionStart, body.selectionEnd, '[link text](' + text + ')', 1, 10); return; }
      const label = text || 'link text';
      put(body.selectionStart, body.selectionEnd, '[' + label + '](https://)', label.length + 3, label.length + 11);
    },
    ul: () => lines((row) => '- ' + row, /^- /),
    ol: () => lines((row, index) => (index + 1) + '. ' + row, /^\d+\. /),
    quote: () => lines((row) => '> ' + row, /^> /),
    code: () => {
      const text = selected();
      if (text && !text.includes('\n')) { wrap(tick, tick, 'code'); return; }
      const inner = text || 'code';
      block(fence + '\n' + inner + '\n' + fence, fence.length + 1, fence.length + 1 + inner.length);
    },
    inlineCode: () => {
      const text = selected();
      if (!text || text.includes('\n')) { actions.code(); return; }
      wrap(tick, tick, 'code');
    },
    table: () => block('| Column | Column |\n| --- | --- |\n| Cell | Cell |', 2, 8),
    divider: () => block('---'),
    upload: () => chooser.click(),
    embed: () => askEmbed(),
  };

  // ---------- The toolbar: buttons, arrow keys between them, and shortcuts ----------
  toolbar.hidden = false;
  const tools = [...toolbar.querySelectorAll('.md-tool')];
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (mac) for (const tool of tools) tool.title = tool.title.replace('Ctrl+', '⌘').replace('Alt+', '⌥');
  toolbar.addEventListener('click', (event) => {
    const tool = event.target instanceof Element ? event.target.closest('.md-tool') : null;
    if (tool && actions[tool.dataset.md]) actions[tool.dataset.md]();
  });
  toolbar.addEventListener('keydown', (event) => {
    const at = tools.indexOf(document.activeElement);
    if (at < 0) return;
    const next = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tools.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    tools[at].tabIndex = -1;
    const target = tools[(next + tools.length) % tools.length];
    target.tabIndex = 0;
    target.focus();
  });
  const SHORTCUTS = { KeyB: 'bold', KeyI: 'italic', KeyK: 'link', KeyE: 'inlineCode', 'Alt+Digit2': 'h2', 'Alt+Digit3': 'h3', 'Shift+Digit8': 'ul', 'Shift+Digit7': 'ol', 'Shift+Period': 'quote', 'Alt+KeyT': 'table', 'Alt+Minus': 'divider', 'Alt+KeyU': 'upload', 'Alt+KeyV': 'embed' };
  body.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const name = SHORTCUTS[(event.altKey ? 'Alt+' : '') + (event.shiftKey ? 'Shift+' : '') + event.code];
    if (!name) return;
    // Before admin.js's ⌘K, which finds an account: in the post, it makes a link.
    event.preventDefault();
    event.stopPropagation();
    actions[name]();
  });

  // ---------- Files: uploaded, then written in at the cursor ----------
  const upload = toolbar.dataset.upload || '';
  const limits = JSON.parse(toolbar.dataset.limits || '{}');
  const chooser = document.getElementById('md-file');
  const box = body.closest('.md-box');
  const mediaList = document.getElementById('media-list');
  const fileDialog = document.getElementById('file-dialog');
  const embedDialog = document.getElementById('embed-dialog');
  const extension = (file) => {
    const byType = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' }[file.type];
    const named = /\.([a-z0-9]+)$/i.exec(file.name || '');
    return byType || (named ? named[1].toLowerCase() : '');
  };
  const kindOf = (ext) => (ext === 'mp4' || ext === 'webm' ? 'video' : ext === 'pdf' ? 'file' : 'image');
  const megabytes = (bytes) => (Math.round(bytes / 100000) / 10) + ' MB';
  const stem = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-');
  // A screenshot from the clipboard is image.png: its alt text names it instead.
  const generic = (name) => !name || /^(image|blob|clipboard|pasted|screenshot|screen ?shot|unnamed|untitled)\b/i.test(name);
  const clean = (text, quote) => text.replace(/[\r\n]+/g, ' ').replace(quote ? /"/g : /[\[\]]/g, '').trim();
  const markdownOf = (kind, src, alt, caption) => kind === 'file'
    ? '[' + clean(alt) + '](' + src + ')'
    : '![' + clean(alt) + '](' + src + (caption ? ' "' + clean(caption, true) + '"' : '') + ')';
  const writeIn = (kind, markdown, range) => {
    body.setSelectionRange(range[0], range[1]);
    if (kind === 'file') put(range[0], range[1], markdown, markdown.length, markdown.length);
    else block(markdown);
  };

  /** Ask for a file's alt text and caption; null when cancelled. */
  const askFile = (title, name, preview, button, kind) => new Promise((resolve) => {
    document.getElementById('file-dialog-title').textContent = title;
    document.getElementById('file-dialog-name').textContent = name;
    document.getElementById('file-dialog-ok').textContent = button;
    const image = document.getElementById('file-dialog-img');
    image.hidden = !preview;
    if (preview) image.src = preview; else image.removeAttribute('src');
    const alt = document.getElementById('fd-alt');
    const caption = document.getElementById('fd-caption');
    alt.previousElementSibling.firstChild.textContent = kind === 'file' ? 'Link text' : 'Alt text';
    caption.closest('.field').hidden = kind === 'file';
    alt.value = kind === 'file' ? name.replace(/\.pdf$/, '').replace(/-/g, ' ') + ' (PDF)' : '';
    caption.value = '';
    fileDialog.returnValue = '';
    fileDialog.addEventListener('close', () => resolve(fileDialog.returnValue === 'ok' && alt.value.trim() ? { alt: alt.value.trim(), caption: caption.value.trim() } : null), { once: true });
    fileDialog.showModal();
    alt.focus();
  });
  const readPreview = (file) => new Promise((resolve) => {
    if (!/^image\//.test(file.type) || file.size > 5000000) { resolve(''); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
  const send = (data, name) => new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', upload);
    request.setRequestHeader('x-slotlock-admin', '1');
    request.setRequestHeader('accept', 'application/json');
    request.responseType = 'json';
    request.upload.onprogress = (event) => { if (event.lengthComputable) say('Uploading ' + name + ': ' + Math.round((event.loaded / event.total) * 100) + '%'); };
    request.onload = () => resolve(request.response && typeof request.response === 'object' ? request.response : { error: 'The upload did not finish. Try again.' });
    request.onerror = () => resolve({ error: 'The upload did not reach the console. Check the connection and try again.' });
    request.send(data);
  });
  const updated = (answer) => {
    if (answer.head) { const head = field('head'); if (head) head.value = answer.head; }
    if (typeof answer.media === 'string' && mediaList) { mediaList.innerHTML = answer.media; enhanceMedia(); }
  };
  let queue = Promise.resolve();
  const addFiles = (files) => {
    for (const file of files) queue = queue.then(() => addFile(file));
    return queue;
  };
  async function addFile(file) {
    if (!upload) { say('Save the post first, then add its pictures and videos.'); return; }
    const ext = extension(file);
    const max = limits[ext];
    if (!max) { say((file.name || 'That file') + ' is not a picture, GIF, video or PDF the post can carry.'); return; }
    if (file.size > max) { say((file.name || 'That file') + ' is ' + megabytes(file.size) + ': over the ' + megabytes(max) + ' it may be.'); return; }
    const kind = kindOf(ext);
    const range = [body.selectionStart, body.selectionEnd];
    const title = kind === 'video' ? 'Add a video' : kind === 'file' ? 'Add a PDF' : ext === 'gif' ? 'Add a GIF' : 'Add a picture';
    const answer = await askFile(title, file.name || 'pasted.' + ext, await readPreview(file), 'Upload', kind);
    if (!answer) { body.focus(); return; }
    const data = new FormData();
    data.set('csrf', value('csrf'));
    data.set('name', generic(file.name) ? stem(answer.alt) : '');
    data.set('image', file, file.name || 'pasted.' + ext);
    say('Uploading ' + (file.name || 'the file') + '…');
    const result = await send(data, file.name || 'the file');
    if (result.error) { say(result.error); body.focus(); return; }
    updated(result);
    writeIn(result.kind || kind, markdownOf(result.kind || kind, result.src, answer.alt, answer.caption), range);
    say(result.name + ' uploaded and added to the post.');
  }
  chooser.addEventListener('change', () => { const files = [...chooser.files]; chooser.value = ''; addFiles(files); });
  body.addEventListener('paste', (event) => {
    const files = [...((event.clipboardData && event.clipboardData.files) || [])];
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });
  const carriesFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  body.addEventListener('dragover', (event) => { if (!carriesFiles(event)) return; event.preventDefault(); box.classList.add('dropping'); });
  body.addEventListener('dragleave', () => box.classList.remove('dropping'));
  body.addEventListener('drop', (event) => {
    box.classList.remove('dropping');
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  });
  const uploadForm = document.getElementById('media-upload');
  if (uploadForm) {
    uploadForm.addEventListener('submit', (event) => {
      const input = uploadForm.elements.namedItem('image');
      if (!input || !input.files || !input.files.length) return;
      event.preventDefault();
      const files = [...input.files];
      input.value = '';
      addFiles(files);
    });
  }

  // ---------- A video from YouTube or Vimeo ----------
  const embeddable = (address) => /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/|embed\/|live\/)|youtu\.be\/|(?:www\.)?vimeo\.com\/\d|player\.vimeo\.com\/video\/\d|(?:www\.)?youtube-nocookie\.com\/embed\/)/.test(address);
  function askEmbed() {
    const range = [body.selectionStart, body.selectionEnd];
    const address = document.getElementById('ed-url');
    const title = document.getElementById('ed-title');
    const caption = document.getElementById('ed-caption');
    const problem = document.getElementById('embed-dialog-problem');
    address.value = /^https:\/\/\S+$/.test(selected()) ? selected() : '';
    title.value = '';
    caption.value = '';
    problem.textContent = '';
    embedDialog.returnValue = '';
    embedDialog.showModal();
    (address.value ? title : address).focus();
    embedDialog.addEventListener('close', () => {
      if (embedDialog.returnValue !== 'ok') { body.focus(); return; }
      writeIn('embed', '![' + clean(title.value) + '](' + address.value.trim() + (caption.value.trim() ? ' "' + clean(caption.value, true) + '"' : '') + ')', range);
    }, { once: true });
  }
  embedDialog.querySelector('form').addEventListener('submit', (event) => {
    const address = document.getElementById('ed-url').value.trim();
    if (event.submitter && event.submitter.value === 'ok' && !embeddable(address)) {
      event.preventDefault();
      document.getElementById('embed-dialog-problem').textContent = 'That is not a YouTube or Vimeo video address.';
    }
  });

  // ---------- The Media panel: insert a file, or delete it ----------
  function enhanceMedia() {
    if (!mediaList) return;
    for (const code of mediaList.querySelectorAll('.media-md')) code.hidden = true;
    for (const button of mediaList.querySelectorAll('[data-insert]')) button.hidden = false;
  }
  if (mediaList) {
    enhanceMedia();
    mediaList.addEventListener('click', async (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-insert]') : null;
      if (!button) return;
      const src = button.dataset.insert;
      const kind = button.dataset.kind;
      const name = src.slice(src.lastIndexOf('/') + 1);
      const range = [body.selectionStart, body.selectionEnd];
      const thumb = button.closest('.media-item').querySelector('img');
      const answer = await askFile(kind === 'video' ? 'Insert a video' : kind === 'file' ? 'Link a PDF' : 'Insert a picture', name, thumb ? thumb.src : '', 'Insert', kind);
      if (!answer) return;
      writeIn(kind, markdownOf(kind, src, answer.alt, answer.caption), range);
    });
    mediaList.addEventListener('submit', async (event) => {
      const remove = event.target instanceof HTMLFormElement && event.target.classList.contains('media-remove') ? event.target : null;
      if (!remove) return;
      event.preventDefault();
      const name = remove.dataset.name;
      if (body.value.includes('/' + name + ')') || body.value.includes('/' + name + ' "')) {
        if (!window.confirm('The post still shows ' + name + '. Delete it from the post’s files anyway?')) return;
      } else if (!window.confirm('Delete ' + name + ' from the post’s files?')) return;
      say('Deleting ' + name + '…');
      try {
        const response = await fetch(remove.action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slotlock-admin': '1', accept: 'application/json' },
          body: new URLSearchParams(new FormData(remove)).toString(),
        });
        const answer = await response.json();
        if (!response.ok) { say(answer.error || 'Not deleted.'); return; }
        updated(answer);
        say(name + ' deleted.');
        clearTimeout(timer);
        timer = setTimeout(refresh, 100);
      } catch {
        say('Not deleted: the console did not answer.');
      }
    });
  }
})();
`;

/** The editor's own styles, beside admin.css: the toolbar, the Media panel, the dialogs, and the preview's media. */
export const SLOTLOCK_ADMIN_EDITOR_CSS = `.md-box{display:grid;grid-template-columns:minmax(0,1fr)}
.md-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:1px;padding:4px;border:1px solid var(--line);border-bottom:0;border-radius:var(--r-ctl) var(--r-ctl) 0 0;background:var(--fill)}
.md-toolbar[hidden]{display:none}
.md-toolbar:not([hidden])+textarea{border-top-left-radius:0;border-top-right-radius:0}
.md-tool{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:28px;padding:0 4px;border:0;border-radius:var(--r-chip);background:none;color:var(--ink-2);font:600 12px/1 var(--font);cursor:pointer}
.md-tool:hover{background:var(--fill-2);color:var(--ink)}
.md-tool:focus-visible{outline:2px solid var(--accent);outline-offset:0}
.md-tool.md-italic{font-style:italic;font-family:Georgia,serif;font-size:14px}
.md-tool.md-bold{font-weight:800;font-size:13px}
.md-sep{width:1px;height:16px;margin:0 3px;background:var(--line)}
.md-box>.md-toolbar{grid-area:1/1/2/2}
.md-box>textarea,.md-box>.md-drop{grid-area:2/1/3/2}
.md-drop{display:none;z-index:1;margin:0;place-items:center;border:2px dashed var(--accent);border-radius:0 0 var(--r-ctl) var(--r-ctl);background:var(--accent-tint);color:var(--ink);font-weight:600;pointer-events:none}
.md-box.dropping .md-drop{display:grid}
.list.media-list{display:grid;gap:0}
.list.media-list>.media-item{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:52px;padding:6px 0;border-bottom:1px solid var(--line-2)}
.list.media-list>.media-item:last-child{border-bottom:0}
.media-thumb{display:grid;place-items:center;width:40px;height:40px;border-radius:var(--r-chip);background:var(--fill-2);color:var(--ink-2);overflow:hidden}
.media-thumb img{width:40px;height:40px;object-fit:cover}
.media-text{display:grid;min-width:0}
.media-name{font:500 12.5px/18px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.media-md{grid-column:1/-1;margin-top:4px;font-size:11px;overflow-wrap:anywhere;white-space:normal}
.media-md[hidden]{display:none}
.media-actions{display:flex;align-items:center;gap:4px}
.media-actions form{display:contents}
.media-actions [hidden]{display:none}
.md-dialog{width:min(440px,calc(100vw - 32px));padding:20px;border:0;border-radius:var(--r-card);background:var(--raised);color:var(--ink);box-shadow:var(--pop-shadow)}
.md-dialog::backdrop{background:rgba(0,0,0,.42)}
.md-dialog h2{font-size:15px;line-height:22px;font-weight:600}
.md-dialog .field[hidden]{display:none}
.md-dialog-file{display:flex;align-items:center;gap:12px;min-width:0;font-size:12px;color:var(--ink-2)}
.md-dialog-file img{max-width:120px;max-height:80px;border-radius:var(--r-chip);object-fit:contain;background:var(--fill-2)}
.md-dialog-file span{overflow-wrap:anywhere}
.article video{display:block;width:100%;height:auto;border-radius:10px;background:#000}
.article .embed iframe{display:block;width:100%;height:auto;aspect-ratio:16/9;border:0;border-radius:10px;background:#000}
.article figure>figcaption{margin-top:6px;font-size:13px;line-height:1.5;color:var(--ink-2)}
.article hr{height:0;margin:2em 0;border:0;border-top:1px solid var(--line)}
.article .table-scroll{max-width:100%;margin:0 0 1.2em;overflow-x:auto}
.article .table-scroll table{margin:0}
.article .table-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;
