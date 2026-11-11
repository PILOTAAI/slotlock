# RFC 0005: Search: make slotlock.pylota.io rank for what people ask

| | |
| --- | --- |
| Status | Accepted (2026-11-11); Phases 1 to 3 and the in-repository part of Phase 4 are implemented on `claude/serene-sagan-4n2tr6` |
| Target | The code in one session; the owner's settings in about 30 minutes; rankings over the following weeks and months |
| Decision | GOVERNANCE.md: the maintainer approves. The owner decided D1 to D6 on 2026-11-11 (Part 5). |

## Summary

This RFC audits slotlock.pylota.io for search and plans the work to rank on Google, and on Bing
and the AI answer engines that read it. The audit was done on 2026-11-11 against `main` at
`38aa937`, by building the site (`npm run build`: 154 pages), reading the HTML it produces, probing
the live hosts with curl, and running Lighthouse 12.8 (mobile) on the live site.

In brief:

- **The engineering base is good, and is not what holds the site back.** Pages are static HTML,
  Lighthouse performance is 99 (LCP 1.7 s, CLS 0, TBT 0), every page has a canonical, one h1, and a
  unique title and description. There is a sitemap, and there are no broken or redirecting internal
  links. `llms.txt` and a Markdown twin of every page already put the site ahead for AI agents.
- **Google probably does not know the site yet.** A `site:slotlock.pylota.io` search on
  2026-11-11 returned nothing from the domain. The search for the brand, "slotlock", returned a
  Minecraft mod, a Microchip command and a registered SLOTLOCK word mark. The repository is a month
  old with no stars, and nothing with authority links to the site.
- **One page cannot rank for many intents.** The site has one marketing page. Pricing, the MCP
  server, the REST API, the industries and open source are sections of it or docs pages, so none
  of them can rank for its own queries. The landing page is also at 1,294 of the 1,300 words its
  copy lint allows, so the fix is new pages, not more text on this one.
- **The metadata misses what search and social need.** There is no `og:image` on any page, and no
  structured data. The landing description is 296 characters long, and 90 of the 120 REST
  reference pages have descriptions over 160 characters (up to 1,248). Docs titles such as
  "Introduction", "Concepts" and "Scaling" say nothing a searcher types.
- **Four host settings work against the site**, and none of them is in this repository:
  - HTTP is served with a 200 instead of a redirect to HTTPS.
  - Cloudflare's managed robots.txt prepends a block that fails Lighthouse's robots.txt audit
    (SEO 92) and turns away the AI training crawlers.
  - Cloudflare Web Analytics is injected but blocked by the site's own CSP, so no traffic is
    measured.
  - The dashboard and API hosts can be indexed.

The plan has six parts. The code is quick to write; what takes time is outside it. Google crawls a
new site over days, and links and rankings build over weeks.

| Phase | What | Who | Time to do | Time to show results |
| --- | --- | --- | --- | --- |
| 0 | Search Console, Bing, HTTPS redirect, robots and analytics settings, noindex on the app and API hosts | Owner, in dashboards | About 30 minutes | Search Console data in 2 to 3 days |
| 1 | Technical foundation: head metadata, Open Graph images, structured data, sitemap `lastmod`, Markdown twin canonicals, 404, the SEO check in CI | One pull request | Done in this change | At the next crawl, days |
| 2 | Pages for commercial intent: `/pricing/`, `/mcp-server/`, `/booking-api/`, `/open-source/`, `/use-cases/*`, `/about/` | Same pull request | Done in this change | Indexed in 1 to 4 weeks |
| 3 | Content: `/blog/` with RSS, the first articles, `/compare/*` | Same pull request, then 2 articles a month | Scaffold and first articles done in this change | Weeks to months |
| 4 | Authority: links from pylota.io, MCP directories, package registries, launches | Owner and maintainers; the registry metadata is in this change | An afternoon of submissions | Months |
| 5 | Measure and iterate | Owner | 30 minutes a month | Ongoing |

## Part 1: What the audit found

### 1.1 Already right (keep it)

- **Rendering.** Astro 7.4 and Starlight 0.42 render static HTML, so Googlebot needs no JavaScript
  to read any page. The landing page carries no inline script or style (`scripts/postbuild.mjs`
  enforces it).
- **Speed.** Lighthouse mobile on the live site gives the landing page performance 99,
  accessibility 96 and best practices 93. `/docs/quickstart/` gives 99, 100 and 93. Fonts are
  subset and preloaded.
- **Basics on all 154 pages.** Each has a self-referencing absolute canonical with a trailing slash
  and exactly one h1, and no two pages share a title or a description.
- **Links.** Across the build, 0 internal links are broken and 0 lack the trailing slash (each would
  cost a 307). No link in the repository's own files points at a docs URL without the slash.
- **Sitemap.** `@astrojs/sitemap` (added by Starlight) lists 153 URLs, and `robots.txt` names it.
- **Agents.** `llms.txt`, `llms-full.txt`, `llms-small.txt`, `/index.md` and a `.md` twin of every
  docs page, each linked with `rel="alternate" type="text/markdown"`.
- **Claims come from code.** `scripts/sync-content.mjs` reads versions, tools, limits and plans
  from the repository on every build, so new pages built the same way cannot drift.
- **Backlink basics.** npm, PyPI, crates.io and NuGet name `https://slotlock.pylota.io` as the
  homepage. So do the MCP registry entry (`server.json` `websiteUrl`) and the GitHub repository,
  whose topics are set.

