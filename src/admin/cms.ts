// The admin console's CMS (RFC 0006, M8 and 4.5): blog posts stay files in the repository, and the
// console writes them through the "Slotlock CMS" GitHub App (github-app.ts).
//
//   Write (Owner, Editor): the editor saves a post to cms/<slug>, authored and signed off as the
//     staff member, and opens a pull request the site's checks run on. Saving keeps it a draft;
//     submitting, which needs every check below to pass, marks it ready (status: published in the
//     file, so merging it publishes it). Images go beside it in site/public/blog/<slug>/.
//   Publish (Owner only, E5): merges the pull request at the commit the Owner saw, once its checks
//     on GitHub pass and it changes nothing but blog files. A post with a later publish date is
//     scheduled instead: a label, and a comment from the App naming the commit, which the hourly
//     CMS workflow (scripts/cms-scheduled-merge.mjs) merges when the date comes.
//
// The preview and the checks are the site's own (site/src/lib/post-format.ts), so the preview is
// the page. Every step is recorded in the staff log before GitHub is asked, and the database checks
// the role again as it records it.
import {
  POST_SLUG,
  type ParsedPost,
  type PostAuthor,
  type PostCheck,
  type PostFront,
  PostFormatError,
  checkPost,
  parsePost,
  postImagePath,
  renderPostBody,
  serializePost,
} from '../../site/src/lib/post-format.js';
import type { SlotlockContentStep, SlotlockStaffRole } from '../staff-ddl.js';
import { slotlockStaffMay } from '../staff-ddl.js';
import {
  type SlotlockCmsChange,
  type SlotlockCmsChecks,
  type SlotlockCmsFile,
  type SlotlockCmsGitHub,
  type SlotlockCmsPullRequest,
  SlotlockCmsError,
  slotlockSignOff,
} from './github-app.js';
import { Html, day, html, pageHead, pill, table, when } from './ui.js';

export type { SlotlockCmsChange } from './github-app.js';

export const SLOTLOCK_CMS_POSTS = 'site/content/blog';
export const SLOTLOCK_CMS_IMAGES = 'site/public/blog';
export const SLOTLOCK_CMS_AUTHORS = 'site/src/data/authors.json';
export const SLOTLOCK_CMS_REDIRECTS = 'site/public/_redirects';
/** The label on a scheduled post's pull request; the comment beside it names the commit. */
export const SLOTLOCK_CMS_SCHEDULED_LABEL = 'cms:scheduled';
/** The largest image the console takes: GitHub's contents API reads files up to 1 MB. */
export const SLOTLOCK_CMS_IMAGE_MAX = 1_000_000;
const IMAGES_PER_POST = 20;
/** Slugs the console's own routes use. */
const RESERVED_SLUGS = new Set(['new', 'preview']);
const IMAGE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp)$/;
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
    /^site\/public\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp)$/.test(path) ||
    path === SLOTLOCK_CMS_REDIRECTS
  );
}

const CHANGE_POST = /^site\/content\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\.md$/;
const CHANGE_IMAGE = /^site\/public\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp)$/;
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

