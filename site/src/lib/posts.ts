// The blog's posts, read from content/blog/<slug>.md at build time (RFC 0006, 4.5) and rendered with
// the strict renderer the admin console's editor uses (post-format.ts). A post that does not render
// cleanly (a broken link syntax, an image without alt text, an unknown fact) fails the build. Only
// published posts whose publishAt has passed are built; the newest comes first.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import authorsJson from '../data/authors.json';
import facts from '../generated/facts.json';
import { POST_LINK, type ParsedPost, type PostAuthor, parsePost, renderPostBody } from './post-format';

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

function load(): Post[] {
  const now = Date.now();
  const posts: Post[] = [];
  for (const file of readdirSync(DIRECTORY).filter((name) => name.endsWith('.md')).sort()) {
    const slug = file.slice(0, -'.md'.length);
    const parsed = parsePost(readFileSync(join(DIRECTORY, file), 'utf8'), slug);
    const rendered = renderPostBody(parsed.body, { slug, facts });
    if (rendered.problems.length) throw new Error(`content/blog/${file}: ${rendered.problems.join('; ')}`);
    if (!Object.hasOwn(AUTHORS, parsed.front.author)) {
      throw new Error(`content/blog/${file}: author "${parsed.front.author}" is not in src/data/authors.json`);
    }
    if (parsed.front.status !== 'published') continue;
    if (parsed.front.publishAt && Date.parse(parsed.front.publishAt) > now) continue;
    posts.push({ ...parsed, html: rendered.html });
  }
  return posts.sort((a, b) => b.front.date.localeCompare(a.front.date) || a.front.title.localeCompare(b.front.title));
}

/** Newest first. */
export const POSTS: Post[] = load();

export const postPath = (post: ParsedPost) => `/blog/${post.slug}/`;
export const authorOf = (post: ParsedPost): PostAuthor => AUTHORS[post.front.author] as PostAuthor;
