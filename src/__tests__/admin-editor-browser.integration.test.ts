// The admin console's post editor in a real browser (Chromium, through Playwright), against real
// PostgreSQL and the fake GitHub (helpers/fake-github-repo.ts): an Editor pastes a screenshot, makes a
// word bold from the keyboard, inserts a table from the toolbar, uploads a GIF and a video, embeds a
// YouTube video, inserts a file again from the Media panel, sees each in the live preview under the
// console's CSP with nothing refused, and saves the draft. The commit on cms/<slug> holds the post
// and its files. The page passes axe-core with no serious or critical violation.
//
// Screenshots for the owner (1440 wide, dark, twice the pixels) go to SLOTLOCK_EDITOR_SHOTS (a
// temporary directory otherwise): the post list, the editor with a rich post, the Media panel, and the
// SEO and link card tabs. Needs DATABASE_URL and Playwright with its Chromium (require('playwright'));
// skipped without either.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePost } from '../../site/src/lib/post-format.js';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha } from './helpers/admin-browser.js';
import { FAKE_APP_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, type FakeGithubRepo, createFakeGithubRepo } from './helpers/fake-github-repo.js';

const url = process.env.DATABASE_URL?.trim();
const require_ = createRequire(import.meta.url);

interface PwRoute {
  request(): { url(): string; method(): string; headers(): Record<string, string>; postDataBuffer(): Buffer | null };
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}
interface PwLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(options?: { state?: 'visible' | 'hidden' | 'attached' }): Promise<void>;
  setInputFiles(files: string | string[]): Promise<void>;
  inputValue(): Promise<string>;
  count(): Promise<number>;
  first(): PwLocator;
}
interface PwPage {
  route(match: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  goto(target: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(script: string): Promise<T>;
  locator(selector: string): PwLocator;
  waitForURL(match: string | RegExp): Promise<void>;
  waitForEvent(event: 'filechooser'): Promise<{ isMultiple(): boolean }>;
  keyboard: { press(key: string): Promise<void> };
  on(event: 'dialog', handler: (dialog: { accept(): Promise<void> }) => void): void;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  url(): string;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(script: { content: string }): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: 'dark' | 'light'; deviceScaleFactor: number; reducedMotion?: 'reduce' }): Promise<PwContext>;
  close(): Promise<void>;
}
let chromium: { launch(): Promise<PwBrowser> } | null = null;
try {
  chromium = (require_('playwright') as { chromium: { launch(): Promise<PwBrowser> } }).chromium;
} catch {
  chromium = null;
}

const SHOTS = process.env.SLOTLOCK_EDITOR_SHOTS?.trim() || join(tmpdir(), 'slotlock-editor-shots');
const SITE = 'https://site.slotlock.test';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'blog', 'a-tour-of-post-formats');
const SLUG = 'pasting-screenshots-into-posts';
const EMBED_HOSTS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];

