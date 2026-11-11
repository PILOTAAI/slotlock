// The CMS's rules without a database (src/admin/cms.ts, src/admin/github-app.ts, RFC 0006, 4.5): the
// console and the hourly workflow's script agree on which files a CMS pull request may change and
// on what a schedule says; an image is known by its bytes; a renamed post's redirects; the fields
// a post file cannot keep; and the App's key in either format GitHub gives.
import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cmsPathAllowed, scheduleOf } from '../../scripts/cms-scheduled-merge.mjs';
import {
  slotlockCmsPathAllowed,
  slotlockImageType,
  slotlockPostFromFields,
  slotlockRedirectsWith,
  slotlockScheduleComment,
  slotlockScheduleOf,
} from '../admin/cms.js';
import { createSlotlockCmsGitHub, slotlockSignOff } from '../admin/github-app.js';
import { FAKE_APP_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, createFakeGithubRepo } from './helpers/fake-github-repo.js';

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
      'site/public/_redirects',
      'site/src/data/authors.json',
      'site/public/blog/a-post/van.svg',
      'site/public/blog/a-post/nested/van.png',
      'site/content/blog/../../src/index.ts',
      'site/content/blog/A-Post.md',
      'src/index.ts',
      '.github/workflows/site.yml',
      'site/src/lib/post-format.ts',
      'site/public/_headers',
    ];
    const allowed = paths.filter((path) => slotlockCmsPathAllowed(path));
    expect(allowed).toEqual(paths.slice(0, 6));
    for (const path of paths) expect(cmsPathAllowed(path), path).toBe(slotlockCmsPathAllowed(path));
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
  it('knows an image by its first bytes, never by its name', () => {
    expect(slotlockImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(slotlockImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(slotlockImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(slotlockImageType(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
    expect(slotlockImageType(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
  });

  it('redirects a renamed post and its Markdown twin, and points older redirects at the new address', () => {
    const before = '# Moved pages\n/old-blog/x/ /blog/first/ 301\n';
    expect(slotlockRedirectsWith(before, 'first', 'second')).toBe(
      '# Moved pages\n/old-blog/x/ /blog/second/ 301\n/blog/first/ /blog/second/ 301\n/blog/first.md /blog/second.md 301\n',
    );
    expect(slotlockRedirectsWith('', 'a', 'b')).toBe('/blog/a/ /blog/b/ 301\n/blog/a.md /blog/b.md 301\n');
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
    // A title with a line break or quotes is quoted, and reads back exactly.
    const quoted = slotlockPostFromFields({ ...fields, title: '"Holds"\nthat wait' }, 'a-post', { status: 'draft' });
    expect('post' in quoted && quoted.post.front.title).toBe('"Holds"\nthat wait');
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
    expect(() => createSlotlockCmsGitHub({ appId: 'x', installationId: '1', privateKey: '', repository: FAKE_REPOSITORY })).toThrow(/numbers/);
    expect(() => createSlotlockCmsGitHub({ appId: '1', installationId: '1', privateKey: '', repository: 'not a repo' })).toThrow(/owner\/name/);
  });
});
