// The CMS's rules without a database (src/admin/cms.ts, src/admin/github-app.ts, RFC 0006, 4.5): the
// console and the hourly workflow's script agree on which files a CMS pull request may change and
// on what a schedule says; an image is known by its bytes; a renamed post's redirects; the fields
// a post file cannot keep; the App's key in either format GitHub gives; and the App known by its
// Client ID alone, its installation found on the repository.
import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cmsChangeAllowed, cmsPathAllowed, scheduleOf, signOffsOf } from '../../scripts/cms-scheduled-merge.mjs';
import {
  type SlotlockCmsChange,
  slotlockCmsChangeAllowed,
  slotlockCmsPathAllowed,
  slotlockFileType,
  slotlockPostFromFields,
  slotlockRedirectsWith,
  slotlockScheduleComment,
  slotlockScheduleOf,
} from '../admin/cms.js';
import { createSlotlockCmsGitHub, slotlockSignOff } from '../admin/github-app.js';
import { FAKE_APP_ID, FAKE_CLIENT_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, createFakeGithubRepo } from './helpers/fake-github-repo.js';

const SHA = 'a'.repeat(40);
const fields = {
  slug: 'a-post', title: 'Holds that wait for a person to choose', seoTitle: '',
  description: 'How a hold keeps a slot for a person while they choose, and lets it go when they leave without booking.',
  date: '2026-11-12', updated: '', publishAt: '', author: 'maintainers', tags: 'holds', eyebrow: '',
  imageAlt: 'Holds that wait.', related: 'Holds | /docs/concepts/', body: 'A paragraph.\n',
};