describe.skipIf(!url || !chromium)('the post editor in a browser: paste, toolbar, uploads, preview and save (real Postgres, fake GitHub)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_editor_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let repo: FakeGithubRepo;
  let browser: PwBrowser | null = null;
  const clock = Date.now();
  const editor = new Browser(() => admin);

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
    await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      const store = createSlotlockStore(tx);
      await store.applySchema();
      await store.applyTenantRls();
      await store.grantAdminRole(adminRole);
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1004', 'editor', 'cli:ops', ${sha('editor-code')}, ${new Date(clock + 86_400_000)})`;
    });
    adminSql = postgres(Object.assign(new URL(target.href), { username: adminRole, password }).href, { max: 4, onnotice: () => undefined });
    repo = createFakeGithubRepo(
      Object.fromEntries(
        ['why-ai-agents-double-book', 'holds-keep-a-slot-while-a-person-decides', 'introducing-slotlock', 'postgresql-exclusion-constraint-double-booking'].map((slug) => [
          `site/content/blog/${slug}.md`,
          readFileSync(`site/content/blog/${slug}.md`, 'utf8'),
        ]).concat([
          ['site/src/data/authors.json', readFileSync('site/src/data/authors.json', 'utf8')],
          ['site/public/_redirects', readFileSync('site/public/_redirects', 'utf8')],
        ]),
      ),
      { now: () => clock },
    );
    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
      consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request: Request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch({ 'code-editor': { id: 1004, login: 'lea-moreau' } }, {}, async (input, init) => {
        const asked = new URL(String(input instanceof Request ? input.url : input));
        if (asked.hostname === 'api.github.com' && (/^\/(repos|app)\//.test(asked.pathname) || asked.pathname === '/graphql')) return repo.fetch(input, init);
        if (asked.origin === SITE && asked.pathname === '/sitemap-0.xml') {
          return new Response(`<urlset>${['/', '/docs/', '/docs/concepts/', '/blog/'].map((path) => `<url><loc>${SITE}${path}</loc></url>`).join('')}</urlset>`);
        }
        if (asked.origin === SITE && asked.pathname === '/facts.json') return new Response('{"version":"0.11.0"}');
        return null;
      }),
      now: () => clock,
      cms: { appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, siteUrl: SITE },
    });
    expect((await editor.signIn('code-editor')).headers.get('location')).toBe('/passkey');
    expect((await editor.createPasskey(new SoftwarePasskey(), { code: 'editor-code' })).status).toBe(200);
    // The draft the editor opens: saved once, so its files have a branch to go to.
    const page = await (await editor.request('/content/new')).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    const saved = await editor.request('/content/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf, head: '', slug: SLUG, intent: 'save', title: 'Paste a screenshot straight into a post',
        seoTitle: '', description: 'How the console’s editor takes a pasted screenshot, a GIF or a video, asks for its alt text and puts it where you were typing.',
        date: new Date(clock).toISOString().slice(0, 10), updated: '', publishAt: '', author: 'maintainers', tags: 'writing, editor', eyebrow: 'Guide',
        imageAlt: 'The post editor with a screenshot in its preview.', related: 'Holds | /docs/concepts/',
        body: '## Why screenshots belong in the post\n\nA reader follows a booking flow faster with the calendar in front of them than with a description of it.\n',
      }).toString(),
    });
    expect(saved.status).toBe(303);
    mkdirSync(SHOTS, { recursive: true });
    try {
      browser = await (chromium as { launch(): Promise<PwBrowser> }).launch();
    } catch (error) {
      console.warn('Chromium did not start; the browser checks are skipped:', (error as Error).message);
      browser = null;
    }
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  /** A tab whose every request goes to the console as the signed-in Editor: method, body and the headers that matter. */
  async function open(height = 900) {
    const context = await (browser as PwBrowser).newContext({ viewport: { width: 1440, height }, colorScheme: 'dark', deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await context.addInitScript({ content: "window.__refused = []; document.addEventListener('securitypolicyviolation', (event) => window.__refused.push(event.violatedDirective + ' ' + event.blockedURI));" });
    const tab = await context.newPage();
    tab.on('dialog', (dialog) => void dialog.accept());
    await tab.route('**/*', async (route) => {
      const request = route.request();
      const asked = new URL(request.url());
      if (asked.origin !== ORIGIN) {
        // The players cannot load here: a plain stand-in shows where each sits.
        const player = EMBED_HOSTS.includes(asked.origin);
        await route.fulfill({
          status: player ? 200 : 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: Buffer.from(player ? `<!doctype html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#bbb;font:13px system-ui">${asked.hostname} player (not loaded in this test)</body>` : ''),
        });
        return;
      }
      const sent = request.headers();
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'accept', 'x-slotlock-admin', 'range', 'if-range']) if (sent[name]) headers[name] = sent[name] as string;
      const body = request.postDataBuffer();
      if (body) headers['content-length'] = String(body.length);
      let response = await editor.request(`${asked.pathname}${asked.search}`, { method: request.method(), headers, ...(body ? { body: new Uint8Array(body) } : {}) });
      // A form's redirect is followed here: Chromium does not follow a redirect fulfilled for a POST navigation.
      if (response.status === 303 && response.headers.get('location')) response = await editor.request(response.headers.get('location') as string);
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') out[name] = value;
      });
      await route.fulfill({ status: response.status, headers: out, body: Buffer.from(await response.arrayBuffer()) });
    });
    return { context, tab };
  }

  const textarea = '#f-body';
  const value = (tab: PwPage) => tab.locator(textarea).inputValue();
  const caretAtEnd = (tab: PwPage) => tab.evaluate(`(() => { const body = document.getElementById('f-body'); body.focus(); body.setSelectionRange(body.value.length, body.value.length); })()`);
  /** Answer the file dialog: alt text, a caption, and Upload or Insert. */
  async function describeFile(tab: PwPage, alt: string, caption = '') {
    await tab.locator('#file-dialog').waitFor({ state: 'visible' });
    await tab.locator('#fd-alt').fill(alt);
    if (caption) await tab.locator('#fd-caption').fill(caption);
    await tab.locator('#file-dialog-ok').click();
  }
  /** Wait for a condition in the page, asked again and again (waitForFunction evaluates a string, which the console's CSP refuses). */
  async function until(tab: PwPage, script: string) {
    const end = Date.now() + 15_000;
    while (!(await tab.evaluate<boolean>(`Boolean(${script})`))) {
      if (Date.now() > end) throw new Error(`Still not true: ${script} (the editor says: ${await tab.evaluate<string>("document.getElementById('preview-status').textContent")}; the post: ${await tab.evaluate<string>("document.getElementById('f-body').value.slice(-400)")})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('writes a rich post: a pasted screenshot, the toolbar and its keys, a GIF, a video and a player, previewed and saved', async (context) => {
    if (!browser) context.skip();
    const { context: browserContext, tab } = await open();
    await tab.goto(`${ORIGIN}/content`, { waitUntil: 'load' });
    await tab.evaluate('document.fonts.ready.then(() => true)');
    await tab.screenshot({ path: join(SHOTS, 'editor-post-list.png') });

    await tab.goto(`${ORIGIN}/content/${SLUG}`, { waitUntil: 'load' });
    await tab.locator('.md-toolbar').waitFor({ state: 'visible' });

    // A word made bold from the keyboard, Ctrl+B.
    await tab.evaluate(`(() => { const body = document.getElementById('f-body'); const at = body.value.indexOf('faster'); body.focus(); body.setSelectionRange(at, at + 'faster'.length); })()`);
    await tab.keyboard.press('Control+b');
    expect(await value(tab)).toContain('follows a booking flow **faster** with');

    // A screenshot pasted from the clipboard: the editor asks for its alt text, uploads it, and
    // writes it where the cursor was, named by that alt text.
    await caretAtEnd(tab);
    const png = readFileSync(join(FIXTURES, 'calendar-week.png')).toString('base64');
    await tab.evaluate(`(() => {
      const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.getElementById('f-body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await describeFile(tab, 'The week calendar for van 3 with one slot held', 'Pasted straight from the clipboard.');
    await until(tab, `document.getElementById('f-body').value.includes('/blog/${SLUG}/the-week-calendar-for-van-3.png "Pasted straight from the clipboard.")')`);

    // A table from the toolbar, its first header selected to type over.
    await caretAtEnd(tab);
    await tab.locator('.md-tool[data-md="table"]').click();
    expect(await tab.evaluate<string>(`(() => { const body = document.getElementById('f-body'); return body.value.slice(body.selectionStart, body.selectionEnd); })()`)).toBe('Column');
    expect(await value(tab)).toContain('| Column | Column |\n| --- | --- |\n| Cell | Cell |');
    await tab.evaluate(`(() => { const body = document.getElementById('f-body'); body.setRangeText('| Format | Largest |\\n| --- | --- |\\n| GIF | 10 MB |\\n| MP4, WebM | 20 MB |', body.value.indexOf('| Column'), body.value.indexOf('| Cell | Cell |') + 15, 'end'); body.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    // A GIF dropped on the post, and a video from the toolbar's upload. (Each file is made in the page:
    // Playwright cannot read back the body of an upload whose file it took from the disk.)
    const file = (name: string, type: string) =>
      `new File([Uint8Array.from(atob('${readFileSync(join(FIXTURES, name)).toString('base64')}'), (c) => c.charCodeAt(0))], '${name}', { type: '${type}' })`;
    await caretAtEnd(tab);
    await tab.evaluate(`(() => {
      const data = new DataTransfer();
      data.items.add(${file('hold-expires.gif', 'image/gif')});
      const body = document.getElementById('f-body');
      body.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await describeFile(tab, 'A held slot counting down, then booked');
    await until(tab, `document.getElementById('f-body').value.includes('](/blog/${SLUG}/hold-expires.gif)')`);
    await caretAtEnd(tab);
    const chooser = tab.waitForEvent('filechooser');
    await tab.locator('.md-tool[data-md="upload"]').click();
    expect((await chooser).isMultiple()).toBe(true);
    await tab.evaluate(`(() => {
      const data = new DataTransfer();
      data.items.add(${file('hold-to-booking.mp4', 'video/mp4')});
      const input = document.getElementById('md-file');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await describeFile(tab, 'The hold counting down and the slot turning booked', 'Thirty seconds, sped up.');
    await until(tab, `document.getElementById('f-body').value.includes('](/blog/${SLUG}/hold-to-booking.mp4 "Thirty seconds, sped up.")')`);

    // A YouTube video by its address.
    await caretAtEnd(tab);
    await tab.locator('.md-tool[data-md="embed"]').click();
    await tab.locator('#ed-url').fill('https://evil.example/watch?v=M7lc1UVf-VE');
    await tab.locator('#ed-title').fill('The talk on holds');
    await tab.locator('#embed-dialog button[value="ok"]').click();
    expect(await tab.evaluate<string>(`document.getElementById('embed-dialog-problem').textContent`)).toBe('That is not a YouTube or Vimeo video address.');
    await tab.locator('#ed-url').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
    await tab.locator('#embed-dialog button[value="ok"]').click();
    await until(tab, `document.getElementById('f-body').value.includes('![The talk on holds](https://www.youtube.com/watch?v=M7lc1UVf-VE)')`);

    // The preview shows each as the site will, under the console's CSP, with nothing refused.
    await until(tab, `(() => { const p = document.getElementById('preview'); return p.querySelector('iframe') && p.querySelector('video') && p.querySelector('.table-scroll') && p.querySelectorAll('img').length === 2; })()`);
    const preview = await tab.evaluate<{ images: [string, number][]; video: number; frame: string; table: string; refused: string[]; checks: string }>(`(async () => {
      const preview = document.getElementById('preview');
      const images = [...preview.querySelectorAll('img')];
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
      const video = preview.querySelector('video');
      if (video.readyState < 1) await new Promise((resolve) => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 8000); });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        images: images.map((image) => [image.getAttribute('src'), image.naturalWidth]),
        video: video.readyState,
        frame: preview.querySelector('iframe').getAttribute('src'),
        table: preview.querySelector('.table-scroll').textContent,
        refused: window.__refused,
        checks: document.getElementById('checks').textContent,
      };
    })()`);
    expect(preview.images).toEqual([[`/blog/${SLUG}/the-week-calendar-for-van-3.png`, 960], [`/blog/${SLUG}/hold-expires.gif`, 480]]);
    expect(preview.video).toBeGreaterThanOrEqual(1);
    expect(preview.frame).toBe('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE');
    expect(preview.table).toContain('MP4, WebM20 MB');
    expect(preview.refused).toEqual([]);
    expect(preview.checks).toContain('2 pictures, 1 video, 1 player');

    // No serious or critical axe violation on the editor with its toolbar, preview and dialogs.
    await tab.evaluate(readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8'));
    const violations = await tab.evaluate<{ id: string; impact: string | null; nodes: string[] }[]>(`(async () => {
      const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      return result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.slice(0, 3).map((node) => String(node.target)) }));
    })()`);
    expect(violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([]);

    await tab.setViewportSize({ width: 1440, height: 1500 });
    await tab.evaluate(`(async () => { document.getElementById('f-body').scrollTop = 0; document.querySelector('.scroll').scrollTop = 0; await document.fonts.ready; })()`);
    await tab.screenshot({ path: join(SHOTS, 'editor-rich.png') });

    // The Media panel lists the three files; one goes into the post again from there.
    await tab.setViewportSize({ width: 1440, height: 900 });
    await tab.locator('label:has(#it-images)').click();
    await tab.locator('#media-list [data-insert]').first().waitFor({ state: 'visible' });
    expect(await tab.locator('#media-list .media-item').count()).toBe(3);
    await caretAtEnd(tab);
    await tab.locator(`#media-list [data-insert="/blog/${SLUG}/hold-expires.gif"]`).click();
    await describeFile(tab, 'The hold once more, from the Media panel');
    await until(tab, `document.getElementById('f-body').value.includes('![The hold once more, from the Media panel](/blog/${SLUG}/hold-expires.gif)')`);
    await tab.screenshot({ path: join(SHOTS, 'editor-media.png') });

    // The search result and the link card, beside the SEO settings.
    await tab.locator('label:has(#it-seo)').click();
    await tab.locator('label:has(#pt-card)').click();
    await tab.screenshot({ path: join(SHOTS, 'editor-seo.png') });
    await tab.locator('label:has(#pt-article)').click();

    // Saved: the draft on its branch holds every line, and its files are beside it.
    const written = await value(tab);
    await tab.locator('button[name="intent"][value="save"]').click();
    await tab.locator('text=Saved as a draft on its pull request').waitFor({ state: 'visible' });
    const saved = parsePost(repo.text(`cms/${SLUG}`, `site/content/blog/${SLUG}.md`) ?? '', SLUG);
    expect(saved.body.trimEnd()).toBe(written.replace(/\r\n/g, '\n').trimEnd());
    expect([...repo.files(`cms/${SLUG}`).keys()].filter((path) => path.startsWith(`site/public/blog/${SLUG}/`)).sort()).toEqual(
      ['hold-expires.gif', 'hold-to-booking.mp4', 'the-week-calendar-for-van-3.png'].map((name) => `site/public/blog/${SLUG}/${name}`),
    );
    expect(Buffer.from(repo.bytes(`cms/${SLUG}`, `site/public/blog/${SLUG}/hold-to-booking.mp4`) ?? []).equals(readFileSync(join(FIXTURES, 'hold-to-booking.mp4')))).toBe(true);
    await browserContext.close();
  }, 240_000);
});