### 1.2 Findings

Severity: **H** stops ranking or measurement, **M** costs clicks or rankings, **L** is hygiene.

| # | Finding | Evidence | Sev. | Fix |
| --- | --- | --- | --- | --- |
| F1 | The site is not in the search index, and the brand query is taken | `site:` search returned 0 pages from the domain; "slotlock" returns a Minecraft mod, a Microchip command and a 2021 SLOTLOCK word mark | H | 0.1, Phase 4 |
| F2 | One marketing page for every intent; pricing is an anchor (`#pricing`) | `src/pages/` has `index.astro` and `404.astro` only | H | Phase 2 |
| F3 | No `og:image` anywhere; docs declare `twitter:card` `summary_large_image` with no image; the landing page has `summary` | built `<head>` of `index.html` and `docs/*/index.html` | M | 1.4 |
| F4 | No structured data (JSON-LD) on any page | grep of `dist/` | M | 1.5 |
| F5 | Landing description is 296 characters (Google shows about 155); 90 of 120 REST reference descriptions exceed 160 (max 1,248) | `src/data/landing.ts` `meta`; `scripts/api-reference.mjs` | M | 1.1, 1.3 |
| F6 | Docs titles name the page, not the topic: "Introduction", "Concepts", "Scaling", "Operations", "Limits" | `docs-src/*.md` `title:` | M | 1.2 |
| F7 | HTTP is not redirected to HTTPS: `http://slotlock.pylota.io/` answers 200 with the full page | curl, 2026-11-11 | M | 0.3 |
| F8 | Cloudflare's managed robots.txt is prepended to ours. Its `Content-Signal` line fails Lighthouse's robots.txt audit (SEO 92). It disallows GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot and others, and the search engines Baiduspider and PetalBot. Googlebot, Bingbot, OAI-SearchBot and PerplexityBot are allowed. | live `/robots.txt`; Lighthouse `robots-txt` | M | 0.4 |
| F9 | Cloudflare Web Analytics is injected by the zone but blocked by our CSP: no analytics, and a console error (best practices 93) | Lighthouse `errors-in-console` | H (measurement) | 0.5 |
| F10 | `app.slotlock.pylota.io` (sign-in page "Sign in · Slotlock") and `slotlock-api.pylota.io` send no `X-Robots-Tag`; both can be indexed and compete for the brand | curl headers | M | 0.6 |
| F11 | Markdown twins (`/index.md`, `/docs/*.md`, `/docs/api/*.md`) answer 200 with no canonical and no `noindex`: duplicates of every page | curl headers of `/docs/quickstart.md` | M | 1.6 |
| F12 | The sitemap has no `lastmod` | `dist/sitemap-0.xml` | L | 1.7 |
| F13 | The 404 page's canonical is `https://slotlock.pylota.io/404/`, with no `noindex` (it is served with status 404, so the harm is small) | `dist/404.html` | L | 1.8 |
| F14 | Language differs: the landing page is `en-GB`; docs are `en` with `og:locale` `en` | `<html lang>` | L | 1.2 |
| F15 | H2s are slogans ("Questions we expect first.", "However your agent is built, it can book."): no topic words in the headings | `src/data/landing.ts` | M | 1.1 |
| F16 | Landing page is at 1,294 of 1,300 words allowed by `scripts/copy-lint.mjs` | `npm run check:copy` | Constraint | Phase 2 |
| F17 | One contrast failure on the landing page: the lapsed "hold" label | Lighthouse `color-contrast` | L | 1.9 |
| F18 | Trailing-slash redirects are 307 (temporary): `/docs/quickstart` → `/docs/quickstart/` | curl | L | none: every link we control has the slash; leave Cloudflare's `auto-trailing-slash` |

## Part 2: Who searches, and for what

No keyword tool was available for this audit, so the queries below are hypotheses from the product
and from today's results pages. Phase 0 checks volumes in Google Keyword Planner. Phase 5 replaces
them with Search Console's real queries.

| # | Cluster | Example queries | Intent | Target page | Today |
| --- | --- | --- | --- | --- | --- |
| K1 | Brand | slotlock, slotlock mcp, slotlock api, slotlock pricing | Navigational | `/`, `/pricing/` | `/` only, not indexed |
| K2 | MCP category | calendar MCP server, booking MCP server, scheduling MCP server, MCP server for appointments | Commercial, developer | `/mcp-server/` | none (docs/connect, docs/tools) |
| K3 | Agent booking API | booking API for AI agents, scheduling API for AI agents, calendar API for AI agents | Commercial | `/`, `/booking-api/` | `/` in part |
| K4 | Double booking | prevent double booking, double booking race condition, postgres exclusion constraint booking, tstzrange overlap | Informational, developer | blog articles 1 and 2, `/docs/concepts/` | docs only |
| K5 | Booking mechanics | hold a slot while the customer pays, temporary reservation expiry, next available slot API, free/busy API | Informational, commercial | articles 3 and 6, `/booking-api/` | docs only |
| K6 | Verticals | car rental booking API, fleet availability API, van hire booking system, equipment hire scheduling, padel court booking system, service bay scheduling, field service scheduling API | Commercial | `/use-cases/<vertical>/` | one docs page with eight sections |
| K7 | Open source | open source booking engine, self-hosted scheduling API, open source reservation system PostgreSQL | Commercial, developer | `/open-source/`, `/docs/self-host/` | docs only |
| K8 | Alternatives | Cal.com API alternative, Cronofy alternative, Nylas scheduler alternative, LibreBooking alternative | Commercial investigation | `/compare/*` | none |
| K9 | Reference long tail | RRULE time zone daylight saving, import iCalendar busy time, idempotency key booking API, RFC 9457 example | Informational | the docs pages, with search titles (1.2) | generic titles |