describe('the CMS rules the console and the hourly workflow share', () => {
  it('agree on the files a CMS pull request may change', () => {
    const paths = [
      'site/content/blog/a-post.md',
      'site/public/blog/a-post/van.png',
      'site/public/blog/a-post/van.jpeg',
      'site/public/blog/a-post/van.webp',
      'site/public/blog/a-post/chart.avif',
      'site/public/blog/a-post/hold.gif',
      'site/public/blog/a-post/hold.mp4',
      'site/public/blog/a-post/hold.webm',
      'site/public/blog/a-post/slides.pdf',
      'site/public/_redirects',
      'site/src/data/authors.json',
      'site/public/blog/a-post/van.svg',
      'site/public/blog/a-post/page.html',
      'site/public/blog/a-post/recording.mov',
      'site/public/blog/a-post/nested/van.png',
      'site/content/blog/../../src/index.ts',
      'site/content/blog/A-Post.md',
      'src/index.ts',
      '.github/workflows/site.yml',
      'site/src/lib/post-format.ts',
      'site/public/_headers',
    ];
    const allowed = paths.filter((path) => slotlockCmsPathAllowed(path));
    // The author list is not the console's to change: it never writes it.
    expect(allowed).toEqual(paths.slice(0, 10));
    for (const path of paths) expect(cmsPathAllowed(path), path).toBe(slotlockCmsPathAllowed(path));
  });

  it('merge only a post\'s own files, or a rename\'s with the redirects it writes', () => {
    const change = (path: string, status = 'modified', extra: Partial<SlotlockCmsChange> = {}): SlotlockCmsChange =>
      ({ path, previous: null, status, patch: null, ...extra });
    const redirects = (...lines: string[]) => change('site/public/_redirects', 'modified', { patch: ['@@ -1 +1 @@', ...lines].join('\n') });
    const own = [change('site/content/blog/second.md', 'added'), change('site/public/blog/second/van.png', 'added'), change('site/public/blog/second/hold.mp4', 'added'), change('site/public/blog/second/slides.pdf', 'added')];
    const rename = [
      change('site/content/blog/first.md', 'removed'),
      change('site/public/blog/first/van.png', 'removed'),
      ...own,
      redirects('-/old-blog/x/ /blog/first/ 301', '+/old-blog/x/ /blog/second/ 301', '+/blog/first/ /blog/second/ 301', '+/blog/first.md /blog/second.md 301', '\\ No newline at end of file'),
    ];
    const cases: [string, SlotlockCmsChange[], boolean][] = [
      ['its own post and image', own, true],
      ['nothing', [], false],
      ['a rename, with its redirects', rename, true],
      ['a rename GitHub saw as one', [change('site/content/blog/second.md', 'renamed', { previous: 'site/content/blog/first.md' }), redirects('+/blog/first/ /blog/second/ 301')], true],
      ['a post renamed back, its old redirect to itself gone', [change('site/content/blog/first.md', 'removed'), change('site/content/blog/second.md', 'added'), redirects('-/blog/second/ /blog/first/ 301', '+/blog/first/ /blog/second/ 301')], true],
      ['another post changed', [...own, change('site/content/blog/other.md')], false],
      ['another post deleted, with no rename', [...own, change('site/content/blog/other.md', 'removed')], false],
      ['two posts going', [...rename, change('site/content/blog/third.md', 'removed')], false],
      ['redirects with no rename', [...own, redirects('+/blog/first/ /blog/second/ 301')], false],
      ['a rename with no redirects', rename.slice(0, 4), false],
      ['a redirect taking another post\'s address', [...rename.slice(0, 4), redirects('+/blog/first/ /blog/second/ 301', '+/blog/other/ /blog/second/ 301')], false],
      ['a redirect out of the site', [...rename.slice(0, 4), redirects('+/blog/first/ https://example.com/ 301')], false],
      ['a redirect for another page', [...rename.slice(0, 4), redirects('+/pricing/ /blog/second/ 301')], false],
      ['another redirect dropped', [...rename.slice(0, 4), redirects('-/docs/ /blog/other/ 301', '+/blog/first/ /blog/second/ 301')], false],
      ['redirects GitHub gave no diff of', [...rename.slice(0, 4), change('site/public/_redirects')], false],
      ['the author list', [...own, change('site/src/data/authors.json')], false],
      ['a workflow', [...own, change('.github/workflows/site.yml')], false],
      ['a page beside the post', [...own, change('site/public/blog/second/page.html', 'added')], false],
    ];
    for (const [name, files, allowed] of cases) {
      expect(slotlockCmsChangeAllowed('second', files), name).toBe(allowed);
      expect(cmsChangeAllowed('second', files), name).toBe(allowed);
    }
  });

  it('carry into main only the sign-offs of each commit\'s own author', () => {
    const commits = [
      { commit: { author: { email: '1004+octo-editor@users.noreply.github.com' }, message: 'Blog: save "Hello"\n\nSigned-off-by: Some Maintainer <1+maint@users.noreply.github.com>\nSigned-off-by: octo-editor <1004+octo-editor@users.noreply.github.com>' } },
      { commit: { author: null, message: 'Signed-off-by: Nobody <0+nobody@users.noreply.github.com>' } },
    ];
    expect(signOffsOf(commits)).toEqual(['Signed-off-by: octo-editor <1004+octo-editor@users.noreply.github.com>']);
  });

  it('read a schedule the same way, and an unschedule after it cancels it', () => {
    const comment = slotlockScheduleComment({ sha: SHA, at: '2026-11-14T09:00Z', by: 'octo-owner' });
    const schedule = { sha: SHA, at: '2026-11-14T09:00Z', by: 'octo-owner' };
    expect(slotlockScheduleOf(['Something else.', comment])).toEqual(schedule);
    expect(scheduleOf(['Something else.', comment])).toEqual(schedule);
    const cancelled = [comment, '<!-- slotlock-cms:unschedule -->\nUnscheduled.'];
    expect(slotlockScheduleOf(cancelled)).toBeNull();
    expect(scheduleOf(cancelled)).toBeNull();
    // Only a whole marker at the start counts.
    expect(slotlockScheduleOf([`Quoted: ${comment}`])).toBeNull();
    expect(scheduleOf([`Quoted: ${comment}`])).toBeNull();
  });
});