/** An image's type from its first bytes, never from its name or the browser's word. */
export function slotlockImageType(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

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

const NOTICES: Readonly<Record<string, Notice>> = Object.freeze({
  saved: { kind: 'done', text: 'Saved as a draft on its pull request. The site’s checks are running on it.' },
  submitted: { kind: 'done', text: 'Submitted. An Owner can publish it once the checks on GitHub pass.' },
  image_added: { kind: 'done', text: 'Image added. Put it in the post with the Markdown beside it.' },
  image_removed: { kind: 'done', text: 'Image removed.' },
  renamed: { kind: 'done', text: 'Renamed on a new pull request, with redirects from the old address. Publish it to make the change live.' },
  discarded: { kind: 'done', text: 'Draft discarded: its pull request is closed and its branch deleted.' },
  published: { kind: 'done', text: 'Published. The site deploys in a few minutes.' },
  scheduled: { kind: 'done', text: 'Scheduled. The hourly workflow publishes it when its date comes.' },
  unscheduled: { kind: 'done', text: 'Unscheduled. It waits for an Owner to publish it.' },
  invalid: { kind: 'warn', text: 'Check the form: a field was missing or not valid.' },
  image_invalid: { kind: 'warn', text: 'An image is a PNG, JPEG or WebP file of up to 1 MB, named in lowercase words and hyphens, at most 20 a post.' },
  save_first: { kind: 'warn', text: 'Save the post first, then add its images.' },
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
  page(title: string, path: string, body: Html, notice?: Notice, status?: number): Response;
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

/** What a post's page needs besides the post: who writes, what else is published, its images. */
interface PostContext {
  authors: Record<string, PostAuthor>;
  descriptions: Record<string, string>;
  images: string[];
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
    const [images, schedule, changes] = await Promise.all([
      github.listDirectory(`${SLOTLOCK_CMS_IMAGES}/${slug}`, ref),
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
    const context: PostContext = { authors: parseAuthors(snap.files[1] ?? null), descriptions, images: images.filter((name) => IMAGE_FILE.test(name)) };
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
      return { authors: parseAuthors(main.files[0] ?? null), descriptions, images: [] };
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
      imageFiles: new Set(context.images),
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
    return context.page('Content', path, html`
      ${pageHead('Content', 'Posts', 'Write, review and publish the blog.')}
      <div class="empty"><p>The CMS is not connected. Install the Slotlock CMS GitHub App on the site's repository, then set <code>SLOTLOCK_ADMIN_CMS_APP_ID</code>, <code>SLOTLOCK_ADMIN_CMS_INSTALLATION</code> and the secret <code>SLOTLOCK_ADMIN_CMS_APP_KEY</code> on the console's Worker (RFC 0006, Phase 0).</p></div>`);
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
    const code = url.searchParams.get('done') ?? url.searchParams.get('error');
    const body = html`
      ${pageHead('Content', 'Posts', 'Write, review and publish the blog. Each post is a file in the repository; a draft is a pull request the site’s checks run on.', html`<a class="btn primary" href="/content/new">New post</a>`)}
      ${table('Posts', ['Post', 'Status', 'Author', 'Date', 'Pull request'], ordered.map((row) => [
        html`<a href="/content/${row.slug}">${row.post?.front.title ?? row.slug}</a><span class="sub mono">/blog/${row.slug}/</span>`,
        html`${statusPill(row)}${row.schedule && row.pull?.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? html`<span class="sub">${row.schedule.at.replace('T', ' ').replace('Z', ' UTC')}</span>` : ''}`,
        html`${row.post?.front.author ?? '–'}`,
        html`${row.post ? day(row.post.front.date) : '–'}`,
        row.pull ? html`<a href="${row.pull.url}" rel="noreferrer">#${row.pull.number}</a> ${checksPill(row.checks)}` : html`–`,
      ]), 'No posts yet.')}`;
    return context.page('Content', '/content', body, code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined);
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
    const text = (name: keyof Fields, label: string, hint: string | Html = '', type = 'text', extra: Html | string = '') => html`
      <label for="f-${name}">${label} ${hint ? html`<span class="hint">${hint}</span>` : ''}</label>
      <input id="f-${name}" name="${name}" type="${type}" value="${fields[name]}" maxlength="${String(FIELD_LIMITS[name])}" ${extra}>`;
    const imageRows = input.postContext.images.map((name) => html`<li>
        <code>${`![Describe the image](${postImagePath(slug ?? '')}${name})`}</code>
        <form method="post" action="/content/${slug ?? ''}/images/remove"><input type="hidden" name="csrf" value="${context.csrf}"><input type="hidden" name="name" value="${name}"><button class="link" type="submit">Remove</button></form>
      </li>`);
    const body = html`
      ${pageHead('Content', state?.post?.front.title || (slug ? slug : 'New post'), slug ? html`${state ? statusPill(state) : ''} <span class="sub-inline mono">/blog/${slug}/</span>` : 'A post is a file in the repository. Saving it opens a pull request the site’s checks run on.',
        html`<a class="btn" href="/content">All posts</a>`)}
      ${input.problem ? html`<p class="notice warn" role="alert">${input.problem}</p>` : ''}
      <div class="cms">
        <form id="post-form" class="form cms-main" method="post" action="${action}" data-slug="${slug ?? ''}">
          <input type="hidden" name="csrf" value="${context.csrf}">
          <input type="hidden" name="head" value="${state?.branchHead ?? ''}">
          ${slug ? html`<input type="hidden" name="slug" value="${slug}">` : text('slug', 'Address', html`/blog/<em>this</em>/: lowercase words and hyphens`, 'text', html`required pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false"`)}
          <label for="f-title">Title ${counter('title', fields.title, 20, 65)}</label>
          <input id="f-title" name="title" type="text" value="${fields.title}" maxlength="200" required>
          ${text('seoTitle', 'Search title', 'when the title is over 65 characters')}
          <label for="f-description">Description ${counter('description', fields.description, 70, 160)}</label>
          <textarea id="f-description" name="description" rows="3" maxlength="400" required>${fields.description}</textarea>
          <div class="cms-row">
            <div>${text('date', 'Date', '', 'date', 'required')}</div>
            <div>${text('updated', 'Updated', '', 'date')}</div>
            <div>${text('publishAt', 'Publish at', 'UTC, optional', 'datetime-local')}</div>
          </div>
          <div class="cms-row">
            <div>
              <label for="f-author">Author</label>
              <select id="f-author" name="author" required>
                <option value="">Choose</option>
                ${Object.entries(authors).map(([key, author]) => html`<option value="${key}" ${fields.author === key ? new Html('selected') : ''}>${author.name}</option>`)}
              </select>
            </div>
            <div>${text('tags', 'Tags', 'comma between, 1 to 5')}</div>
            <div>${text('eyebrow', 'Eyebrow', 'e.g. Case study')}</div>
          </div>
          ${text('imageAlt', 'Link preview alt text', 'what the drawn preview image says')}
          <label for="f-related">Related pages <span class="hint">1 to 4, each "Label | /path" on its own line</span></label>
          <textarea id="f-related" name="related" rows="3" maxlength="2000">${fields.related}</textarea>
          <label for="f-body">Post <span class="hint">Markdown: ## headings, lists, &gt; quotes, tables, \`\`\` code, ![alt](/blog/…/image.png), {{facts.name}}</span></label>
          <textarea id="f-body" class="mono cms-body" name="body" rows="26" maxlength="100000" spellcheck="true">${fields.body}</textarea>
          <div class="cms-actions">
            <button class="btn" type="submit" name="intent" value="save">Save draft</button>
            <button class="btn primary" type="submit" name="intent" value="submit">Submit for review</button>
            <span class="fine" id="preview-status" role="status"></span>
          </div>
        </form>
        <aside class="cms-rail" aria-label="Post">
          ${slug && state ? html`<section class="panel">
            <h2 class="rail-title">Status</h2>
            <dl>
              <div><dt>Status</dt><dd>${statusPill(state)}${state.schedule && pull?.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL) ? html`<span class="sub">For ${state.schedule.at.replace('T', ' ').replace('Z', ' UTC')}</span>` : ''}</dd></div>
              ${pull ? html`<div><dt>Pull request</dt><dd><a href="${pull.url}" rel="noreferrer">#${pull.number}</a> ${checksPill(state.checks)}</dd></div>` : ''}
              ${pull && previewUrl(pull, slug) ? html`<div><dt>Preview deploy</dt><dd><a href="${previewUrl(pull, slug) ?? ''}" rel="noreferrer">The whole site, with this post</a></dd></div>` : ''}
              ${state.onMain && isLive(state.onMain, now()) ? html`<div><dt>Live</dt><dd><a href="${site}/blog/${slug}/" rel="noreferrer">${site.replace('https://', '')}/blog/${slug}/</a></dd></div>` : ''}
            </dl>
            ${pull && canPublish ? publishPanel(context, state) : ''}
          </section>` : ''}
          <section class="panel">
            <h2 class="rail-title">Checks</h2>
            <ul class="checks" id="checks">${checksList(evaluation?.checks ?? null)}</ul>
            <p class="fine">The site’s own rules. Submitting needs every one to pass; GitHub runs the site’s build on the pull request too.</p>
          </section>
          <section class="panel">
            <h2 class="rail-title">In search results</h2>
            <div class="serp" id="serp">
              <span class="serp-url">${site.replace('https://', '')} › blog › ${slug ?? fields.slug}</span>
              <span class="serp-title" data-serp="title">${searchTitle || 'The title'}</span>
              <span class="serp-text" data-serp="description">${fields.description || 'The description.'}</span>
            </div>
          </section>
          <section class="panel">
            <h2 class="rail-title">Link preview</h2>
            <div class="og" aria-hidden="true"><span class="og-eyebrow" data-serp="eyebrow">${fields.eyebrow || 'Blog'}</span><span class="og-title" data-serp="og-title">${fields.title || 'The title'}</span><span class="og-site">slotlock.pylota.io</span></div>
            <p class="fine">Drawn by the site’s build from the title when the post is first built.</p>
          </section>
          ${slug && state ? html`<section class="panel" id="images">
            <h2 class="rail-title">Images</h2>
            ${imageRows.length ? html`<ul class="list images">${imageRows}</ul>` : html`<p class="fine">No images yet.</p>`}
            ${state.branchHead || state.onMain ? html`<form class="form" method="post" action="/content/${slug}/images" enctype="multipart/form-data">
              <input type="hidden" name="csrf" value="${context.csrf}">
              <label for="f-image">Add an image <span class="hint">PNG, JPEG or WebP, up to 1 MB</span></label>
              <input id="f-image" name="image" type="file" accept="image/png,image/jpeg,image/webp" required>
              <label for="f-image-name">File name <span class="hint">optional, lowercase words and hyphens</span></label>
              <input id="f-image-name" name="name" type="text" maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off">
              <button class="btn" type="submit">Upload</button>
            </form>` : html`<p class="fine">Save the post first, then add its images.</p>`}
          </section>
          ${dangerPanel(context, state)}` : ''}
        </aside>
      </div>
      <section class="cms-preview" aria-labelledby="preview-title">
        <h2 id="preview-title">Preview</h2>
        <article class="article" id="preview">${new Html(evaluation?.html ?? '')}</article>
      </section>`;
    return context.page(state?.post?.front.title || 'New post', '/content', body, input.notice, input.status ?? 200);
  }

  function checksList(checks: PostCheck[] | null): Html {
    if (!checks) return html`<li class="fine">Shown once the post has a title and a body.</li>`;
    return html`${checks.map((check) => html`<li class="${check.ok ? 'ok' : 'bad'}"><span class="mark" aria-hidden="true">${check.ok ? '✓' : '✗'}</span><span><strong>${check.name}</strong><span class="sr-only">${check.ok ? ': passes.' : ': fails.'}</span> <span class="sub">${check.detail}</span></span></li>`)}`;
  }

  function publishPanel(context: SlotlockCmsRequest, state: PostState): Html {
    const pull = state.pull as SlotlockCmsPullRequest;
    const scheduled = pull.labels.includes(SLOTLOCK_CMS_SCHEDULED_LABEL);
    const later = state.post?.front.publishAt && Date.parse(state.post.front.publishAt) > now();
    return html`<form class="form publish" method="post" action="/content/${state.slug}/publish">
        <input type="hidden" name="csrf" value="${context.csrf}">
        <input type="hidden" name="sha" value="${pull.headSha}">
        <p class="fine">Merges commit <code>${pull.headSha.slice(0, 7)}</code> into main${later ? ', or schedules it for its publish time' : ''}. It needs the checks to pass and a passkey in the last 15 minutes.</p>
        <button class="btn primary" type="submit">${later ? 'Schedule' : 'Publish'}</button>
      </form>
      ${scheduled ? html`<form method="post" action="/content/${state.slug}/unschedule"><input type="hidden" name="csrf" value="${context.csrf}"><button class="link" type="submit">Unschedule</button></form>` : ''}`;
  }

  function dangerPanel(context: SlotlockCmsRequest, state: PostState): Html {
    const renameable = state.onMain && isLive(state.onMain, now()) && !state.branchHead;
    if (!renameable && !state.branchHead) return html``;
    return html`<section class="panel">
      <h2 class="rail-title">${renameable ? 'Address' : 'Draft'}</h2>
      ${renameable ? html`<form class="form" method="post" action="/content/${state.slug}/rename">
        <input type="hidden" name="csrf" value="${context.csrf}">
        <label for="f-rename">New address <span class="hint">/blog/<em>this</em>/</span></label>
        <input id="f-rename" name="to" type="text" required maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false">
        <p class="fine">Opens a pull request that moves the post and its images, and redirects the old address.</p>
        <button class="btn" type="submit">Rename</button>
      </form>` : ''}
      ${state.branchHead ? html`<form class="form" method="post" action="/content/${state.slug}/discard">
        <input type="hidden" name="csrf" value="${context.csrf}">
        <p class="fine">Closes the pull request and deletes the branch. ${state.onMain ? 'The published post stays as it is.' : 'The post was never published, so it goes.'}</p>
        <button class="btn danger" type="submit">Discard draft</button>
      </form>` : ''}
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

  async function upload(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return back(context, `/content/${slug}`, 'image_invalid', false);
    const length = Number(request.headers.get('content-length') ?? 'NaN');
    if (!Number.isFinite(length) || length > SLOTLOCK_CMS_IMAGE_MAX + 64 * 1024) return back(context, `/content/${slug}`, 'image_invalid', false);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return back(context, `/content/${slug}`, 'image_invalid', false);
    }
    const token = form.get('csrf');
    if (!context.csrfOk(typeof token === 'string' ? token : '')) return context.redirect('/content?error=invalid');
    const file = form.get('image');
    if (!file || typeof file === 'string' || file.size === 0 || file.size > SLOTLOCK_CMS_IMAGE_MAX) return back(context, `/content/${slug}`, 'image_invalid', false);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = slotlockImageType(bytes);
    const asked = String(form.get('name') ?? '').trim();
    const stem = (asked || file.name.replace(/\.[A-Za-z0-9]+$/, ''))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    const name = `${stem}.${type ?? 'png'}`;
    if (!type || !IMAGE_FILE.test(name)) return back(context, `/content/${slug}`, 'image_invalid', false);
    const state = await postState(slug);
    if (!state.post) return back(context, `/content/${slug}`, 'save_first', false);
    if (state.context.images.length >= IMAGES_PER_POST && !state.context.images.includes(name)) return back(context, `/content/${slug}`, 'image_invalid', false);
    await context.record('content.image_added', slug, { image: name, bytes: bytes.length });
    try {
      await commitAndOpen(context, state, [{ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, content: bytes }], `Blog: add the image ${name} to "${state.post.front.title}"`);
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    return context.redirect(`/content/${slug}?done=image_added#images`);
  }

  /** Commit to the post's branch, opening its pull request when it has none. */
  async function commitAndOpen(context: SlotlockCmsRequest, state: PostState, files: SlotlockCmsFile[], message: string): Promise<void> {
    const github = requireGithub();
    await github.commit({
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
  }

  async function removeImage(request: Request, context: SlotlockCmsRequest, slug: string): Promise<Response> {
    const form = await formOf(request, 4096);
    if (!form || !context.csrfOk(form.get('csrf') ?? '')) return context.redirect('/content?error=invalid');
    const name = form.get('name') ?? '';
    const state = await postState(slug);
    if (!IMAGE_FILE.test(name) || !state.context.images.includes(name) || !state.post) return back(context, `/content/${slug}`, 'invalid', false);
    await context.record('content.image_removed', slug, { image: name });
    try {
      await commitAndOpen(context, state, [{ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, content: null }], `Blog: remove the image ${name} from "${state.post.front.title}"`);
    } catch (error) {
      if (!githubFailed(error)) throw error;
      return back(context, `/content/${slug}`, 'github', false);
    }
    contexts.delete(slug);
    return context.redirect(`/content/${slug}?done=image_removed#images`);
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
      for (const name of state.context.images) {
        const bytes = await github.readBytes(`${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, 'main');
        if (!bytes) continue;
        files.push({ path: `${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, content: null }, { path: `${SLOTLOCK_CMS_IMAGES}/${to}/${name}`, content: bytes });
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
        body: `Renamed in the admin console by ${context.login}: the post, its images, and redirects from the old address (\`site/public/_redirects\`). An Owner publishes it from the console.`,
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
    if (!slotlockStaffMay(context.role, 'content.publish')) return context.page('Not allowed', '/content', pageHead('Content', 'Not allowed', `Your role (${context.role}) does not publish posts.`), undefined, 403);
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
    if (!slotlockStaffMay(context.role, 'content.publish')) return context.page('Not allowed', '/content', pageHead('Content', 'Not allowed', `Your role (${context.role}) does not publish posts.`), undefined, 403);
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

  async function image(context: SlotlockCmsRequest, slug: string, name: string): Promise<Response> {
    const github = requireGithub();
    const branch = await github.branchHead(branchOf(slug));
    const bytes = await github.readBytes(`${SLOTLOCK_CMS_IMAGES}/${slug}/${name}`, branch ?? 'main');
    const type = bytes ? slotlockImageType(bytes) : null;
    if (!bytes || !type) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(bytes, {
      headers: {
        'Content-Type': type === 'jpg' ? 'image/jpeg' : `image/${type}`,
        'Cache-Control': 'private, max-age=60',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      },
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
      return context.page('Not found', '/content', html`${pageHead('Content', 'Not found', 'There is no post at this address.')}<p><a class="btn" href="/content">All posts</a></p>`, undefined, 404);
    }
    if (!state.post) {
      return context.page('Content', '/content', html`${pageHead('Content', slug, 'The post’s file does not read, so the console cannot open it.')}
        <p class="notice warn">${state.broken ?? ''}</p>
        <p>Fix <code>site/content/blog/${slug}.md</code> on GitHub${state.pull ? html` (<a href="${state.pull.url}" rel="noreferrer">#${state.pull.number}</a>)` : ''}, then open it here again.</p>`, undefined, 422);
    }
    const evaluation = await evaluate(state.post, state.context);
    return editorPage(context, { state, postContext: state.context, fields: fieldsOf(state.post, slug, now()), evaluation, ...(notice ? { notice } : {}) });
  }

  const IMAGE_ROUTE = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+){0,15})\/([a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp))$/;
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
        if (imageMatch && !post) return await image(context, imageMatch[1] as string, imageMatch[2] as string);
        const match = POST_ROUTE.exec(path);
        const slug = match?.[1];
        if (!match || !slug || !slugOk(slug)) {
          return context.page('Not found', '/content', pageHead('Content', 'Not found', 'There is no page at this address.'), undefined, 404);
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
          return context.page('Content', '/content', html`${pageHead('Content', 'GitHub did not answer', 'The console could not read the blog from GitHub just now. Nothing was changed.')}<p><a class="btn" href="/content">Try again</a></p>`, undefined, 502);
        }
        throw error;
      }
    },
  };
}

/**
 * The editor's live preview: after a pause in typing, the form goes to /content/preview, and the
 * preview and the checks come back rendered by the site's own renderer. The counters and the search
 * result change as you type. Progressive: without it, saving shows the same.
 */
export const SLOTLOCK_ADMIN_EDITOR_JS = `(() => {
  const form = document.getElementById('post-form');
  if (!form) return;
  const preview = document.getElementById('preview');
  const checks = document.getElementById('checks');
  const status = document.getElementById('preview-status');
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
  let timer = 0;
  let sent = 0;
  const refresh = async () => {
    const mine = ++sent;
    const body = { csrf: value('csrf'), slug: form.dataset.slug || value('slug') };
    for (const name of ['title', 'seoTitle', 'description', 'date', 'updated', 'publishAt', 'author', 'tags', 'eyebrow', 'imageAlt', 'related', 'body']) body[name] = value(name);
    status.textContent = 'Updating the preview…';
    try {
      const response = await fetch('/content/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-slotlock-admin': '1' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (mine !== sent) return;
      if (!response.ok) { status.textContent = data.error || 'The preview could not be updated.'; return; }
      preview.innerHTML = data.html;
      checks.innerHTML = data.checks;
      status.textContent = 'Preview up to date.';
    } catch {
      if (mine === sent) status.textContent = 'The preview could not be updated.';
    }
  };
  form.addEventListener('input', () => {
    counters();
    clearTimeout(timer);
    timer = setTimeout(refresh, 700);
  });
  counters();
})();
`;