What the results pages show:

- **K2 is new and winnable.** Its results today are vendor pages and directory listings: Cal.com's
  hosted MCP server, Cronofy, Schedly, OnceHub and Astrocal, listed on glama.ai, mcpservers.org
  and similar. Directory listings rank, so Phase 4 gets Slotlock into them.
- **The closest positioning is Temporal Cortex**, an MCP server that sells "no double booking"
  with a two-phase lock over Google Calendar. It ranks with a `/compare` page and blog posts on
  the double-booking race. Slotlock's answer, a database constraint rather than a lock around a
  provider API, is stronger and should be said in the same places.
- **K3 head terms ("scheduling API", "booking API") belong to Calendly, Cal.com, Nylas and
  Cronofy.** Target the "for AI agents" long tail first.
- **K4 has strong developer demand** (DEV.to, Medium and Django docs rank), and no product
  owns it. Slotlock is built on exactly this technique, which makes it the best route to
  links.
- **K1:** the name is shared. Pair the brand with the category everywhere ("Slotlock booking API",
  "Slotlock MCP server"), and add Organization and WebSite structured data (1.5), so Google can tell
  the entities apart.

## Part 3: The plan

### Phase 0: owner settings (no code)

| # | Action | Where | Done when |
| --- | --- | --- | --- |
| 0.1 | Add a Search Console **Domain** property for `pylota.io` (DNS TXT; covers `slotlock.`, `app.slotlock.` and `slotlock-api.`). Submit `https://slotlock.pylota.io/sitemap-index.xml`. Request indexing of `/`, `/docs/` and `/docs/quickstart/` with URL Inspection. | search.google.com/search-console | Sitemap status "Success"; URL Inspection says "URL is on Google" |
| 0.2 | Bing Webmaster Tools: import from Search Console. Turn on Cloudflare **Crawler Hints** for the zone (it sends IndexNow to Bing and Yandex when pages change). Bing results feed ChatGPT search and Copilot. | bing.com/webmasters; Cloudflare › Caching | Sitemap processed in Bing |
| 0.3 | Redirect HTTP to HTTPS: **Always Use HTTPS** on the zone, or a redirect rule for `slotlock.pylota.io` alone. | Cloudflare › SSL/TLS › Edge Certificates | `curl -sI http://slotlock.pylota.io/` gives 301 to `https://` |
| 0.4 | Decide the AI crawler policy (Part 5, D2). If training crawlers are allowed on this host, turn off Cloudflare's managed robots.txt for the zone, or exempt the hostname if the zone needs it for Pylota. Our `public/robots.txt` then serves alone. | Cloudflare › AI Crawl Control | Live `/robots.txt` equals `site/public/robots.txt`; Lighthouse SEO 100 |
| 0.5 | Decide analytics (D3). To keep Cloudflare Web Analytics, which is cookieless, add `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src` in `site/public/_headers` (Phase 1), and add one line to PRIVACY.md. Otherwise turn off its automatic injection for the hostname. | Cloudflare › Web Analytics | No CSP error in the console; visits show in the dashboard |
| 0.6 | Add `X-Robots-Tag: noindex` to every response from `app.slotlock.pylota.io` and `slotlock-api.pylota.io` with a response-header Transform Rule. Keep their robots.txt allowing crawling, or crawlers never see the header. Optionally make it the default in `src/dashboard.ts` and `src/agent-server.ts` later, so self-hosted dashboards are covered too. | Cloudflare › Rules › Transform Rules | `curl -sI https://app.slotlock.pylota.io/dashboard` shows the header |
| 0.7 | Check volumes for the Part 2 queries in Google Keyword Planner; mark each cluster high, medium or low. | ads.google.com › Keyword Planner | Part 2 has a volume column |
| 0.8 | GitHub: upload a social preview image (1280 × 640). Add topics `mcp-server`, `model-context-protocol`, `booking-api`, `scheduling-api`, `ai-agents`, `reservation-system`. | Repository settings | Visible on the repository |

### Phase 1: technical foundation (one pull request)

Each item names its files. `npm run build && npm run check` must pass, and the new
`npm run check:seo` (Part 4) must pass on the result.

**1.1 Landing page head and headings**

- New `site/src/components/seo/SeoHead.astro` and `site/src/lib/seo.ts`. Props: `title`,
  `description`, `path`, `ogImage`, `ogImageAlt`, `type`, `jsonLd[]`, `noindex`, `markdownTwin`.
  The component emits:
  - `<title>`, the description, an absolute canonical with a trailing slash, and `robots` only
    when `noindex`;
  - `og:type`, `og:url`, `og:title`, `og:description`, `og:site_name` "Slotlock",
    `og:locale` `en_GB`, and `og:image` with width, height and alt;
  - `twitter:card` `summary_large_image`, with title, description and image;
  - the Markdown alternate link and the JSON-LD blocks.
- `site/src/pages/index.astro` uses it in place of its hand-written head.
- `site/src/data/landing.ts` `meta` (the owner signs off the words; drafts that pass the copy lint):
  - title (52 characters): `Slotlock: the booking API and calendar for AI agents`
  - description (147): `Give AI agents a calendar for every van, room and machine. Find, hold and book slots over MCP, A2A or REST, and PostgreSQL refuses double bookings.`
