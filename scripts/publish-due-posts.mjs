#!/usr/bin/env node
// Finds the blog posts that should be live by now but are not, for scheduled-posts.yml. The site
// builds a post only once its publishAt has passed (site/src/lib/posts.ts), and nothing rebuilds the
// site when that time comes: a post merged ahead of its date would wait for the next unrelated
// deploy. This prints the slug of each post that is published, whose publishAt passed within the last
// two days, and whose page the live site does not serve yet, one per line; the workflow then
// rebuilds the site. A post already live, a draft, or one still to come is not printed. When the
// site cannot be reached it prints nothing and warns: the status probe reports outages, and a
// rebuild would not fix one.
//   node scripts/publish-due-posts.mjs
// SLOTLOCK_SITE_URL (default https://slotlock.pylota.io), SLOTLOCK_POSTS_DIR (default
// site/content/blog) and SLOTLOCK_NOW (an ISO time, for tests) change where and when it looks.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = (process.env.SLOTLOCK_SITE_URL ?? 'https://slotlock.pylota.io').replace(/\/+$/, '');
const directory = process.env.SLOTLOCK_POSTS_DIR ?? join(root, 'site', 'content', 'blog');
const now = process.env.SLOTLOCK_NOW ? Date.parse(process.env.SLOTLOCK_NOW) : Date.now();
/** How far back a missed publishAt still counts: a post longer gone than this needs a person. */
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLISH_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/** The frontmatter's scalar lines, as post-format.ts writes them: `key: value`. */
function front(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const values = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const pair = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (pair) values[pair[1]] = pair[2].trim();
  }
  return values;
}

const due = [];
for (const file of readdirSync(directory).filter((name) => name.endsWith('.md')).sort()) {
  const slug = file.slice(0, -'.md'.length);
  if (!SLUG.test(slug)) continue;
  const { status, publishAt } = front(readFileSync(join(directory, file), 'utf8'));
  if (status !== 'published' || !publishAt || !PUBLISH_AT.test(publishAt)) continue;
  const at = Date.parse(publishAt);
  if (at > now || now - at > WINDOW_MS) continue;
  due.push(slug);
}

const missing = [];
for (const slug of due) {
  const url = `${site}/blog/${slug}/`;
  let status;
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    status = response.status;
  } catch (error) {
    console.error(`warning: ${url} did not answer (${error instanceof Error ? error.message : error}); not rebuilding for it`);
    continue;
  }
  if (status === 404) missing.push(slug);
  else if (status >= 500) console.error(`warning: ${url} answered ${status}; not rebuilding for it`);
  else console.error(`${slug}: live (${status})`);
}
for (const slug of missing) console.log(slug);
