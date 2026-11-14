// The blog as the site builds it (site/src/lib/posts.ts, post-format.ts, scripts/postbuild.mjs): a copy
// of the site with one fixture post that uses every format a post can carry (fixtures/blog/), built
// with `npm run build` as CI builds it, and the post's page read back. Then, in Chromium, the built
// page under the CSP that dist/_headers gives it: every picture decodes, both videos load their
// metadata through worker/range.mjs, the players' frames are allowed, and nothing is refused. Last,
// the build refuses a file whose bytes are not what its name says.
//
// Needs the site's own dependencies (site/node_modules, `npm ci` in site/); skipped without them, as
// in the package's CI job, which does not install them. The browser part needs Playwright
// (require('playwright')) and saves site-post-rich.png to SLOTLOCK_SITE_SHOTS (a temporary
// directory otherwise).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST_EMBED_ORIGINS } from '../../site/src/lib/post-format.js';
import rangeWorker from '../../site/worker/range.mjs';

const root = join(import.meta.dirname, '..', '..');
const site = join(root, 'site');
const fixtures = join(import.meta.dirname, 'fixtures', 'blog');
const SLUG = 'a-tour-of-post-formats';
const hasSite = existsSync(join(site, 'node_modules', 'astro', 'package.json'));
const require_ = createRequire(import.meta.url);

interface PwRoute {
  request(): { url(): string; method(): string; headers(): Record<string, string> };
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}
interface PwPage {
  route(match: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  goto(target: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(script: string): Promise<T>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
}
interface PwBrowser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: 'dark' | 'light'; deviceScaleFactor: number; reducedMotion?: 'reduce' }): Promise<{
    newPage(): Promise<PwPage>;
    addInitScript(script: { content: string }): Promise<void>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}
let chromium: { launch(): Promise<PwBrowser> } | null = null;
try {
  chromium = (require_('playwright') as { chromium: { launch(): Promise<PwBrowser> } }).chromium;
} catch {
  chromium = null;
}
const SHOTS = process.env.SLOTLOCK_SITE_SHOTS?.trim() || join(tmpdir(), 'slotlock-site-shots');

/**
 * The site in a directory of its own beside links to the rest of the repository, so its build reads
 * the repository as CI's does and changes nothing in it: its node_modules is a link to the site's, and
 * Astro's cache, there by default (node_modules/.astro), is moved into the copy. The copy sits in
 * node_modules/.cache, not the system's temporary directory: Vite cannot build a root whose way to
 * its node_modules climbs to the filesystem's root ("No cached compile metadata found").
 */