- Headings: put a short topic label inside each h2, before the slogan, so the heading carries the
  words people search for. For example `<h2><span class="eyebrow">Double-booking prevention</span>
  <span class="soft">Two agents ask for the same van.</span> …</h2>`, and likewise "How it works",
  "Dashboard", "Industries", "MCP, A2A and REST API", "Security", "Pricing", "Open source" and "FAQ".
  The labels add about 20 words. Consider a hero h1 that says the category, such as "The booking
  calendar for AI agents." The owner decides (D4).

**1.2 Docs titles, language and head (Starlight)**

- Starlight puts the `<title>` in `Astro.locals.starlightRoute.head` (checked in
  `node_modules/@astrojs/starlight/dist/utils/head.js`), so the existing middleware
  `site/src/routeData.ts` can rewrite it. There is no need to override Starlight's Head component.
- `site/src/content.config.ts`: extend `docsSchema()` with optional `seoTitle` (at most 60
  characters) and `ogImage`. `docs-src/*.md`: add `seoTitle` where the title is generic. The h1 and
  sidebar labels stay as they are. Drafts:

| Page | Title today | `seoTitle` |
| --- | --- | --- |
| `/docs/` | Introduction \| Slotlock | Slotlock docs: the booking engine for AI agents |
| `/docs/use-cases/` | Use cases \| Slotlock | Booking use cases: car rental, clinics, courts and more |
| `/docs/quickstart/` | Quickstart \| Slotlock | Quickstart: run Slotlock and let Claude Code book a slot |
| `/docs/connect/` | Connect an agent \| Slotlock | Connect an AI agent to Slotlock over MCP or A2A |
| `/docs/hosted/` | Hosted Slotlock \| Slotlock | Slotlock Cloud: hosted booking API, plans and limits |
| `/docs/self-host/` | Self-hosting \| Slotlock | Self-host Slotlock: open-source booking server on PostgreSQL |
| `/docs/booking-rules/` | Hours and booking rules \| Slotlock | Booking rules: notice, buffers, turnaround and hours |
| `/docs/recurring-events/` | Recurring events \| Slotlock | Recurring events with RRULE and time zones \| Slotlock |
| `/docs/external-calendars/` | External calendars \| Slotlock | Import external calendars as busy time (iCalendar) |
| `/docs/concepts/` | Concepts \| Slotlock | How Slotlock prevents double bookings: core concepts |
| `/docs/tools/` | Tools reference \| Slotlock | MCP tools reference: every slotlock_* tool |
| `/docs/api/` | REST API \| Slotlock | Booking REST API reference (OpenAPI) \| Slotlock |
| `/docs/library/` | TypeScript library \| Slotlock | TypeScript availability and booking library \| Slotlock |
| `/docs/security/` | Security model \| Slotlock | Security model: tenants, API keys and row-level security |
| `/docs/limits/`, `/docs/scaling/`, `/docs/operations/` | Limits, Scaling, Operations | Slotlock limits / Scaling Slotlock / Running Slotlock in production |

- `astro.config.mjs`: `locales: { root: { label: 'English', lang: 'en-GB' } }`. A root locale adds
  no URL prefix. The middleware rewrites `og:locale` to `en_GB`, the form Open Graph expects.
- Descriptions: keep each between 70 and 160 characters. The check in Part 4 enforces it.

**1.3 REST reference metadata** (`site/scripts/api-reference.mjs`)

- `description`: the operation's first sentence, cut at a word boundary to at most 155
  characters. The full text stays in the page body.
- Title: add the method and path, which developers search for, for example
  `Hold time: POST /v1/holds | Slotlock` (the path comes from `openapi.json`, so it cannot drift).

**1.4 Open Graph images**

- Start with static images in `site/public/og/`: `default.png`, `landing.png`, `docs.png` and one
  per Phase 2 page, each 1200 × 630 and under 300 KB. Draw them from the logo and colour tokens,
  with the page's title in large type.
- Generating one per docs page needs satori and resvg at build time. That adds dependencies to a
  site that avoids them; revisit if social sharing of docs pages matters.
- The middleware (1.2) adds `og:image`, `og:image:alt`, width, height and `twitter:image` to
  docs pages, from frontmatter `ogImage` or `docs.png`.
- `site/public/_headers`: `/og/*` gets `Cache-Control: public, max-age=86400`.
- Add `public/apple-touch-icon.png` (180 × 180) and link it. Google accepts the SVG favicon as it
  is.

**1.5 Structured data (JSON-LD)**

- Landing page: one `@graph` built in `site/src/lib/seo.ts` from `facts.json`, so prices and
  versions cannot drift. It holds:
  - `Organization`: Pylota, legal name TREFT LTD, `url`, `logo`, and `sameAs` the GitHub
    organization. The owner confirms which entity to name (D4).
  - `WebSite`: name "Slotlock", `url`, `publisher`.
  - `SoftwareApplication`: `applicationCategory` DeveloperApplication; `offers` built from
    `facts.plans` (Free $0, Developer, Team; USD; monthly price); `url`.
  - `SoftwareSourceCode`: `codeRepository`, `license`
    (`https://www.apache.org/licenses/LICENSE-2.0`), `programmingLanguage` TypeScript,
    `runtimePlatform` Node.js.
