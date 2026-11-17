import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import lastmod from './generated/lastmod.json';
import { markdownTwinPath } from './lib/markdown-twin';
import {
  absolute,
  article,
  breadcrumb,
  clampDescription,
  graph,
  jsonLdText,
  OG_LOCALE,
  OG_SIZE,
  ogImage,
} from './lib/seo';

type HeadEntry = {
  tag: 'title' | 'base' | 'link' | 'style' | 'meta' | 'script' | 'noscript' | 'template';
  attrs?: Record<string, string | boolean | undefined>;
  content?: string;
};

const DATES = lastmod as Record<string, string>;

/**
 * Every docs page's head, for search and link previews (docs/rfc/0005-search.md 1.2 to 1.8):
 * the search title and description where the frontmatter sets them, an Open Graph image, en-GB,
 * TechArticle and BreadcrumbList data, a link to the Markdown twin; and noindex on the 404 page.
 */
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const head = route.head as HeadEntry[];
  const meta = (key: string, value: string) => head.find((entry) => entry.attrs?.[key] === value);
  const set = (key: string, value: string, content: string) => {
    const entry = meta(key, value);
    if (entry?.attrs) entry.attrs.content = content;
    else head.push({ tag: 'meta', attrs: { [key]: value, content } });
  };
  set('property', 'og:locale', OG_LOCALE);

  // The not-found page is served at any unknown address with a 404 status: no canonical, no index.
  if (route.id === '404') {
    route.head = head.filter(
      (entry) => entry.attrs?.rel !== 'canonical' && entry.attrs?.property !== 'og:url',
    );
    route.head.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } });
    return;
  }

  const data = route.entry.data as {
    title: string;
    description?: string;
    seoTitle?: string;
    seoDescription?: string;
    ogImage?: string;
  };
  const path = context.url.pathname.endsWith('/') ? context.url.pathname : `${context.url.pathname}/`;
  const isApi = path.startsWith('/docs/api/') && path !== '/docs/api/';

  const title = data.seoTitle ?? `${data.title} | Slotlock`;
  const titleEntry = head.find((entry) => entry.tag === 'title');
  if (titleEntry) titleEntry.content = title;
  set('property', 'og:title', title.replace(/ \| Slotlock$/, ''));

  const description = data.seoDescription ?? clampDescription(data.description ?? '');
  set('name', 'description', description);
  set('property', 'og:description', description);

  const image = ogImage(data.ogImage ?? (isApi ? 'docs-api' : 'docs'));
  const imageAlt = `${data.title}: Slotlock documentation`;
  set('property', 'og:image', absolute(image));
  set('property', 'og:image:width', String(OG_SIZE.width));
  set('property', 'og:image:height', String(OG_SIZE.height));
  set('property', 'og:image:alt', imageAlt);
  set('name', 'twitter:image', absolute(image));
  set('name', 'twitter:image:alt', imageAlt);

  const crumbs = [
    { name: 'Slotlock', path: '/' },
    { name: 'Docs', path: '/docs/' },
    ...(isApi ? [{ name: 'REST API', path: '/docs/api/' }] : []),
    ...(path === '/docs/' ? [] : [{ name: data.title, path }]),
  ];
  const ld = graph(
    article(
      { title, description, path, image },
      { type: 'TechArticle', ...(DATES[path] ? { modified: DATES[path] } : {}) },
    ),
    breadcrumb(crumbs),
  );
  head.push({ tag: 'script', attrs: { type: 'application/ld+json' }, content: jsonLdText(ld) });

  // Point every docs page at its Markdown twin, for agents that prefer Markdown to HTML.
  const href = markdownTwinPath(route.id);
  if (href) {
    head.push({
      tag: 'link',
      attrs: { rel: 'alternate', type: 'text/markdown', href, title: 'Markdown' },
    });
  }
});
