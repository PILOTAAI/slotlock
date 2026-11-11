/**
 * Where the visitor is, for the header's links: `page` on the link's own page, `true` anywhere in
 * its section (a use case under Use cases, a post under Blog, any docs page under Docs), so the
 * header always shows where you are. aria-current says so to screen readers; CSS draws it.
 */
export function navCurrent(path: string, href: string): 'page' | 'true' | undefined {
  const here = path.endsWith('/') ? path : `${path}/`;
  if (here === href) return 'page';
  if (href !== '/' && href.endsWith('/') && here.startsWith(href)) return 'true';
  return undefined;
}