- No `aggregateRating` or `review`: there are none, and inventing them breaks Google's rules.
  Without them Google shows no Software App rich result. The markup still helps Google tell
  Slotlock apart from the other things with the name.
- Skip `FAQPage`: since 2023, Google shows FAQ rich results only for well-known government and
  health sites.
- Docs pages, from the middleware:
  - `TechArticle`: headline, description, `dateModified` from 1.7, and `publisher`.
  - `BreadcrumbList`: Home › Docs › section › page. Move `section()` from
    `src/components/docs/PageTitle.astro` to a shared lib so both use it.
- `site/scripts/postbuild.mjs`: the inline-script regex must skip
  `<script type="application/ld+json">`, both in the landing page's ban and in the hash list. A
  data block is not executed, so CSP does not apply to it, and the landing page stays free of
  inline code.
- Check with Google's Rich Results Test and validator.schema.org before merging.

**1.6 Markdown twins and agent files out of the index** (`site/public/_headers`)

- Give each twin a canonical header that points at its HTML page, using `_headers` placeholders:

  ```
  /index.md
    Link: <https://slotlock.pylota.io/>; rel="canonical"
  /docs/:page.md
    Link: <https://slotlock.pylota.io/docs/:page/>; rel="canonical"
  /docs/api/:route.md
    Link: <https://slotlock.pylota.io/docs/api/:route/>; rel="canonical"
  ```

  Check with `npm run preview:worker` and curl that Workers static assets fill in the placeholders.
  If they do not, use `X-Robots-Tag: noindex` on `/*.md` instead.
- `X-Robots-Tag: noindex` on `/llms*.txt`, `/openapi.json`, `/slotlock.postman_collection.json`,
  `/slotlock-setup-prompt.md` and `/schema/*`. Agents still fetch them; search results stop
  listing them.
- Watch the limits in `_headers`' own comment: 100 rules, 2,000 characters a line.

**1.7 Sitemap with `lastmod`**

- `astro.config.mjs`: add `@astrojs/sitemap` to `integrations` (it is already installed through
  Starlight). Starlight then skips its own copy: `dist/index.js` line 55 adds it only when it is
  absent. Use `filter` to drop `/404/`, and `serialize` to set `lastmod`. Do not set `changefreq`
  or `priority`; Google ignores them.
- `scripts/sync-content.mjs` knows which files each page is built from (`docs-src`, README
  sections, SPEC, CHANGELOG, `openapi.json`). It writes `src/generated/lastmod.json`, mapping each
  page path to the newest `git log -1 --format=%cI` among its inputs. The landing page uses
  `landing.ts`, `index.astro` and `facts.json`'s inputs.
- `.github/workflows/site.yml`: `fetch-depth: 0` on the build checkout. A shallow clone has one
  commit, which would give every page the same date.
- Docs `TechArticle.dateModified` (1.5) reads the same map.

**1.8 The 404 page**: in the middleware, when the route id is `404`, push
`<meta name="robots" content="noindex">` and remove the canonical and `og:url` entries.

**1.9 Contrast**: fix the lapsed hold label (`.block--lapsed .block__label` in
`src/styles/landing.css`), and add the pair to `scripts/contrast.mjs` so it stays fixed.

**1.10 CSP for analytics** (only if D3 keeps Cloudflare Web Analytics): add the two origins from
0.5 to `site/public/_headers`, and the sentence to PRIVACY.md beside "We use no analytics or
advertising cookies": the site counts visits with Cloudflare Web Analytics, which sets no cookie.

**Phase 1 is done when:**

- `npm run check` (contrast, copy, SEO) passes;
- the Rich Results Test finds Organization, SoftwareApplication and BreadcrumbList with no errors;
- a link pasted into Slack and LinkedIn previews with the image;
- after deploy, URL Inspection on `/`, `/docs/concepts/` and one `/docs/api/*` page shows the new
  title and canonical;
- the post-deploy smoke checks (Part 4) pass.

### Phase 2: pages for commercial intent

**Architecture.** Each page targets one cluster from Part 2, and goes in the main nav or the
footer of both the landing page and the docs, so every page passes it link equity.

| URL | Cluster | What it holds (all facts from `facts.json` or the docs) | JSON-LD |
| --- | --- | --- | --- |
| `/pricing/` | K1, K3 | The plans from `facts.plans`, the limits table from docs/hosted, the self-host plan, billing questions, "Start free" | `SoftwareApplication` with `offers` |
| `/mcp-server/` | K2 | What the MCP server does; the tool table (`facts.tools`, read or write); the MCP versions; setup for Claude Code, Cursor, VS Code and the Claude API (from docs/connect); the MCP App; the registry listing | `SoftwareApplication` |
| `/booking-api/` | K3, K5 | REST with OpenAPI and RFC 9457 refusals, A2A, idempotency, webhooks and CloudEvents, holds and pools, the clients for five languages, curl examples | `SoftwareApplication`, `WebAPI` |
| `/open-source/` | K7 | Apache-2.0, GOVERNANCE.md, the Docker image, the TypeScript library, the exclusion constraint, the race test, how to contribute | `SoftwareSourceCode` |
| `/use-cases/` and eight pages: `car-rental`, `equipment-hire`, `clinics`, `courts`, `garage-service-bays`, `salons-and-spas`, `rooms-and-desks`, `field-service` | K6 | Per vertical: the problem, how to model it (resources, pools, rules), what the agent calls in order, one example, the Pylota proof on car rental. Seeded from `docs-src/use-cases.md` and `industries` in `landing.ts`. | `WebPage`, `BreadcrumbList` |
| `/about/` | K1, trust | Who builds Slotlock (TREFT LTD, Pylota, MAINTAINERS.md), how to reach support and security, the licence and governance | `Organization`, `AboutPage` |

