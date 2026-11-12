// The admin console's CMS (src/admin/cms.ts, RFC 0006 Phase 4) end to end, against real PostgreSQL
// and a fake GitHub that keeps one repository in memory (helpers/fake-github-repo.ts): an Editor
// writes a post with an image, previews and submits it; an Owner publishes it, once it is up to date
// with main and its checks pass, and the merge carries everyone's sign-off; a later date schedules
// it, and the hourly workflow's script publishes it; a published post is renamed with redirects; a
// draft is discarded. Each step is in the staff log, and the database refuses a role that may not
// take it. Needs a role that creates databases and roles; skipped without DATABASE_URL.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPost, parsePost, renderPostBody } from '../../site/src/lib/post-format.js';
import { mergeDuePosts } from '../../scripts/cms-scheduled-merge.mjs';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha, staffSession } from './helpers/admin-browser.js';
import { FAKE_APP_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, type FakeGithubRepo, createFakeGithubRepo } from './helpers/fake-github-repo.js';

const url = process.env.DATABASE_URL?.trim();
const SITE = 'https://slotlock.pylota.io';
const PEOPLE: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'octo-owner' },
  'code-support': { id: 1002, login: 'octo-support' },
  'code-editor': { id: 1004, login: 'octo-editor' },
};
const EDITOR_SIGN_OFF = 'Signed-off-by: octo-editor <1004+octo-editor@users.noreply.github.com>';
const OWNER_SIGN_OFF = 'Signed-off-by: octo-owner <1001+octo-owner@users.noreply.github.com>';

// The post: a real post's body, which passes the site's checks, under a new address and title.
const EXISTING = 'why-ai-agents-double-book';
const existingText = readFileSync(`site/content/blog/${EXISTING}.md`, 'utf8');
const source = parsePost(existingText, EXISTING);
const FACTS = Object.fromEntries([...source.body.matchAll(/\{\{facts\.(\w+)\}\}/g)].map((match) => [match[1] as string, 5]));
const SLUG = 'calendars-for-agents';
const IMAGE = '![A van waiting at the depot](/blog/calendars-for-agents/van.png)';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SITE_PATHS = [
  '/', '/docs/', '/blog/', `/blog/${EXISTING}/`,
  ...renderPostBody(source.body, { slug: EXISTING, facts: FACTS }).links.filter((link) => link.startsWith('/')).map((link) => link.split('#')[0] as string),
];

/** The editor's fields for a post, as the form sends them. */
function postFields(slug: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    slug,
    title: 'Calendars for agents: what a booking tool owes them',
    seoTitle: '',
    description: `What a calendar has to promise before an agent books with it: holds, one owner per slot, and answers the agent can act on (${slug}).`,
    date: '2026-11-12',
    updated: '',
    publishAt: '',
    author: 'maintainers',
    tags: 'AI agents, calendars',
    eyebrow: '',
    imageAlt: 'Calendars for agents, on the Slotlock blog.',
    related: 'Booking MCP server | /mcp-server/\nSecurity model | /docs/security/',
    body: `${source.body.trimEnd()}\n\n${slug === SLUG ? IMAGE : ''}\n`,
    ...extra,
  };
}

