// The blog's head data, Markdown and feed, from src/data/blog.ts.
import { AUTHOR, type Part, type Post, POSTS, postPath } from '../data/blog';
import { absolute, article, breadcrumb, graph, ogImage, type Seo, webPage } from './seo';

const SITE_LINK = /\]\(\//g;
const md = (text: string) => text.replace(SITE_LINK, `](${absolute('/')}`);

export const BLOG = {
  path: '/blog/',
  title: 'Slotlock blog: booking, calendars and AI agents',
  description:
    'Notes on booking for AI agents: preventing double bookings in PostgreSQL, holds, MCP tool design, time zones, and how Pylota books cars with Slotlock.',
  image: ogImage('blog'),
  imageAlt: 'The Slotlock blog: notes on booking, calendars and AI agents.',
};

export const authorLd = { '@type': 'Organization', name: AUTHOR.name, url: AUTHOR.url };

export function blogSeo(): Seo {
  return {
    ...BLOG,
    markdown: '/blog.md',
    jsonLd: [
      graph(
        webPage(BLOG, 'CollectionPage'),
        breadcrumb([
          { name: 'Slotlock', path: '/' },
          { name: 'Blog', path: '/blog/' },
        ]),
      ),
    ],
  };
}

export function postSeo(post: Post): Seo {
  const path = postPath(post);
  const title = post.seoTitle ?? post.title;
  const image = ogImage(post.image);
  return {
    title,
    description: post.description,
    path,
    image,
    imageAlt: post.imageAlt,
    type: 'article',
    markdown: `/blog/${post.slug}.md`,
    jsonLd: [
      graph(
        article(
          { title: post.title, description: post.description, path, image },
          { type: 'BlogPosting', published: post.date, modified: post.updated ?? post.date, author: authorLd },
        ),
        breadcrumb([
          { name: 'Slotlock', path: '/' },
          { name: 'Blog', path: '/blog/' },
          { name: post.title, path },
        ]),
      ),
    ],
  };
}

export const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function partMarkdown(part: Part): string {
  if ('h2' in part) return `## ${part.h2}`;
  if ('p' in part) return md(part.p);
  if ('ul' in part) return part.ul.map((item) => `- ${md(item)}`).join('\n');
  if ('ol' in part) return part.ol.map((item, i) => `${i + 1}. ${md(item)}`).join('\n');
  if ('code' in part) return `${part.caption ? `${part.caption}:\n\n` : ''}\`\`\`\n${part.code}\n\`\`\``;
  return [
    `| ${part.table.columns.join(' | ')} |`,
    `| ${part.table.columns.map(() => '---').join(' | ')} |`,
    ...part.table.rows.map((row) => `| ${row.map(md).join(' | ')} |`),
  ].join('\n');
}

export function postMarkdown(post: Post): string {
  return `${[
    `# ${post.title}`,
    `> ${post.description}`,
    `${longDate(post.date)} · ${AUTHOR.name}`,
    ...post.body.map(partMarkdown),
    `Related: ${post.related.map((l) => `[${l.label}](${absolute(l.href)})`).join(' · ')}`,
    `Page: ${absolute(postPath(post))}`,
  ].join('\n\n')}\n`;
}

export function blogMarkdown(): string {
  return `${[
    `# ${BLOG.title}`,
    `> ${BLOG.description}`,
    ...POSTS.map((post) => `- [${post.title}](${absolute(`/blog/${post.slug}.md`)}) (${post.date}): ${post.description}`),
    `Feed: ${absolute('/blog/rss.xml')}`,
  ].join('\n\n')}\n`;
}

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function rss(): string {
  const items = POSTS.map(
    (post) => `    <item>
      <title>${xml(post.title)}</title>
      <link>${absolute(postPath(post))}</link>
      <guid isPermaLink="true">${absolute(postPath(post))}</guid>
      <pubDate>${new Date(`${post.date}T09:00:00Z`).toUTCString()}</pubDate>
      <description>${xml(post.description)}</description>
    </item>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(BLOG.title)}</title>
    <link>${absolute('/blog/')}</link>
    <atom:link href="${absolute('/blog/rss.xml')}" rel="self" type="application/rss+xml" />
    <description>${xml(BLOG.description)}</description>
    <language>en-gb</language>
${items}
  </channel>
</rss>
`;
}
