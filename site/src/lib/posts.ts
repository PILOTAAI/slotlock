// The blog's posts, read from content/blog/<slug>.md at build time (RFC 0006, 4.5) and rendered with
// the strict renderer the admin console's editor uses (post-format.ts). A post that does not render
// cleanly (a broken link syntax, an image without alt text, an unknown fact) fails the build, and so
// does a file in public/blog/<slug>/ that is not what its bytes say, is larger than its kind may be
// (POST_FILE_KINDS), is missing though the post shows it, or belongs to no post: the console checks
// the same before it commits a file, and this catches one committed another way. Only published
// posts whose publishAt has passed are built; the newest comes first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import authorsJson from '../data/authors.json';
import facts from '../generated/facts.json';
import { POST_LINK, type ParsedPost, type PostAuthor, parsePost, postFilesProblems, renderPostBody } from './post-format';

export interface Post extends ParsedPost {
  /** The body as HTML, escaped throughout: set into the page as it is. */
  html: string;
}

export const AUTHORS = authorsJson as Record<string, PostAuthor>;
// An author's URL becomes a link on every post of theirs: it keeps to the posts' own link rule, so
// nothing but a site path or an https address reaches an href.
for (const [key, author] of Object.entries(AUTHORS)) {
  if (typeof author.url !== 'string' || !POST_LINK.test(author.url)) {
    throw new Error(`src/data/authors.json: ${key}'s url is not a /path or an https:// address`);
  }
}
const DIRECTORY = join(process.cwd(), 'content', 'blog');
/** Each post's own files: public/blog/<slug>/, served at /blog/<slug>/<name>. */
const FILES = join(process.cwd(), 'public', 'blog');

/** A post's files as the build reads them: only files, each name and its bytes. */
function filesOf(slug: string): { name: string; bytes: Uint8Array }[] {
  const folder = join(FILES, slug);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) throw new Error(`public/blog/${slug}/${entry.name}: a post's folder holds files only`);
    return { name: entry.name, bytes: new Uint8Array(readFileSync(join(folder, entry.name))) };
  });
}

function load(): Post[] {
  const now = Date.now();
  const posts: Post[] = [];
  const slugs = new Set<string>();
  for (const file of readdirSync(DIRECTORY).filter((name) => name.endsWith('.md')).sort()) {
    const slug = file.slice(0, -'.md'.length);
    slugs.add(slug);
    const parsed = parsePost(readFileSync(join(DIRECTORY, file), 'utf8'), slug);
    const rendered = renderPostBody(parsed.body, { slug, facts });
    if (rendered.problems.length) throw new Error(`content/blog/${file}: ${rendered.problems.join('; ')}`);
    const fileProblems = postFilesProblems(slug, filesOf(slug), rendered);
    if (fileProblems.length) throw new Error(`public/blog/${slug}/: ${fileProblems.join('; ')}`);
    if (!Object.hasOwn(AUTHORS, parsed.front.author)) {
      throw new Error(`content/blog/${file}: author "${parsed.front.author}" is not in src/data/authors.json`);
    }
    if (parsed.front.status !== 'published') continue;
    if (parsed.front.publishAt && Date.parse(parsed.front.publishAt) > now) continue;
    posts.push({ ...parsed, html: rendered.html });
  }
  // A folder of files with no post (one deleted, or renamed by hand) would be served all the same.
  for (const entry of existsSync(FILES) ? readdirSync(FILES, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !slugs.has(entry.name)) throw new Error(`public/blog/${entry.name}: not the folder of a post in content/blog/`);
  }
  return posts.sort((a, b) => b.front.date.localeCompare(a.front.date) || a.front.title.localeCompare(b.front.title));
}

/** Newest first. */
export const POSTS: Post[] = load();

export const postPath = (post: ParsedPost) => `/blog/${post.slug}/`;
export const authorOf = (post: ParsedPost): PostAuthor => AUTHORS[post.front.author] as PostAuthor;