describe.skipIf(!url)('admin console CMS (real Postgres, fake GitHub)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_cms_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let repo: FakeGithubRepo;
  const clock = Date.parse('2026-11-12T10:00:00Z');
  let editor: Browser;
  let ownerBrowser: Browser;

  const log = async (staff: string) =>
    (await superuser<{ action: string; target: string | null }[]>`
      SELECT action, target FROM slotlock.staff_audit_events WHERE staff_ref = ${staff} AND action LIKE 'content.%' ORDER BY chain_index`).map(
      (row) => `${row.action} ${row.target ?? ''}`.trim(),
    );
  async function signedIn(code: string, enrollment: string) {
    const browser = new Browser(() => admin);
    expect((await browser.signIn(code)).headers.get('location')).toBe('/passkey');
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: enrollment })).status).toBe(200);
    return browser;
  }
  const csrfOf = async (browser: Browser, path: string) => {
    const page = await browser.request(path);
    const html = await page.text();
    return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  };
  async function form(browser: Browser, path: string, fields: Record<string, string>, from = path) {
    const csrf = await csrfOf(browser, from);
    return browser.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...fields }).toString(),
    });
  }
  const headOf = (slug: string) => repo.head(`cms/${slug}`) ?? '';
  const pullOf = (slug: string) => [...repo.pulls.values()].find((pull) => pull.branch === `cms/${slug}` && pull.state === 'open');

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
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1002', 'support', 'cli:ops', ${sha('support-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1004', 'editor', 'cli:ops', ${sha('editor-code')}, ${expires})`;
    });
    const asAdmin = new URL(target.href);
    asAdmin.username = adminRole;
    asAdmin.password = password;
    adminSql = postgres(asAdmin.href, { max: 4, onnotice: () => undefined });

    repo = createFakeGithubRepo(
      {
        [`site/content/blog/${EXISTING}.md`]: existingText,
        'site/content/blog/holds-keep-a-slot-while-a-person-decides.md': readFileSync('site/content/blog/holds-keep-a-slot-while-a-person-decides.md', 'utf8'),
        'site/src/data/authors.json': readFileSync('site/src/data/authors.json', 'utf8'),
        'site/public/_redirects': readFileSync('site/public/_redirects', 'utf8'),
        'src/index.ts': 'export {};\n',
      },
      { now: () => clock },
    );
    const site = async (input: string | URL | Request) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target === `${SITE}/sitemap-0.xml`) {
        return new Response(`<urlset>${SITE_PATHS.map((path) => `<url><loc>${SITE}${path}</loc></url>`).join('')}</urlset>`);
      }
      if (target === `${SITE}/facts.json`) return new Response(JSON.stringify(FACTS));
      if (target.startsWith('https://api.github.com/app/') || target.startsWith('https://api.github.com/repos/') || target === 'https://api.github.com/graphql') {
        return null;
      }
      return null;
    };
    const githubFetch = createGithubSignInFetch(PEOPLE, {}, async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.startsWith('https://api.github.com/app/') || target.startsWith('https://api.github.com/repos/') || target === 'https://api.github.com/graphql') {
        return repo.fetch(input, init);
      }
      return site(input);
    });
    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters', consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      cms: {
        appId: FAKE_APP_ID,
        privateKey: repo.privateKey,
        installationId: FAKE_INSTALLATION,
        repository: FAKE_REPOSITORY,
        siteUrl: SITE,
        previewHost: 'slotlock-site-preview.example.workers.dev',
      },
      fetch: githubFetch,
      now: () => clock,
    });
    editor = await signedIn('code-editor', 'editor-code');
    ownerBrowser = await signedIn('code-owner', 'owner-code');
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('gives the Owner and an Editor the Content pages, and nobody else', async () => {
    const list = await editor.request('/content');
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('href="/content"');
    expect(html).toContain(source.front.title);
    expect(html).toContain('Published');
    const support = await signedIn('code-support', 'support-code');
    const refused = await support.request('/content');
    expect(refused.status).toBe(403);
    expect(await (await support.request('/')).text()).not.toContain('href="/content"');
    expect((await support.request(`/blog/${EXISTING}/van.png`)).status).toBe(403);
  });

  it('lets an Editor write a post: committed to its own branch as them, signed off, on a pull request', async () => {
    const page = await editor.request('/content/new');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<option value="maintainers"');
    expect(html).toContain('<script src="/editor.js" defer></script>');

    const saved = await form(editor, '/content/new', { ...postFields(SLUG), intent: 'save' });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/content/${SLUG}?done=saved`);
    const commit = repo.commit(headOf(SLUG));
    expect(commit?.author).toMatchObject({ name: 'octo-editor', email: '1004+octo-editor@users.noreply.github.com' });
    // The DCO check (scripts/check-dco.sh) wants the author's own address in a Signed-off-by line.
    expect(commit?.message.split('\n').at(-1)).toBe(EDITOR_SIGN_OFF);
    const file = parsePost(repo.text(`cms/${SLUG}`, `site/content/blog/${SLUG}.md`) ?? '', SLUG);
    expect(file.front).toMatchObject({ status: 'draft', author: 'maintainers', image: `blog-${SLUG}`, tags: ['AI agents', 'calendars'] });
    expect(file.front.related).toEqual([{ label: 'Booking MCP server', href: '/mcp-server/' }, { label: 'Security model', href: '/docs/security/' }]);
    const pull = pullOf(SLUG);
    expect(pull?.labels).toEqual(['cms']);
    expect(pull?.title).toBe('Blog: Calendars for agents: what a booking tool owes them');
    expect(await log('github:1004')).toEqual([`content.saved post:${SLUG}`]);

    // Its page shows it as a draft, with its pull request, its preview deploy and its checks.
    const editorPage = await (await editor.request(saved.headers.get('location') ?? '')).text();
    expect(editorPage).toContain('Saved as a draft');
    expect(editorPage).toContain(`https://github.com/${FAKE_REPOSITORY}/pull/${pull?.number}`);
    expect(editorPage).toContain(`https://pr-${pull?.number}-slotlock-site-preview.example.workers.dev/blog/${SLUG}/`);
    expect(editorPage).toContain('Not uploaded: van.png.');
    // An Editor sees no Publish button.
    expect(editorPage).not.toContain(`action="/content/${SLUG}/publish"`);
  });

  it('refuses a new post at an address that is taken', async () => {
    const taken = await form(editor, '/content/new', { ...postFields(EXISTING), intent: 'save' });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain('There is a post or a draft at that address already');
    const reserved = await form(editor, '/content/new', { ...postFields('preview'), intent: 'save' });
    expect(reserved.status).toBe(422);
    expect(await log('github:1004')).toEqual([`content.saved post:${SLUG}`]);
  });

  it('adds an image beside the post, by its bytes, and serves it to the preview', async () => {
    const upload = async (bytes: Uint8Array, filename: string, name = '') => {
      const csrf = await csrfOf(editor, `/content/${SLUG}`);
      const body = new FormData();
      body.set('csrf', csrf);
      body.set('name', name);
      body.set('image', new Blob([new Uint8Array(bytes)]), filename);
      const request = new Request(`${ORIGIN}/x`, { method: 'POST', body });
      const encoded = new Uint8Array(await request.arrayBuffer());
      return editor.request(`/content/${SLUG}/images`, {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? '', 'content-length': String(encoded.length) },
        body: encoded,
      });
    };
    const notAnImage = await upload(new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'van.png');
    expect(notAnImage.headers.get('location')).toBe(`/content/${SLUG}?error=image_invalid`);
    const added = await upload(PNG, 'Van at the depot.PNG', 'van');
    expect(added.headers.get('location')).toBe(`/content/${SLUG}?done=image_added#images`);
    expect(Buffer.from(repo.bytes(`cms/${SLUG}`, `site/public/blog/${SLUG}/van.png`) ?? [])).toEqual(PNG);
    expect(repo.commit(headOf(SLUG))?.message).toContain(EDITOR_SIGN_OFF);

    const served = await editor.request(`/blog/${SLUG}/van.png`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
    expect(await log('github:1004')).toEqual([`content.saved post:${SLUG}`, `content.image_added post:${SLUG}`]);
  });

  it('previews the post with the site’s own renderer and checks, saving nothing', async () => {
    const csrf = await csrfOf(editor, `/content/${SLUG}`);
    const before = headOf(SLUG);
    const good = await editor.json('/content/preview', { csrf, ...postFields(SLUG) });
    expect(good.status).toBe(200);
    const result = (await good.json()) as { html: string; checks: string };
    expect(result.html).toContain(`<img src="/blog/${SLUG}/van.png" alt="A van waiting at the depot"`);
    expect(result.html).not.toContain('{{facts.');
    expect(result.checks).not.toContain('class="bad"');
    expect(result.checks).toContain('Unique description');

    const bad = await editor.json('/content/preview', { csrf, ...postFields(SLUG, { body: 'Short — and <script>alert(1)</script>.' }) });
    const checks = ((await bad.json()) as { html: string; checks: string });
    expect(checks.html).toContain('&lt;script&gt;');
    expect(checks.checks).toContain('an em dash');
    expect(checks.checks).toContain('class="bad"');
    // Only from the console's own script, with the page's token.
    expect((await editor.json('/content/preview', { csrf, ...postFields(SLUG) }, {})).status).toBe(400);
    expect((await editor.json('/content/preview', { csrf: 'forged', ...postFields(SLUG) })).status).toBe(403);
    expect(headOf(SLUG)).toBe(before);
  });

  it('submits only a post that passes every check, and never over a newer commit', async () => {
    const head = headOf(SLUG);
    const failing = await form(editor, `/content/${SLUG}`, { ...postFields(SLUG, { description: 'Too short.' }), head, intent: 'submit' });
    expect(failing.status).toBe(422);
    expect(await failing.text()).toContain('Not submitted: fix the checks');
    expect(headOf(SLUG)).toBe(head);

    const stale = await form(editor, `/content/${SLUG}`, { ...postFields(SLUG), head: repo.head('main') ?? '', intent: 'submit' });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('the post changed on GitHub since you opened it');
    expect(headOf(SLUG)).toBe(head);

    const submitted = await form(editor, `/content/${SLUG}`, { ...postFields(SLUG), head, intent: 'submit' });
    expect(submitted.headers.get('location')).toBe(`/content/${SLUG}?done=submitted`);
    expect(parsePost(repo.text(`cms/${SLUG}`, `site/content/blog/${SLUG}.md`) ?? '', SLUG).front.status).toBe('published');
    expect(await (await editor.request('/content')).text()).toContain('In review');
  });

  it('does not let an Editor publish, in the console or in the database', async () => {
    const refused = await form(editor, `/content/${SLUG}/publish`, { sha: headOf(SLUG) }, `/content/${SLUG}`);
    expect(refused.status).toBe(403);
    const [editorSession, supportSession] = [await staffSession(superuser, 'github:1004'), await staffSession(superuser, 'github:1002')];
    await expect(adminSql`SELECT slotlock.admin_content_record(${editorSession}, 'content.published', ${SLUG}, '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_content_record(${supportSession}, 'content.saved', ${SLUG}, '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_content_record(${editorSession}, 'content.anything', ${SLUG}, '{}'::jsonb)`).rejects.toMatchObject({ code: '22023' });
    await expect(adminSql`SELECT slotlock.admin_content_record(${editorSession}, 'content.saved', '../etc', '{}'::jsonb)`).rejects.toMatchObject({ code: '22023' });
    expect(pullOf(SLUG)?.state).toBe('open');
    expect(repo.text('main', `site/content/blog/${SLUG}.md`)).toBeNull();
  });

  it('lets an Owner publish it: up to date with main, at the commit they saw, once its checks pass', async () => {
    const pull = pullOf(SLUG);
    const page = await (await ownerBrowser.request(`/content/${SLUG}`)).text();
    expect(page).toContain(`action="/content/${SLUG}/publish"`);
    expect(page).toContain(`value="${headOf(SLUG)}"`);

    repo.checksFor = () => [{ status: 'in_progress', conclusion: null }];
    const running = await form(ownerBrowser, `/content/${SLUG}/publish`, { sha: headOf(SLUG) }, `/content/${SLUG}`);
    expect(running.headers.get('location')).toBe(`/content/${SLUG}?error=checks_pending`);
    repo.checksFor = () => [{ status: 'completed', conclusion: 'failure' }];
    const failed = await form(ownerBrowser, `/content/${SLUG}/publish`, { sha: headOf(SLUG) }, `/content/${SLUG}`);
    expect(failed.headers.get('location')).toBe(`/content/${SLUG}?error=checks_failing`);
    repo.checksFor = () => [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }];

    // Main moved on: the console brings the branch up to date, and the Owner publishes again later.
    repo.pushToMain({ 'README.md': 'Elsewhere.\n' });
    const seen = headOf(SLUG);
    const behind = await form(ownerBrowser, `/content/${SLUG}/publish`, { sha: seen }, `/content/${SLUG}`);
    expect(behind.headers.get('location')).toBe(`/content/${SLUG}?error=updating`);
    expect(headOf(SLUG)).not.toBe(seen);
    const old = await form(ownerBrowser, `/content/${SLUG}/publish`, { sha: seen }, `/content/${SLUG}`);
    expect(old.headers.get('location')).toBe(`/content/${SLUG}?error=changed`);

    const published = await form(ownerBrowser, `/content/${SLUG}/publish`, { sha: headOf(SLUG) }, `/content/${SLUG}`);
    expect(published.headers.get('location')).toBe(`/content/${SLUG}?done=published`);
    expect(repo.pulls.get(pull?.number ?? 0)?.merged).toBe(true);
    expect(repo.head(`cms/${SLUG}`)).toBeNull();
    const merge = repo.merges.at(-1);
    expect(merge?.title).toBe(`Blog: Calendars for agents: what a booking tool owes them (#${pull?.number})`);
    expect(merge?.message.split('\n')).toEqual(['Published from the admin console by octo-owner.', '', EDITOR_SIGN_OFF, OWNER_SIGN_OFF]);
    expect(await log('github:1001')).toEqual([`content.updated post:${SLUG}`, `content.published post:${SLUG}`]);

    // On main: the post and its image, and the post passes the site's checks as the build reads it.
    const merged = parsePost(repo.text('main', `site/content/blog/${SLUG}.md`) ?? '', SLUG);
    expect(merged.front.status).toBe('published');
    expect(repo.bytes('main', `site/public/blog/${SLUG}/van.png`)).not.toBeNull();
    const rendered = renderPostBody(merged.body, { slug: SLUG, facts: FACTS });
    const checks = checkPost(merged, rendered, {
      authors: JSON.parse(repo.text('main', 'site/src/data/authors.json') ?? '{}'),
      sitePaths: new Set(SITE_PATHS),
      otherDescriptions: { [EXISTING]: source.front.description },
      imageFiles: new Set(['van.png']),
    });
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(await (await ownerBrowser.request(`/content/${SLUG}`)).text()).toContain(`${SITE}/blog/${SLUG}/`);
  });

  it('refuses to merge a pull request that changes anything but blog files', async () => {
    const other = 'other-post';
    expect((await form(editor, '/content/new', { ...postFields(other), intent: 'submit' })).headers.get('location')).toBe(`/content/${other}?done=submitted`);
    repo.pushToBranch(`cms/${other}`, { 'src/index.ts': 'export const owned = true;\n' }, 'Sneak in some code');
    const refused = await form(ownerBrowser, `/content/${other}/publish`, { sha: headOf(other) }, `/content/${other}`);
    expect(refused.headers.get('location')).toBe(`/content/${other}?error=not_content`);
    expect(pullOf(other)?.merged).toBe(false);
    expect(repo.text('main', 'src/index.ts')).toBe('export {};\n');
  });

  it('schedules a post with a later date, and the hourly workflow publishes it when that comes', async () => {
    const later = 'scheduled-post';
    const at = '2026-11-14T09:00';
    expect((await form(editor, '/content/new', { ...postFields(later, { publishAt: at }), intent: 'submit' })).headers.get('location')).toBe(`/content/${later}?done=submitted`);
    const scheduledSha = headOf(later);
    const scheduled = await form(ownerBrowser, `/content/${later}/publish`, { sha: scheduledSha }, `/content/${later}`);
    expect(scheduled.headers.get('location')).toBe(`/content/${later}?done=scheduled`);
    const pull = pullOf(later);
    expect(pull?.labels).toEqual(['cms', 'cms:scheduled']);
    expect(pull?.comments.at(-1)?.body.split('\n')[0]).toBe(`<!-- slotlock-cms:schedule sha=${scheduledSha} at=${at}Z by=octo-owner -->`);
    expect(await (await ownerBrowser.request('/content')).text()).toContain('2026-11-14 09:00 UTC');
    expect(await log('github:1001')).toContain(`content.scheduled post:${later}`);

    const run = (when: string) =>
      mergeDuePosts({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch, now: () => Date.parse(when) });
    expect(await run('2026-11-14T08:00:00Z')).toEqual([{ number: pull?.number, slug: later, outcome: 'waiting for 2026-11-14T09:00Z' }]);
    // Main moved on: the workflow brings the branch up to date, and merges on its next run, since the
    // post itself is what the Owner scheduled.
    repo.pushToMain({ 'README.md': 'Elsewhere again.\n' });
    expect((await run('2026-11-14T09:07:00Z'))[0]?.outcome).toBe('updating: it was behind main, and its checks run again');
    expect(headOf(later)).not.toBe(scheduledSha);
    expect((await run('2026-11-14T10:07:00Z'))[0]?.outcome).toBe('merged');
    expect(repo.merges.at(-1)?.message.split('\n')).toEqual([
      'Published on schedule (2026-11-14T09:00Z), as octo-owner scheduled it in the admin console.',
      '',
      EDITOR_SIGN_OFF,
    ]);
    expect(parsePost(repo.text('main', `site/content/blog/${later}.md`) ?? '', later).front.publishAt).toBe('2026-11-14T09:00Z');
  });

  it('unschedules a post that changed after it was scheduled, or that the console did not schedule', async () => {
    const changed = 'changed-post';
    expect((await form(editor, '/content/new', { ...postFields(changed, { publishAt: '2026-11-15T09:00' }), intent: 'submit' })).status).toBe(303);
    expect((await form(ownerBrowser, `/content/${changed}/publish`, { sha: headOf(changed) }, `/content/${changed}`)).headers.get('location')).toBe(`/content/${changed}?done=scheduled`);
    const text = repo.text(`cms/${changed}`, `site/content/blog/${changed}.md`) ?? '';
    repo.pushToBranch(`cms/${changed}`, { [`site/content/blog/${changed}.md`]: text.replace('An AI agent', 'Any AI agent') }, 'Edited on GitHub');
    const labelled = repo.openPull('cms/labelled-elsewhere', 'Blog: labelled by hand');
    repo.pushToBranch('cms/labelled-elsewhere', { 'site/content/blog/labelled-elsewhere.md': text }, 'By hand');
    labelled.labels.push('cms', 'cms:scheduled');
    labelled.comments.push({ body: `<!-- slotlock-cms:schedule sha=${headOf('labelled-elsewhere')} at=2026-11-01T00:00Z by=octo-owner -->`, app: false });
    // A fork's branch of a CMS name, even with the label and the App's own words copied, is not touched.
    const forked = repo.openPull('cms/from-a-fork', 'Blog: from a fork', 'someone/slotlock');
    repo.pushToBranch('cms/from-a-fork', { 'site/content/blog/from-a-fork.md': text }, 'From a fork');
    forked.labels.push('cms', 'cms:scheduled');

    const results = await mergeDuePosts({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch, now: () => Date.parse('2026-11-15T10:00:00Z') });
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'unscheduled: the admin console did not schedule it.',
      'unscheduled: the post changed after an Owner scheduled it.',
    ]);
    expect(pullOf(changed)?.labels).toEqual(['cms']);
    expect(pullOf(changed)?.merged).toBe(false);
    expect(labelled.merged).toBe(false);
    expect(forked.labels).toEqual(['cms', 'cms:scheduled']);
    expect(forked.comments).toEqual([]);
    expect(await (await ownerBrowser.request('/content')).text()).not.toContain('from-a-fork');
    expect(repo.text('main', `site/content/blog/${changed}.md`)).toBeNull();
  });

  it('renames a published post with redirects from its old address, and discards a draft', async () => {
    const to = 'agents-and-calendars';
    const renamed = await form(ownerBrowser, `/content/${SLUG}/rename`, { to }, `/content/${SLUG}`);
    expect(renamed.headers.get('location')).toBe(`/content/${to}?done=renamed`);
    const files = repo.files(`cms/${to}`);
    expect(files.has(`site/content/blog/${SLUG}.md`)).toBe(false);
    expect(files.has(`site/public/blog/${SLUG}/van.png`)).toBe(false);
    expect(repo.bytes(`cms/${to}`, `site/public/blog/${to}/van.png`)).not.toBeNull();
    const moved = parsePost(files.get(`site/content/blog/${to}.md`) ?? '', to);
    expect(moved.body).toContain(`](/blog/${to}/van.png)`);
    expect(moved.front.image).toBe(`blog-${SLUG}`);
    expect(files.get('site/public/_redirects')).toContain(`/blog/${SLUG}/ /blog/${to}/ 301\n/blog/${SLUG}.md /blog/${to}.md 301\n`);
    expect(repo.commit(headOf(to))?.message).toContain(OWNER_SIGN_OFF);

    const discarded = await form(ownerBrowser, `/content/${to}/discard`, {}, `/content/${to}`);
    expect(discarded.headers.get('location')).toBe('/content?done=discarded');
    expect(repo.head(`cms/${to}`)).toBeNull();
    expect([...repo.pulls.values()].find((pull) => pull.branch === `cms/${to}`)?.state).toBe('closed');
    expect(repo.text('main', `site/content/blog/${SLUG}.md`)).not.toBeNull();
    expect(await log('github:1001')).toEqual(expect.arrayContaining([`content.renamed post:${SLUG}`, `content.discarded post:${to}`]));
  });

  it('says what to set when the CMS App is not configured', async () => {
    const bare = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters', consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async () => ({ email: 'staff@example.com', sub: 'sub-1' }) },
      fetch: createGithubSignInFetch(PEOPLE, {}),
      now: () => clock,
    });
    const browser = new Browser(() => bare);
    browser.jar.clear();
    for (const [name, value] of editor.jar) browser.jar.set(name, value);
    const page = await browser.request('/content');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('The CMS is not connected');
  });
});