function siteCopy(): string {
  const cache = join(root, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const top = mkdtempSync(join(cache, 'slotlock-site-'));
  for (const entry of readdirSync(root)) {
    if (entry === 'site' || entry === '.git') continue;
    symlinkSync(join(root, entry), join(top, entry));
  }
  const skip = new Set(['node_modules', 'dist', '.astro', '.wrangler'].map((name) => join(site, name)));
  cpSync(site, join(top, 'site'), { recursive: true, filter: (source) => !skip.has(source) });
  symlinkSync(join(site, 'node_modules'), join(top, 'site', 'node_modules'));
  const config = join(top, 'site', 'astro.config.mjs');
  const text = readFileSync(config, 'utf8');
  expect(text).toContain('export default defineConfig({');
  writeFileSync(config, text.replace('export default defineConfig({', "export default defineConfig({ cacheDir: './.cache/astro',"));
  cpSync(join(fixtures, `${SLUG}.md`), join(top, 'site', 'content', 'blog', `${SLUG}.md`));
  cpSync(join(fixtures, SLUG), join(top, 'site', 'public', 'blog', SLUG), { recursive: true });
  return top;
}

const build = (top: string) =>
  spawnSync('npm', ['run', 'build'], {
    cwd: join(top, 'site'),
    encoding: 'utf8',
    timeout: 300_000,
    // Outside Actions, the benchmarks page falls back to the baseline if GitHub cannot be reached.
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });

describe.skipIf(!hasSite)('the site builds a post in every format (Astro, real build)', () => {
  let top = '';
  let dist = '';
  let page = '';

  beforeAll(() => {
    top = siteCopy();
    dist = join(top, 'site', 'dist');
    const result = build(top);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    page = readFileSync(join(dist, 'blog', SLUG, 'index.html'), 'utf8');
  }, 320_000);

  afterAll(() => {
    if (top) rmSync(top, { recursive: true, force: true });
  });

  it('renders each format as the article styles expect', () => {
    const file = (name: string) => `/blog/${SLUG}/${name}`;
    // Pictures, with alt text, lazily, and a caption where the post gives one.
    expect(page).toContain(`<figure><img src="${file('calendar-week.png')}" alt="A week calendar for van 3 with one slot held by an agent for thirty seconds" loading="lazy" decoding="async"><figcaption>The calendar an agent reads, with one hold.</figcaption></figure>`);
    for (const name of ['hold-expires.gif', 'van-at-dawn.jpg', 'how-a-hold-works.webp', 'double-bookings-chart.avif']) expect(page).toContain(`<img src="${file(name)}"`);
    // Videos with their controls, named by their alt text.
    expect(page).toContain(`<figure><video src="${file('hold-to-booking.mp4')}" controls preload="metadata" playsinline aria-label="The hold counting down and the slot turning booked"></video><figcaption>Thirty seconds of a hold, sped up.</figcaption></figure>`);
    expect(page).toContain(`<video src="${file('hold-to-booking.webm')}" controls preload="metadata" playsinline aria-label="The same hold, in WebM"></video>`);
    // The players: privacy-enhanced, lazy, sandboxed, titled, and from the two hosts alone.
    const frames = [...page.matchAll(/<iframe ([^>]*)><\/iframe>/g)].map((match) => match[1] as string);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('src="https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=65" title="Holds that wait for a person, the talk"');
    expect(frames[1]).toContain('src="https://player.vimeo.com/video/76979871?dnt=1" title="Holds that wait for a person, on Vimeo"');
    for (const frame of frames) {
      expect(frame).toContain('loading="lazy"');
      expect(frame).toContain('referrerpolicy="strict-origin-when-cross-origin"');
      expect(frame).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"');
    }
    // A divider, a table in its own sideways-scrolling region, code, a quote, lists and a PDF to download.
    expect(page).toContain('<hr>');
    expect(page).toContain('<div class="table-scroll" role="region" aria-label="Table: Approach, Double bookings, Where it is checked, What the agent is told" tabindex="0"><table><thead>');
    expect(page).toContain('<td><code>slot_taken</code>, with the next free time</td>');
    expect(page).toContain('<figcaption class="post-meta">The constraint that keeps one owner per slot</figcaption><pre><code class="language-sql">');
    expect(page).toContain('during WITH &amp;&amp;);');
    expect(page).toContain('<blockquote><p>A hold is a promise with an end');
    expect(page).toContain(`<a href="${file('holds-talk-slides.pdf')}" type="application/pdf" download>the talk&#39;s slides (PDF)</a>`);
    // The facts are filled in.
    expect(page).not.toContain('{{facts.');
  });

  it('ships the post’s files as they were, and a CSP that lets in its videos and its two players only', () => {
    for (const name of readdirSync(join(fixtures, SLUG))) {
      expect(readFileSync(join(dist, 'blog', SLUG, name)).equals(readFileSync(join(fixtures, SLUG, name))), name).toBe(true);
    }
    const policy = /Content-Security-Policy: ([^\n]+)/.exec(readFileSync(join(dist, '_headers'), 'utf8'))?.[1] ?? '';
    expect(policy).toContain("media-src 'self';");
    expect(/frame-src ([^;]+);/.exec(policy)?.[1]?.split(' ')).toEqual([...POST_EMBED_ORIGINS]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    // The Markdown twin keeps the post's Markdown, with its files at absolute addresses.
    const twin = readFileSync(join(dist, 'blog', `${SLUG}.md`), 'utf8');
    expect(twin).toContain(`](https://slotlock.pylota.io/blog/${SLUG}/hold-to-booking.mp4 "Thirty seconds of a hold, sped up.")`);
  });

  it('shows every format in a browser under that CSP, with nothing refused', async (context) => {
    if (!chromium) context.skip();
    const policy = /Content-Security-Policy: ([^\n]+)/.exec(readFileSync(join(dist, '_headers'), 'utf8'))?.[1] ?? '';
    const browser = await (chromium as { launch(): Promise<PwBrowser> }).launch();
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2, reducedMotion: 'reduce' });
      await browserContext.addInitScript({ content: "window.__refused = []; document.addEventListener('securitypolicyviolation', (event) => window.__refused.push(event.violatedDirective + ' ' + event.blockedURI));" });
      const tab = await browserContext.newPage();
      const ranges: string[] = [];
      // The site as Workers serves it: dist's files with _headers' CSP, and a post's videos through
      // worker/range.mjs, as wrangler.jsonc's run_worker_first sends them.
      const assets = {
        async fetch(request: Request): Promise<Response> {
          const path = decodeURIComponent(new URL(request.url).pathname);
          const target = join(dist, path.endsWith('/') ? `${path}index.html` : path);
          if (!existsSync(target)) return new Response('Not found', { status: 404 });
          const bytes = readFileSync(target);
          const type = /\.mp4$/.test(path) ? 'video/mp4' : /\.webm$/.test(path) ? 'video/webm' : 'application/octet-stream';
          return new Response(new Uint8Array(bytes), { headers: { 'content-type': type, 'content-length': String(bytes.length), etag: '"v1"', 'content-security-policy': policy } });
        },
      };
      const types: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', svg: 'image/svg+xml', woff2: 'font/woff2', pdf: 'application/pdf', ico: 'image/x-icon' };
      await tab.route('**/*', async (route) => {
        const asked = new URL(route.request().url());
        if (asked.origin !== 'https://slotlock.pylota.io') {
          // The players cannot load here; a plain stand-in shows where each sits.
          const player = (POST_EMBED_ORIGINS as readonly string[]).includes(asked.origin);
          await route.fulfill({
            status: player ? 200 : 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: Buffer.from(player ? `<!doctype html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#bbb;font:15px system-ui">${asked.hostname} player (not loaded in this offline render)</body>` : ''),
          });
          return;
        }
        if (/^\/blog\/[^/]+\/[^/]+\.(?:mp4|webm)$/.test(asked.pathname)) {
          const headers = route.request().headers();
          if (headers.range) ranges.push(headers.range);
          const answer = await rangeWorker.fetch(new Request(asked.href, { headers: headers.range ? { range: headers.range } : {} }), { ASSETS: assets });
          const out: Record<string, string> = {};
          answer.headers.forEach((value, name) => {
            out[name] = value;
          });
          await route.fulfill({ status: answer.status, headers: out, body: Buffer.from(await answer.arrayBuffer()) });
          return;
        }
        const path = asked.pathname.endsWith('/') ? `${asked.pathname}index.html` : asked.pathname;
        const target = join(dist, decodeURIComponent(path));
        if (!existsSync(target)) {
          await route.fulfill({ status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') });
          return;
        }
        await route.fulfill({ status: 200, headers: { 'content-type': types[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream', 'content-security-policy': policy }, body: readFileSync(target) });
      });
      await tab.goto(`https://slotlock.pylota.io/blog/${SLUG}/`, { waitUntil: 'load' });
      // Scroll the whole page into view, so the lazy pictures and frames load before the checks.
      await tab.evaluate(`(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
        for (const frame of document.querySelectorAll('iframe')) {
          frame.scrollIntoView();
          await new Promise((r) => { frame.addEventListener('load', r, { once: true }); setTimeout(r, 3000); });
        }
        window.scrollTo(0, 0);
      })()`);
      const found = await tab.evaluate<{ images: [string, number][]; videos: [string, number][]; frames: number; refused: string[]; overflow: number }>(`(async () => {
        const article = document.querySelector('.article');
        const images = [...article.querySelectorAll('img')];
        await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
        const videos = [...article.querySelectorAll('video')];
        await Promise.all(videos.map((video) => video.readyState >= 1 ? null : new Promise((resolve) => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 5000); })));
        return {
          images: images.map((image) => [image.getAttribute('src'), image.naturalWidth]),
          videos: videos.map((video) => [video.getAttribute('src'), video.readyState]),
          frames: article.querySelectorAll('iframe').length,
          refused: window.__refused,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()`);
      expect(found.images.map(([src]) => src?.slice(src.lastIndexOf('.') + 1))).toEqual(['png', 'gif', 'jpg', 'webp', 'avif']);
      for (const [src, width] of found.images) expect(width, `${src} decoded`).toBeGreaterThan(0);
      for (const [src, ready] of found.videos) expect(ready, `${src} loaded its metadata`).toBeGreaterThanOrEqual(1);
      expect(found.videos).toHaveLength(2);
      expect(ranges.length).toBeGreaterThan(0);
      expect(found.frames).toBe(2);
      expect(found.refused).toEqual([]);
      expect(found.overflow).toBeLessThanOrEqual(0);
      mkdirSync(SHOTS, { recursive: true });
      // The whole page in one viewport rather than a full-page capture, which leaves the players' frames blank.
      await tab.setViewportSize({ width: 1440, height: await tab.evaluate<number>('document.documentElement.scrollHeight') });
      await tab.evaluate('new Promise((resolve) => setTimeout(resolve, 500))');
      await tab.screenshot({ path: join(SHOTS, 'site-post-rich.png') });
      await browserContext.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('fails the build on a file that is not what its name says, before any page is written', () => {
    writeFileSync(join(top, 'site', 'public', 'blog', SLUG, 'sneaky.png'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const result = build(top);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`public/blog/${SLUG}/: sneaky.png: its bytes are not a PNG, JPEG, WebP, AVIF or GIF picture, an MP4 or WebM video, or a PDF`);
  }, 320_000);
});