describe('the CMS console', () => {
  it('knows a file by its first bytes, never by its name', () => {
    expect(slotlockFileType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(slotlockFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(slotlockFileType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(slotlockFileType(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
    expect(slotlockFileType(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(slotlockFileType(new TextEncoder().encode('GIF89a\x01\0\x01\0'))).toBe('gif');
    expect(slotlockFileType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf');
    expect(slotlockFileType(new TextEncoder().encode('\0\0\0\x18ftypisom\0\0\x02\0isomiso2'))).toBe('mp4');
    expect(slotlockFileType(new TextEncoder().encode('\0\0\0\x14ftypqt  \0\0\0\0qt  '))).toBeNull();
  });

  it('redirects a renamed post and its Markdown twin, and points older redirects at the new address', () => {
    const before = '# Moved pages\n/old-blog/x/ /blog/first/ 301\n';
    expect(slotlockRedirectsWith(before, 'first', 'second')).toBe(
      '# Moved pages\n/old-blog/x/ /blog/second/ 301\n/blog/first/ /blog/second/ 301\n/blog/first.md /blog/second.md 301\n',
    );
    expect(slotlockRedirectsWith('', 'a', 'b')).toBe('/blog/a/ /blog/b/ 301\n/blog/a.md /blog/b.md 301\n');
    // Renamed back: the old redirects from the post's own address go, so nothing leads to itself.
    const once = slotlockRedirectsWith('', 'alpha', 'beta');
    expect(slotlockRedirectsWith(once, 'beta', 'alpha')).toBe('/blog/beta/ /blog/alpha/ 301\n/blog/beta.md /blog/alpha.md 301\n');
  });

  it('makes a post file the site reads back the same, and refuses a field it cannot keep', () => {
    const made = slotlockPostFromFields(fields, 'a-post', { status: 'draft' });
    expect('post' in made && made.post.front).toMatchObject({ title: fields.title, status: 'draft', image: 'blog-a-post', related: [{ label: 'Holds', href: '/docs/concepts/' }] });
    const later = slotlockPostFromFields({ ...fields, publishAt: '2026-12-01T09:30' }, 'a-post', { status: 'published' });
    expect('post' in later && later.post.front.publishAt).toBe('2026-12-01T09:30Z');
    // A line break in a date would add a line of frontmatter: refused, never written.
    expect(slotlockPostFromFields({ ...fields, date: '2026-11-12\nstatus: published' }, 'a-post', { status: 'draft' })).toHaveProperty('error');
    expect(slotlockPostFromFields({ ...fields, author: 'maintainers\nstatus: published' }, 'a-post', { status: 'draft' })).toHaveProperty('error');
    expect(slotlockPostFromFields({ ...fields, publishAt: 'tomorrow' }, 'a-post', { status: 'draft' })).toEqual({ error: 'The publish time is a date and a time, in UTC.' });
    expect(slotlockPostFromFields({ ...fields, related: 'No path here' }, 'a-post', { status: 'draft' })).toHaveProperty('error');
    expect(slotlockPostFromFields({ ...fields, title: '' }, 'a-post', { status: 'draft' })).toEqual({ error: 'Fill in title.' });
    // A title with quotes is quoted, and reads back exactly.
    const quoted = slotlockPostFromFields({ ...fields, title: '"Holds" that wait' }, 'a-post', { status: 'draft' });
    expect('post' in quoted && quoted.post.front.title).toBe('"Holds" that wait');
    // A line break, or any control character, in a one-line field is refused: in a title it would
    // carry a line of its own (a Signed-off-by) into the commit message.
    for (const [name, value] of [
      ['title', 'Hello\nSigned-off-by: Some Maintainer <1+maint@users.noreply.github.com>'],
      ['seoTitle', 'A\tB'], ['description', `${fields.description}\nMore.`], ['eyebrow', 'News\u2028'],
      ['imageAlt', 'A van\rparked'], ['tags', 'holds, a\u0000b'],
    ] as const) {
      expect(slotlockPostFromFields({ ...fields, [name]: value }, 'a-post', { status: 'draft' }), name).toHaveProperty('error');
    }
    // A related link is a site path, an anchor or an https address, never a script.
    expect(slotlockPostFromFields({ ...fields, related: 'Holds | javascript:alert(1)' }, 'a-post', { status: 'draft' })).toHaveProperty('error');
  });
});

describe('the CMS GitHub App client', () => {
  it('signs in as the App with its key as GitHub gives it (PKCS#1) or as PKCS#8, and keeps the token', async () => {
    const repo = createFakeGithubRepo({ 'site/content/blog/a-post.md': 'x' });
    const pkcs8 = createPrivateKey(repo.privateKey).export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const privateKey of [repo.privateKey, pkcs8, repo.privateKey.replace(/\n/g, '\\n')]) {
      const github = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
      expect((await github.readFile('site/content/blog/a-post.md', 'main'))?.text).toBe('x');
      expect(await github.branchHead('cms/a-post')).toBeNull();
    }
    // One installation token per client, reused for its next requests.
    expect(repo.calls.filter((call) => call.endsWith('/access_tokens'))).toHaveLength(3);
    const other = createFakeGithubRepo({});
    const wrongKey = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: other.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    await expect(wrongKey.readFile('site/content/blog/a-post.md', 'main')).rejects.toThrow(/refused the CMS App's token \(401\)/);
  });

  it('signs in by the App\'s Client ID, finds its installation on the repository once, and asks for a token for that repository only', async () => {
    const repo = createFakeGithubRepo({ 'site/content/blog/a-post.md': 'x' });
    const github = createSlotlockCmsGitHub({ appId: FAKE_CLIENT_ID, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    expect((await github.readFile('site/content/blog/a-post.md', 'main'))?.text).toBe('x');
    expect(await github.branchHead('cms/a-post')).toBeNull();
    expect(repo.calls.filter((call) => call === `GET /repos/${FAKE_REPOSITORY}/installation`)).toHaveLength(1);
    expect(repo.calls.filter((call) => call === `POST /app/installations/${FAKE_INSTALLATION}/access_tokens`)).toHaveLength(1);
    expect(repo.tokenRequests).toEqual([{ repositories: ['slotlock'] }]);
    // The App's own comments are known by the App ID the installation names.
    await github.commit({ branch: 'cms/a-post', base: 'main', files: [{ path: 'site/content/blog/a-post.md', content: 'y' }], message: 'Blog: save', author: { login: 'octo-editor', id: '1004' } });
    const pull = await github.openPullRequest({ branch: 'cms/a-post', title: 'Blog: a post', body: '' });
    repo.pulls.get(pull.number)?.comments.push({ body: 'By someone else.', app: false }, { body: 'By the App.', app: true });
    expect(await github.appComments(pull.number)).toEqual(['By the App.']);
    expect(repo.calls.filter((call) => call.endsWith('/installation'))).toHaveLength(1);

    // An installation named alongside the Client ID must be the one GitHub has.
    const wrong = createSlotlockCmsGitHub({ appId: FAKE_CLIENT_ID, installationId: '78', privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    await expect(wrong.readFile('site/content/blog/a-post.md', 'main')).rejects.toThrow(/installation 78 is not the App's installation on PILOTAAI\/slotlock \(77\)/);
    // Not installed there: said, and asked again next time rather than remembered.
    const elsewhere = createSlotlockCmsGitHub({ appId: FAKE_CLIENT_ID, privateKey: repo.privateKey, repository: 'PILOTAAI/elsewhere', fetch: repo.fetch });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(elsewhere.readFile('x.md', 'main')).rejects.toThrow(/not installed on PILOTAAI\/elsewhere \(404\)/);
    }
    expect(repo.calls.filter((call) => call === 'GET /repos/PILOTAAI/elsewhere/installation')).toHaveLength(2);

    // An existing setup's numeric App ID and installation need no lookup.
    const before = repo.calls.length;
    const numeric = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    expect(await numeric.appComments(pull.number)).toEqual(['By the App.']);
    expect(repo.calls.slice(before).filter((call) => call.endsWith('/installation'))).toEqual([]);
  });

  it('lists what merging a commit brings, reads every page of comments, and keeps only an author\'s own sign-off', async () => {
    const repo = createFakeGithubRepo({ 'site/content/blog/first.md': 'one', 'site/public/_redirects': '/old/ /blog/first/ 301\n' });
    const github = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    const author = { login: 'octo-editor', id: '1004' };
    const sha = await github.commit({
      branch: 'cms/second', base: 'main',
      files: [
        { path: 'site/content/blog/first.md', content: null },
        { path: 'site/content/blog/second.md', content: 'two' },
        { path: 'site/public/_redirects', content: slotlockRedirectsWith('/old/ /blog/first/ 301\n', 'first', 'second') },
      ],
      message: 'Blog: move\n\nSigned-off-by: Some Maintainer <1+maint@users.noreply.github.com>',
      author,
    });
    const files = await github.commitFiles(sha);
    expect(files?.map((file) => [file.path, file.status])).toEqual([
      ['site/content/blog/first.md', 'removed'], ['site/content/blog/second.md', 'added'], ['site/public/_redirects', 'modified'],
    ]);
    expect(slotlockCmsChangeAllowed('second', files ?? [])).toBe(true);
    // Main moved on after the branch: the comparison still holds only the branch's own changes.
    repo.pushToMain({ 'README.md': 'Elsewhere.\n' });
    expect((await github.commitFiles(sha))?.map((file) => file.path)).not.toContain('README.md');
    const pull = await github.openPullRequest({ branch: 'cms/second', title: 'Blog: move', body: '' });
    expect(await github.signOffs(pull.number)).toEqual([slotlockSignOff(author)]);
    // The App's schedule after 250 comments of others is still read.
    const fake = repo.pulls.get(pull.number);
    for (let index = 0; index < 250; index += 1) fake?.comments.push({ body: `Comment ${index}`, app: false });
    fake?.comments.push({ body: slotlockScheduleComment({ sha, at: '2026-11-14T09:00Z', by: 'octo-owner' }), app: true });
    expect(slotlockScheduleOf(await github.appComments(pull.number))).toEqual({ sha, at: '2026-11-14T09:00Z', by: 'octo-owner' });
  });

  it('reads a file over 1 MB raw, lists a folder with sizes and blobs, and moves a file by its blob', async () => {
    const big = new Uint8Array(1_500_000).fill(7);
    const repo = createFakeGithubRepo({ 'site/public/blog/a-post/hold.gif': big, 'site/public/blog/a-post/van.png': 'png' });
    const github = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    // GitHub's contents API gives a file over 1 MB as JSON with no content: only raw has its bytes.
    expect(Buffer.from((await github.readBytes('site/public/blog/a-post/hold.gif', 'main')) ?? []).equals(Buffer.from(big))).toBe(true);
    expect(await github.readBytes('site/public/blog/a-post/missing.gif', 'main')).toBeNull();
    const listed = await github.listFiles('site/public/blog/a-post', 'main');
    expect(listed.map((entry) => [entry.name, entry.size])).toEqual([['hold.gif', 1_500_000], ['van.png', 3]]);
    expect(await github.listDirectory('site/public/blog/a-post', 'main')).toEqual(['hold.gif', 'van.png']);
    const author = { login: 'octo-editor', id: '1004' };
    const gif = listed.find((entry) => entry.name === 'hold.gif');
    await github.commit({
      branch: 'cms/b-post', base: 'main', author, message: 'Blog: move',
      files: [{ path: 'site/public/blog/a-post/hold.gif', content: null }, { path: 'site/public/blog/b-post/hold.gif', content: { blob: gif?.sha ?? '' } }],
    });
    expect(repo.blobUploads).toEqual([]);
    expect(repo.bytes('cms/b-post', 'site/public/blog/b-post/hold.gif')?.length).toBe(1_500_000);
    await expect(github.commit({ branch: 'cms/b-post', base: 'main', author, message: 'x', files: [{ path: 'x', content: { blob: 'not-a-sha' } }] })).rejects.toThrow(/40 hex/);
    // A new file's bytes go up once, as base64 in a JSON body written without a string copy.
    const odd = Uint8Array.from({ length: 300_001 }, (_, index) => index % 251);
    await github.commit({ branch: 'cms/b-post', base: 'main', author, message: 'Blog: add', files: [{ path: 'site/public/blog/b-post/odd.webm', content: odd }] });
    expect(repo.blobUploads).toEqual([300_001]);
    expect(Buffer.from(repo.bytes('cms/b-post', 'site/public/blog/b-post/odd.webm') ?? []).equals(Buffer.from(odd))).toBe(true);
  });

  it('writes only cms/ branches, signed off as the staff member', async () => {
    const repo = createFakeGithubRepo({});
    const github = createSlotlockCmsGitHub({ appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, fetch: repo.fetch });
    const author = { login: 'octo-editor', id: '1004' };
    await expect(github.commit({ branch: 'main', base: 'main', files: [], message: 'x', author })).rejects.toThrow(/only to cms\/<slug>/);
    await expect(github.commit({ branch: 'cms/../main', base: 'main', files: [], message: 'x', author })).rejects.toThrow(/only to cms\/<slug>/);
    const sha = await github.commit({ branch: 'cms/a-post', base: 'main', files: [{ path: 'site/content/blog/a-post.md', content: 'y' }], message: 'Blog: save', author });
    expect(repo.commit(sha)?.message).toBe(`Blog: save\n\n${slotlockSignOff(author)}`);
    expect(slotlockSignOff(author)).toBe('Signed-off-by: octo-editor <1004+octo-editor@users.noreply.github.com>');
    // Saving over a branch that moved since the page was opened is refused.
    await expect(github.commit({ branch: 'cms/a-post', base: 'main', files: [], message: 'x', author, expectHead: null })).rejects.toMatchObject({ status: 409 });
    expect(() => createSlotlockCmsGitHub({ appId: 'x', installationId: '1', privateKey: '', repository: FAKE_REPOSITORY })).toThrow(/Client ID or its App ID/);
    expect(() => createSlotlockCmsGitHub({ appId: FAKE_CLIENT_ID, installationId: 'x', privateKey: '', repository: FAKE_REPOSITORY })).toThrow(/installation id is a number/);
    expect(() => createSlotlockCmsGitHub({ appId: '1', installationId: '1', privateKey: '', repository: 'not a repo' })).toThrow(/owner\/name/);
  });
});
