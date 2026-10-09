import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { markdownTwinPath } from './lib/markdown-twin';

/** Point every docs page at its Markdown twin, for agents that prefer Markdown to HTML. */
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const href = markdownTwinPath(route.id);
  if (!href) return;
  route.head.push({
    tag: 'link',
    attrs: { rel: 'alternate', type: 'text/markdown', href, title: 'Markdown' },
  });
});
