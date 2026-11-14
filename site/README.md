# slotlock.pylota.io

The landing page and the docs, built with Astro and Starlight and served by one static-assets
Cloudflare Worker (`wrangler.jsonc`: its only script answers byte ranges of a blog post's videos, and
its only binding is its assets). This directory is its own npm
project, not a workspace of the package at the repository root.

```
site/
  astro.config.mjs        Starlight config, llms.txt plugin, sidebar
  docs-src/*.md           docs pages; <!-- include README.md#section --> pulls text from the repo
                          (modifiers: body, lead, promote)
  src/data/landing.ts     every sentence on the landing page (the page and /index.md share it)
  src/data/pages/*.ts     every page outside the docs for one search intent (pricing, MCP server,
                          booking API, open source, about, use cases, comparisons), as data that
                          src/components/marketing/Page.astro and its Markdown twin both render
  content/blog/<slug>.md  the blog's posts: frontmatter and a strict Markdown subset, written here or in
                          the admin console (RFC 0006); src/lib/post-format.ts renders them for
                          /blog/, /blog/<slug>.md and /blog/rss.xml, and the console's preview
  src/data/authors.json   who a post can name as its author (Person or Organization, structured data)
  public/blog/<slug>/     a post's own files: pictures, GIFs, videos and PDFs (see "Write a post")
  src/layouts/Marketing.astro   the header, footer and head of every page outside the docs
  src/lib/seo.ts          titles, canonicals, Open Graph and the JSON-LD graph (SeoHead.astro)
  src/data/llms.mjs       what llms.txt tells agents beyond the page list (the repository tests read it)
  src/pages/index.astro   the landing page; index.md.ts its Markdown twin
  src/pages/docs/[...slug].md.ts   a Markdown twin of every docs page
  src/components/docs/    Starlight overrides: site title, page title (eyebrow, title, lede), footer
  src/routeData.ts        the docs' search titles (frontmatter seoTitle), Open Graph image,
                          TechArticle and breadcrumb data, and noindex on the 404 page
  src/styles/tokens.mjs   colour tokens (Pylota's, after PR #505), light and dark
  src/styles/docs.css     the docs theme on those tokens
  scripts/sync-content.mjs  builds docs pages and src/generated/facts.json from README, SPEC,
                            SECURITY, CHANGELOG and src/*.ts; fails if a fact moved. It also writes
                            public/facts.json, the short facts a post names as {{facts.name}}, which
                            the admin console's preview reads from the live site
  scripts/tool-schemas.mjs  reads each tool's Zod input and output schemas and example from
                            src/agent-server.ts as text (the site has no package dependencies)
  scripts/tools-page.mjs  renders /docs/tools/ from those schemas and scripts/tool-notes.mjs
  scripts/tool-notes.mjs  the words a schema cannot carry: summaries, field notes, error codes per
                          tool; the build fails on a note for a field or code that does not exist
  scripts/postbuild.mjs   pins the CSP in dist/_headers to the hashes of Starlight's inline code
  scripts/seo-check.mjs   titles, descriptions, canonicals, images, JSON-LD and the sitemap of
                          every built page (docs/rfc/0005-search.md)
  scripts/og-images.mjs   draws public/og/*.png with Chromium (the icons are the design system's files)
                          (`npm run og`; the PNGs are committed)
  scripts/contrast.mjs    WCAG AA check of every text/background pair, both themes
  scripts/copy-lint.mjs   Pylota's voice rules (no em dash, no filler words) and the word count
  scripts/subset-fonts.sh rebuilds public/fonts from the OFL sources
  public/_headers         CSP, HSTS, caching, Markdown content types
  worker/range.mjs        the one script: byte ranges of a post's videos, which static assets do not
                          give and Safari needs to play them (run first for /blog/*/*.mp4 and .webm only)
  public/_redirects       old addresses of renamed posts (the console adds them)
  wrangler.preview.jsonc  the preview Worker each CMS pull request's build goes to, as
                          https://pr-<number>-<host>/ (site.yml, the preview job)
```

Tool names and schemas, versions, limits, the exclusion constraint and the README quick start are
read from the repository on every build, so the site cannot claim something the code does not do. Generated files
(`src/content/docs/`, `src/generated/`, `public/schema/`, `public/facts.json`) are git-ignored.

## Write a post

Write it in the admin console's editor (Content, then New post), or as a file,
`content/blog/<slug>.md`, with its files in `public/blog/<slug>/`. The editor's preview and checks
are the site's own (`src/lib/post-format.ts`), so what it shows is the page.

The body is a strict Markdown subset. Every character is escaped: no HTML, no scripts, no styles.