**Rules for these pages:**

- **Original pages, not templates.** Each use-case page needs its own substance: the rules that
  matter, the tool calls and the example for that business. Pages that differ only in a noun are
  "scaled content" under Google's spam policies, and can pull the whole site down. If a vertical
  has nothing of its own to say, it stays a section of `/use-cases/`.
- **Distinct from the docs.** `/use-cases/car-rental/` sells: why, what you get, proof, start
  free. `/docs/use-cases/#car-and-van-rental` teaches the modelling. They link to each other.
- **The site's existing pattern:**
  - Extract the header, footer and head from `index.astro` into `site/src/layouts/Marketing.astro`
    (using `SeoHead`). Diff `dist/index.html` before and after: only the head should change.
  - Put copy in `site/src/data/pages/<page>.ts`, beside `landing.ts`, reading numbers from
    `facts.json`.
  - Add a Markdown twin `<page>.md.ts` from the same data, with a shared helper factored out of
    `index.md.ts`.
  - Reuse `landing.css` components.
- **Nav and footer:** "Pricing" becomes `/pricing/`; add "Use cases", and keep the in-page anchors
  only for sections with no page. Add the new pages to the footer columns in `landing.ts`, and to
  the docs footer (`src/components/docs/Footer.astro`).
- **Agents:** list the new pages in `llms.txt`. Extend `markdownPageList()` in `astro.config.mjs`,
  or add them to `optionalLinks`.
- **Checks:**
  - `scripts/copy-lint.mjs` finds pages in `dist/` instead of the fixed `PAGES` list, and skips the
    legal and verbatim pages as today.
  - It gives each new page a word band: at least 500 words, so no page is thin, and at most 1,500.
  - It keeps the landing page's 1,300.
  - `scripts/postbuild.mjs` applies the no-inline-code rule to every non-Starlight page, not only
    `/index.html`.

**Phase 2 is done when** every page is in the sitemap, passes `check:seo` and the copy lint, has
an OG image and a twin, is linked from the nav or footer of both the landing page and the docs,
and is "URL is on Google" in URL Inspection.

### Phase 3: content

**The blog.** A content collection `site/src/content/blog/*.md` with schema `title`, `seoTitle`,
`description`, `date`, `updated`, `authors` and `tags`. Pages are `/blog/` and `/blog/<slug>/`.
Each post gets:

- `BlogPosting` JSON-LD, with the author as a `Person` and `sameAs` their GitHub;
- `/blog/rss.xml` (`@astrojs/rss`), a Markdown twin, and a place in `llms.txt` and the sitemap
  (`lastmod` = `updated`);
- a named author: posts written by named people are more credible to readers and to Google's
  quality raters.

**The first eight articles.** Each is grounded in code or tests in this repository and links the
docs page it deepens.

| # | Working title | Cluster | Source in the repository |
| --- | --- | --- | --- |
| 1 | Preventing double bookings with a PostgreSQL exclusion constraint | K4 | the schema, `core.integration.test.ts` (the race), SQLSTATE 23P01, half-open `tstzrange` |
| 2 | Why AI agents double-book, and what the calendar has to do about it | K4, K3 | the read-then-insert race, retries, idempotent writes |
| 3 | Holds: keep a slot while a person decides | K5 | hold groups (up to `facts.holdSlotsMax`), expiry on the database clock |
| 4 | Designing booking tools for LLM agents over MCP | K2 | `src/agent-server.ts` tool schemas, refusals as data |
| 5 | Time zones and daylight saving in availability | K9 | rules on each resource's clock; the 0.2 known issue, told plainly |
| 6 | Unproven time: why a stale calendar feed must not read as free | K5 | coverage and certainty, `requireCertain` |
| 7 | Car rental availability for AI agents (with Pylota) | K6 | pools, turnaround, marketplace feeds; Pylota's numbers, with their permission |
| 8 | How fast Slotlock answers availability | K5 | `bench/`, the latest release's `bench.json` |

Publish two a month for the first three months. Article 1 is the one most likely to earn links:
submit it to Postgres Weekly and post it on DEV.to with `rel=canonical` pointing back.

**Comparison pages.** `/compare/` with:

- `/compare/diy/`, "A bookings table and a cron job": this is the landing page's compare table,
  expanded, and names no third party, so it ships first;
- then `/compare/cal-com/`, `/compare/cronofy/`, `/compare/nylas/`,
  `/compare/google-calendar-api/` and `/compare/librebooking/`.

Each comparison is fair and sourced. It says when to choose the other product, shows a capability
table with links to their docs, and carries a "last checked" date. The owner approved naming
companies (D5); a claim about another product links the page it comes from, and is checked again
when the date is a quarter old.

### Phase 4: authority and distribution

The site needs links from places Google trusts. In order of value for effort:

1. **pylota.io.** A link from Pylota's site with descriptive text ("bookings checked by Slotlock,
   the booking engine for AI agents"), and a case-study page or post (article 7).
2. **MCP directories.**
   - Confirm the official MCP Registry entry is live (`mcp-registry.yml` publishes `server.json`).
   - List on glama.ai, mcp.so, Smithery, PulseMCP and mcpservers.org.
   - Open a pull request to the awesome-mcp-servers list.
   - These listings rank for K2 themselves.
