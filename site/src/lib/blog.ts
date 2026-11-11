// The blog's head data, Markdown and feed, from the posts in content/blog/ (posts.ts).
import { postTwin } from './post-format';
import { authorOf, type Post, POSTS, postPath } from './posts';
import facts from '../generated/facts.json';
import { absolute, article, breadcrumb, graph, ogImage, type Seo, SITE, webPage } from './seo';

export const BLOG = {
  path: '/blog/',
  title: 'Slotlock blog: booking, calendars and AI agents',
  description:
    'Notes on booking for AI agents: preventing double bookings in PostgreSQL, holds, MCP tool design, time zones, and how Pylota books cars with Slotlock.',
  image: ogImage('blog'),
  imageAlt: 'The Slotlock blog: notes on booking, calendars and AI agents.',
};

/** A post's author as structured data: a Person with their GitHub profile, or the maintainers. */
export const authorLd = (post: Post) => {
  const author = authorOf(post);
  return { '@type': author.type, name: author.name, url: author.url };
};

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
  const { front } = post;
  const title = front.seoTitle ?? front.title;
  const image = ogImage(front.image);
  return {
    title,
    description: front.description,
    path,
    image,
    imageAlt: front.imageAlt,
    type: 'article',
    markdown: `/blog/${post.slug}.md`,
    jsonLd: [
      graph(
        article(
          { title: front.title, description: front.description, path, image },
          { type: 'BlogPosting', published: front.date, modified: front.updated ?? front.date, author: authorLd(post) },
        ),
        breadcrumb([
          { name: 'Slotlock', path: '/' },
          { name: 'Blog', path: '/blog/' },
          { name: front.title, path },
        ]),
      ),
    ],
  };
}

export const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function postMarkdown(post: Post): string {
  return postTwin(post, { site: SITE, author: authorOf(post), longDate: longDate(post.front.date), facts });
}

export function blogMarkdown(): string {
  return `${[
    `# ${BLOG.title}`,
    `> ${BLOG.description}`,
    ...POSTS.map((post) => `- [${post.front.title}](${absolute(`/blog/${post.slug}.md`)}) (${post.front.date}): ${post.front.description}`),
    `Feed: ${absolute('/blog/rss.xml')}`,
  ].join('\n\n')}\n`;
}

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function rss(): string {
  const items = POSTS.map(
    (post) => `    <item>
      <title>${xml(post.front.title)}</title>
      <link>${absolute(postPath(post))}</link>
      <guid isPermaLink="true">${absolute(postPath(post))}</guid>
      <pubDate>${new Date(`${post.front.date}T09:00:00Z`).toUTCString()}</pubDate>
      <description>${xml(post.front.description)}</description>
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