| Write | For |
| --- | --- |
| `## Heading`, `### Subheading` | the post's sections (the title is its only `#`) |
| `**bold**`, `*italic*`, `` `code` ``, `[words](/docs/)`, `[words](https://…)` | inline |
| `- item`, `1. item`, `> quote`, `---` | lists, a quote, a divider |
| `` ```sql caption="What it shows" `` … `` ``` `` | a code block, with an optional caption |
| a GitHub table | a table; on a phone it scrolls sideways instead of squeezing |
| `![Alt text](/blog/<slug>/name.png "Caption")` | a picture: PNG, JPEG, WebP, AVIF, or an animated GIF |
| `![Alt text](/blog/<slug>/name.mp4 "Caption")` | a video, MP4 or WebM, with its controls; the alt text is its name for a screen reader |
| `![Title](https://www.youtube.com/watch?v=…)` or `![Title](https://vimeo.com/…)` | a YouTube player from youtube-nocookie.com, or Vimeo's with do-not-track |
| `[The slides (PDF)](/blog/<slug>/slides.pdf)` | a PDF to download |
| `{{facts.version}}` | a number or name read from Slotlock's code |

A picture, a video and a player are each on a line of their own, with alt text (a player's title)
of 1 to 200 characters; the caption is optional. Only those two video sites are embedded, as the
CSP's `frame-src` allows, each in a sandboxed frame that loads when it scrolls into view.

In the editor, the toolbar writes each of these at the cursor (Ctrl or ⌘ with B, I, K for a link,
E for code, Alt+2 and Alt+3 for headings, Shift+8, Shift+7 and Shift+. for lists and a quote).
Paste a screenshot or drop a file on the post to upload it: the editor asks for its alt text and puts
it where the cursor was. The Media panel lists the post's files, to insert or delete.

A post's files, checked by their first bytes (never by their names) in the console before anything
is committed, and again by the build (`src/lib/posts.ts`), which fails on any file that breaks one:

| File | Largest |
| --- | --- |
| PNG, JPEG, WebP, AVIF | 5 MB |
| GIF, PDF | 10 MB |
| MP4, WebM | 20 MB |
| A post's files together | 20 files, 50 MB |

An SVG, a QuickTime `.mov`, a Matroska `.mkv`, HEIC or anything else is refused; export a screen
recording as MP4 or WebM. The limits sit under Cloudflare's 25 MiB for a static asset, GitHub's
contents API (raw reads for files over 1 MB) and the console Worker's 128 MB of memory; the sources
and the dates they were read are in `src/lib/post-format.ts`, beside `POST_FILE_KINDS`.

## Work on it

Node.js 22.12 or newer.

```sh
npm ci
npm run dev            # http://localhost:4321
npm run build          # dist/, then the CSP pinning
npm run check          # contrast, copy lint and the SEO check (after a build)
npm run preview:worker # serve dist/ with Wrangler, _headers applied, on :8787
```

Restart `preview:worker` after a build: Wrangler stops when `astro build` replaces `dist/`.

## Deploy

`.github/workflows/site.yml` builds every pull request that touches the site or the files it reads,
and on a push to `main` (or a manual run on `main`) deploys through the `site` environment.

Before the first deploy, the repository owner has to:

1. Make sure `slotlock.pylota.io` has no `CNAME` record, and that the `pylota.io` zone has the
   route `slotlock.pylota.io/*` with no Worker. A route runs before a Custom Domain, so without
   that bypass the zone's `*.pylota.io/*` route (the Pylota booking Worker) answers instead. The
   bypass is managed in `infra/tofu/booking.tf` in PILOTAAI/pylota, beside the ones for `admin` and
   `booking-canary`. Cloudflare creates the DNS record and certificate on the first deploy.
2. Create a Cloudflare API token. In the Cloudflare dashboard, go to **Manage account › Account API
   tokens › Create Token** and use the **Edit Cloudflare Workers** template. Limit it to the account
   that holds `pylota.io`, and to the `pylota.io` zone. Copy the token Cloudflare shows once, after
   **Create Token**. The token is 40 characters or more, and new ones start with `cfat_`. Do not copy
   the token's ID or name from the token list, the account ID, or the Global API Key from your
   profile: Cloudflare refuses all of them with "Invalid format for Authorization header".
3. Store it, with the account ID from **Account home**, in the `site` environment. The command
   checks both with Cloudflare first, and stores nothing it refuses:

   ```sh
   scripts/configure-github.sh --site-secrets
   ```

Then run the workflow on `main` and check https://slotlock.pylota.io.

Every deploy runs `scripts/check-cloudflare-credentials.sh` first, and names the problem when the
secrets stop working: the account ID or a Global API Key in the token secret, a cut-off paste, an
expired or deleted token, or a token that cannot reach Workers in the account. To fix any of them,
create a token as in step 2 and run step 3 again. A first deploy creates the Worker and its Custom
Domain. That needs the template's account-wide Workers permissions and **Zone › Workers Routes**
on `pylota.io`; later deploys need less.

By hand, from this directory: `npm ci && npm run build && npm run deploy`.
