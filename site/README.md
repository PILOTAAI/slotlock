# slotlock.pylota.io

The landing page and the docs, built with Astro and Starlight and served by one assets-only
Cloudflare Worker (`wrangler.jsonc`: no Worker script, no bindings). This directory is its own npm
project, not a workspace of the package at the repository root.

```
site/
  astro.config.mjs        Starlight config, llms.txt plugin, sidebar
  docs-src/*.md           docs pages; <!-- include README.md#section --> pulls text from the repo
  src/data/landing.ts     every sentence on the landing page (the page and /index.md share it)
  src/pages/index.astro   the landing page; index.md.ts its Markdown twin
  src/pages/docs/[...slug].md.ts   a Markdown twin of every docs page
  src/styles/tokens.mjs   colour tokens (Pylota's, after PR #505), light and dark
  scripts/sync-content.mjs  builds docs pages and src/generated/facts.json from README, SPEC,
                            SECURITY, CHANGELOG and src/*.ts; fails if a fact moved
  scripts/postbuild.mjs   pins the CSP in dist/_headers to the hashes of Starlight's inline code
  scripts/contrast.mjs    WCAG AA check of every text/background pair, both themes
  scripts/copy-lint.mjs   Pylota's voice rules (no em dash, no filler words) and the word count
  scripts/subset-fonts.sh rebuilds public/fonts from the OFL sources
  public/_headers         CSP, HSTS, caching, Markdown content types
```

Tool names, versions, limits, the exclusion constraint and the README quick start are read from the
repository on every build, so the site cannot claim something the code does not do. Generated files
(`src/content/docs/`, `src/generated/`, `public/schema/`) are git-ignored.

## Work on it

Node.js 22.12 or newer.

```sh
npm ci
npm run dev            # http://localhost:4321
npm run build          # dist/, then the CSP pinning
npm run check          # contrast and copy lint (after a build)
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
2. Create a GitHub environment named `site` (Settings, Environments), limited to the `main` branch.
3. Add two secrets to it:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token with **Account › Workers Scripts › Edit**, and **Zone (pylota.io only) › Workers Routes › Edit** and **DNS › Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that holds the `pylota.io` zone |

Then run the workflow on `main` and check https://slotlock.pylota.io.

By hand, from this directory: `npm ci && npm run build && npm run deploy`.