3. **Package registries.**
   - Add a documentation URL beside each homepage: PyPI `Documentation`, Cargo `documentation`,
     NuGet README, and the Maven POM `url`, pointing at the right `/docs/clients/#…` anchor.
   - Add `org.opencontainers.image.url` and `.documentation` labels to the Docker image.
4. **GitHub.** Link the site's pages from the top of README.md with descriptive anchor text. Link
   `/docs/changelog/` from release notes.
5. **Launches**, each with a clear, true claim:
   - a Show HN, "a calendar AI agents cannot double-book";
   - r/PostgreSQL (article 1) and r/mcp;
   - Product Hunt for Slotlock Cloud once the paid plans are live.
6. **Writing elsewhere.** Guest posts on agent frameworks' blogs, and talks at Postgres and AI
   meetups, each linking a docs page.

Do not buy links or take part in link schemes.

### Phase 5: measure and iterate

- **Weekly for the first month, then monthly:**
  - Search Console's Pages report: indexed against the sitemap; fix every "Crawled, not indexed"
    and "Duplicate" entry;
  - its Performance report, filtered by a regex for each cluster;
  - Core Web Vitals once there is enough traffic.
- **Signals of success:** Cloudflare Web Analytics for visits and referrers, if kept (D3), and
  sign-ins on the dashboard that arrive from the site's Referer.
- **Targets.** These are goals, not promises: a new site on a shared name ranks slowly, and
  generic head terms may take a year or never come.
  - Month 1: every sitemap URL indexed; first place for "slotlock mcp", "slotlock booking" and
    "slotlock pricing", with sitelinks.
  - Month 3: top 10 for two or more K2 queries; article 1 in the top 20 for its query.
  - Month 6: organic search is a top-three source of dashboard sign-ups.
- **Iterate:**
  - For pages with impressions but a click-through rate under 2 %, rewrite the title and
    description.
  - Pages in positions 8 to 20 get depth and internal links.
  - Refresh articles when the code they describe changes. Change `updated` only then.

## Part 4: Guardrails

**`site/scripts/seo-check.mjs`**, run as `npm run check:seo` after the build and added to
`npm run check` (so `site.yml` runs it on every pull request). It fails on any of these.

Every HTML page except the 404:

- one `<title>`, at most 65 characters, unique across the site;
- one meta description, 70 to 160 characters, unique;
- a canonical that is absolute, `https://slotlock.pylota.io`, with a trailing slash, equal to the
  page's own URL, and present in the sitemap;
- exactly one h1, and `<html lang="en-GB">`;
- `og:title`, `og:description` and `og:url` (equal to the canonical), plus `og:image` naming a
  file in `dist/` that is a 1200 × 630 PNG (read from its IHDR), and `twitter:card`;
- every `application/ld+json` block parses, has `@context` `https://schema.org`, and uses only
  allowed `@type`s; any `offers.price` equals `facts.plans`;
- no `noindex`.

The 404 page has `noindex` and no canonical.

The sitemap equals the set of indexable pages, and has no `.md` files, no `/404/` and only valid
ISO `lastmod` dates.

`_headers` has the twin canonical (or noindex) rules and the agent-file noindex rules.

Internal links: none broken, none without the trailing slash. Today's result is clean (1.1), and
this keeps it that way.

**After each deploy** (a new step in the `deploy` job of `site.yml`, using curl):

- `http://` gives 301 to `https://`;
- `/robots.txt` names the sitemap and has no `Disallow: /` for `*`;
- `/sitemap-index.xml` is 200 XML;
- `/docs/quickstart.md` carries its `Link` canonical;
- an unknown path gives 404;
- `app.slotlock.` and `slotlock-api.` send `X-Robots-Tag: noindex`.

**Optional:** Lighthouse CI on pull requests against `npm run preview:worker`, with budgets of
SEO 100, performance at least 95 and accessibility at least 95. It adds about two minutes to the
job.

## Part 5: Decisions for the owner

| # | Decision | Recommendation | Owner's decision (2026-11-11) |
| --- | --- | --- | --- |
| D1 | Domain: stay on `slotlock.pylota.io` or move to a domain of its own | Decide before Phase 2, because a move later means redirects and lost time. The name is shared with a Minecraft mod and a registered SLOTLOCK word mark, which is worth a check against TRADEMARKS.md with counsel. | Stay on `slotlock.pylota.io` |
| D2 | AI crawlers on this host: keep Cloudflare's blocks on GPTBot, ClaudeBot, Google-Extended and the rest, or allow them | Allow on `slotlock.pylota.io`. The code is open and on GitHub, and models that have read the docs can recommend Slotlock. | Allow. `site/public/robots.txt` says so; the owner turns off Cloudflare's managed robots.txt (0.4). |
| D3 | Analytics | Allow Cloudflare Web Analytics through the CSP (cookieless; one line in PRIVACY.md) | Allow. Done in `_headers` and PRIVACY.md. |
| D4 | Landing copy: title, description, h1, topic labels in the h2s, and the entity named in Organization data | Use the drafts in 1.1 and 1.5 | Use the drafts |
| D5 | Naming competitors in `/compare/*` | Ship `/compare/diy/` first | Name them, with sources and a "last checked" date on each page |
| D6 | Pylota: a link from pylota.io, and a case study with numbers | Yes | Yes. The case study is on the blog; the link from pylota.io is a change in PILOTAAI/pylota. |
| D7 | Blog authors | Named maintainers, with GitHub profiles | Open: posts are signed by the Slotlock maintainers until a person is named |

