/**
 * The URL of a docs page's Markdown twin: `docs` → `/docs/index.md`, `docs/quickstart` →
 * `/docs/quickstart.md`. Pages outside /docs/ (the 404 page) have none.
 */
export function markdownTwinPath(id: string): string | null {
  if (id === 'docs') return '/docs/index.md';
  if (id.startsWith('docs/')) return `/${id}.md`;
  return null;
}

/** The `[...slug]` parameter that `src/pages/docs/[...slug].md.ts` builds for a docs entry id. */
export function markdownTwinSlug(id: string): string | null {
  const path = markdownTwinPath(id);
  return path ? path.slice('/docs/'.length, -'.md'.length) : null;
}
