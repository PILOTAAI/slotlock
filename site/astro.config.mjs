// slotlock.pylota.io: the landing page (src/pages/index.astro) and the docs under /docs/ (Starlight).
// Docs pages are generated into src/content/docs/docs/ by scripts/sync-content.mjs from docs-src/
// and the repository's README, SPEC, SECURITY and CHANGELOG, so they cannot drift from them.
import { readdirSync, readFileSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

const REPO = 'https://github.com/PILOTAAI/slotlock';
const SIDEBAR_ORDER = [
  'index',
  'quickstart',
  'concepts',
  'security',
  'reference',
  'specification',
  'changelog',
];

/** The docs pages as Markdown links, read from docs-src so llms.txt lists exactly what is built. */
function markdownPageList() {
  const dir = new URL('./docs-src/', import.meta.url);
  const pages = readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== '404.md')
    .map((file) => {
      const text = readFileSync(new URL(file, dir), 'utf8');
      const field = (name) => new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1] ?? '';
      return {
        slug: file.replace(/\.md$/, ''),
        title: field('title'),
        description: field('description'),
      };
    })
    .sort((a, b) => SIDEBAR_ORDER.indexOf(a.slug) - SIDEBAR_ORDER.indexOf(b.slug));
  return pages
    .map(
      (page) => `- [${page.title}](https://slotlock.pylota.io/docs/${page.slug}.md): ${page.description}`,
    )
    .join('\n');
}

const llmsDetails = `Slotlock is a pre-release (0.1) TypeScript library and MCP/A2A server. It is not on npm yet and has no hosted service; you run it against your own PostgreSQL 16.

Instructions for AI agents:

- Append \`.md\` to a docs page URL for its Markdown source, for example https://slotlock.pylota.io/docs/quickstart.md. The landing page is https://slotlock.pylota.io/index.md.
- Tool names are \`calendar_<verb>\` (for example \`calendar_find_next_available\`). A refused or conflicting call is a tool result \`{"error":{"code":"…"}}\`, not a protocol error: read the code, then act. \`overlap\` means the time is already taken.
- A slot is free only when its coverage is certain. Treat \`uncertain\` (reason \`coverage_incomplete\`) as unknown, never as free.
- Writes need an \`idempotency_key\`; retry with the same key and arguments. Updates and deletes need the \`expected_revision\` you last read.
- Slotlock does not sync Google or Microsoft calendars by itself; adapters live in the embedding application.
- The normative semantics are https://slotlock.pylota.io/docs/specification.md; the capability manifest schema is https://slotlock.pylota.io/schema/manifest.schema.json.

Docs pages as Markdown:

${markdownPageList()}`;

export default defineConfig({
  site: 'https://slotlock.pylota.io',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    // Every stylesheet is a file, so the strict CSP in public/_headers needs no 'unsafe-inline'.
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      // Keep scripts out of the HTML for the same reason.
      assetsInlineLimit: 0,
    },
  },
  integrations: [
    starlight({
      title: 'Slotlock',
      description:
        'A calendar engine for AI agents: resource calendars, expiring holds and a PostgreSQL exclusion constraint that refuses double bookings.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      customCss: ['./src/styles/fonts.css', './src/styles/docs.css', './src/styles/lockup.css'],
      // Seven pages do not need a search index; leaving Pagefind out keeps WebAssembly out of the CSP.
      pagefind: false,
      // src/pages/404.astro renders the not-found page with Starlight's layout.
      disable404Route: true,
      expressiveCode: {
        // Code panels are dark in both themes, as on the landing page.
        themes: ['github-dark-default'],
        useStarlightUiThemeColors: false,
        useStarlightDarkModeSwitch: false,
      },
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preload',
            href: '/fonts/inter.woff2',
            as: 'font',
            type: 'font/woff2',
            crossorigin: 'anonymous',
          },
        },
      ],
      sidebar: [
        { label: 'Start here', items: ['docs', 'docs/quickstart'] },
        { label: 'Learn', items: ['docs/concepts', 'docs/security'] },
        {
          label: 'Reference',
          items: ['docs/reference', 'docs/specification', 'docs/changelog'],
        },
      ],
      routeMiddleware: './src/routeData.ts',
      components: {
        Footer: './src/components/docs/Footer.astro',
        // "Slotlock by Pylota", as in the landing page header.
        SiteTitle: './src/components/docs/SiteTitle.astro',
      },
      plugins: [
        starlightLlmsTxt({
          projectName: 'Slotlock',
          description:
            'The calendar AI agents cannot double-book: each car, room, person or machine is its own calendar, holds expire on their own, and a PostgreSQL exclusion constraint refuses any overlapping write and returns the conflict as data. Agents use it over MCP (2026-07-28, 2025-11-25) or A2A 1.0, or call it as a TypeScript library.',
          details: llmsDetails,
          promote: ['docs', 'docs/quickstart', 'docs/concepts'],
          demote: ['docs/changelog', '404'],
          optionalLinks: [
            {
              label: 'Landing page as Markdown',
              url: 'https://slotlock.pylota.io/index.md',
              description: 'the claims on slotlock.pylota.io, one band per section',
            },
            {
              label: 'Capability manifest schema',
              url: 'https://slotlock.pylota.io/schema/manifest.schema.json',
              description: 'JSON Schema for slotlock.manifest.json',
            },
            { label: 'Source code', url: REPO, description: 'Apache-2.0, on GitHub' },
          ],
        }),
      ],
    }),
  ],
});