## Part 6: Risks and non-goals

- **Copy rules still apply.** No em dash, none of the banned words, and numbers from
  `facts.json`. New pages go through `check:copy`, so marketing pages cannot drift from the code.
- **The CSP stays strict.** JSON-LD is data, not script. The only CSP change is the analytics
  origins, if D3 says so.
- **No invented signals:** no fake reviews or ratings, no keyword stuffing, no doorway pages per
  city or per keyword.
- **Non-goals:** paid search, other languages (later, if a market asks for one), and a docs
  search box. Pagefind is off by design, and search engines do not need it.
- **Rankings are not guaranteed.** Phases 0 and 1 make the site indexable and understood. Phases
  2 to 4 are what make it rank.

## Order of work

1. Phase 0, items 0.1 to 0.8 (owner, about 30 minutes). Do 0.1 first: Search Console needs days
   to show data. Do 0.3, 0.4 and 0.6 before the deploy of this change, so the post-deploy checks
   pass.
2. Phases 1 to 3, and the registry metadata of Phase 4: one pull request from
   `claude/serene-sagan-4n2tr6`. Merging deploys it.
3. After the deploy: submit the sitemap again, and request indexing of `/`, `/pricing/`,
   `/mcp-server/` and `/booking-api/` in URL Inspection.
4. Phase 4 submissions (an afternoon): pylota.io, the MCP directories, the launch posts.
5. Phase 3 cadence: two articles a month.
6. Phase 5 from the first week after Phase 0.

## Implementation (2026-11-11)

Built on `claude/serene-sagan-4n2tr6`. `npm run build && npm run check` passes: 179 pages, 178 in
the sitemap, each with a `lastmod`, 28 Open Graph images, and no copy, contrast or SEO findings.

| Item | Where | Notes |
| --- | --- | --- |
| 1.1 Landing head, topic labels | `site/src/layouts/Marketing.astro`, `site/src/components/seo/SeoHead.astro`, `site/src/data/landing.ts` | The landing page's word limit is 1,350 (was 1,300) for the labels and the new footer links |
| 1.2 Docs titles, en-GB | `site/src/routeData.ts`, `site/src/content.config.ts`, `seoTitle` in 22 `docs-src` pages | |
| 1.3 REST reference | `site/scripts/api-reference.mjs` | Title with method and path; the full description stays the lede, and `seoDescription` is the result's |
| 1.4 Open Graph images | `site/scripts/og-images.mjs` (`npm run og`), `site/public/og/` | Drawn with Chromium and committed, as the fonts are; no build dependency |
| 1.5 JSON-LD | `site/src/lib/seo.ts` | Prices from `facts.plans`; `seo-check.mjs` fails on a mismatch |
| 1.6 Twins out of the index | `site/public/_headers` | Placeholders checked with `wrangler dev`: every twin names its page as canonical |
| 1.7 Sitemap `lastmod` | `site/scripts/sync-content.mjs`, `astro.config.mjs`, `site.yml` (`fetch-depth: 0`) | A file with uncommitted changes dates from the build |
| 1.8 404 | `site/src/routeData.ts` | |
| 1.9 Contrast | `site/src/styles/landing.css` | The lapsed hold fades its fill, not its label |
| 1.10 Analytics | `site/public/_headers`, PRIVACY.md | |
| Part 4 checks | `site/scripts/seo-check.mjs`, `scripts/check-live-seo.sh` | The live check fails on what the repository controls and warns on Cloudflare settings |
| Phase 2 pages | `site/src/data/pages/`, `site/src/components/marketing/Page.astro` | Copy lint covers every page; each has at least 400 words of prose |
| Phase 3 | `site/src/data/blog.ts`, `site/src/pages/blog/`, `site/src/data/pages/compare.ts`, `competitors.ts` | Posts are data, not a Markdown collection: Expressive Code would add inline styles the strict CSP refuses on these pages. Four posts: the exclusion constraint, why agents double-book, holds, and the Pylota case study (without numbers until Pylota gives them) |
| Phase 4 | README.md, `clients/python/pyproject.toml`, Dockerfile | Links to the new pages; a documentation URL on PyPI and on the image |

Still the owner's, in Cloudflare and elsewhere (Phase 0 and 4). `scripts/check-live-seo.sh`
warns until the first four are done:

1. Turn on **Always Use HTTPS** for the pylota.io zone, or a redirect rule for this host (0.3).
2. Turn off Cloudflare's **managed robots.txt** for this host (0.4, D2).
3. Add `X-Robots-Tag: noindex` to `app.slotlock.pylota.io` and `slotlock-api.pylota.io` with a
   Transform Rule (0.6).
4. Leave Cloudflare Web Analytics' automatic setup on for this host (D3); the CSP now allows it.
5. Search Console (Domain property for pylota.io) and Bing Webmaster Tools; submit the sitemap
   after the deploy (0.1, 0.2). Turn on Crawler Hints.
6. Keyword Planner volumes for Part 2 (0.7); the GitHub social preview and topics (0.8).
7. The link from pylota.io to slotlock.pylota.io (PILOTAAI/pylota), and Pylota's numbers for the
   case study (D6).
8. The MCP directories and launch posts (Phase 4).
