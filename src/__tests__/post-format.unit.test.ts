// The blog's post format (site/src/lib/post-format.ts, RFC 0006, 4.5): one renderer for the site's
// build and the admin console's preview, which never lets raw HTML through, and the checks a post
// passes before the console submits it.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POST_MIN_WORDS,
  type ParsedPost,
  type PostAuthor,
  checkPost,
  copyFindings,
  parsePost,
  postTwin,
  renderPostBody,
  serializePost,
} from '../../site/src/lib/post-format.js';

const AUTHORS: Record<string, PostAuthor> = JSON.parse(readFileSync('site/src/data/authors.json', 'utf8'));
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
const post = (body: string, front: Partial<ParsedPost['front']> = {}): ParsedPost => ({
  slug: 'a-post',
  body,
  front: {
    title: 'Holds that wait for a person to choose',
    description: 'How a hold keeps a slot for a person while they choose, and lets it go when they leave without booking anything at all.',
    date: '2026-11-12',
    author: 'maintainers',
    tags: ['holds'],
    image: 'blog-a-post',
    imageAlt: 'Holds that wait.',
    status: 'draft',
    related: [{ label: 'Holds', href: '/docs/concepts/' }],
    ...front,
  },
});

describe('the post format', () => {
  it('reads and writes a post so it reads back the same', () => {
    const written = post('A paragraph.\n\n## A heading\n\n- one\n- two\n', {
      seoTitle: 'Holds: keep a slot',
      eyebrow: 'Case study',
      publishAt: '2026-12-01T09:00Z',
      related: [{ label: 'Concepts: holds | more', href: '/docs/concepts/#holds' }],
      title: '"Quoted" title',
    });
    const text = serializePost(written);
    expect(parsePost(text, 'a-post')).toEqual(written);
    expect(text.startsWith('---\ntitle: "\\"Quoted\\" title"\n')).toBe(true);
  });

  it('refuses frontmatter it cannot read, saying where', () => {
    expect(() => parsePost('title: x', 'a-post')).toThrow(/line 1: a post starts with a --- line/);
    expect(() => parsePost('---\ntitle: x\nwho: y\n---\n', 'a-post')).toThrow(/line 3: who is not a field of a post/);
    expect(() => parsePost('---\ntitle: x\ndescription: d\ndate: 11 Nov\nauthor: a\n---\n', 'a-post')).toThrow(/date is YYYY-MM-DD/);
    expect(() => parsePost('---\n---\n', 'Not A Slug')).toThrow(/not a post slug/);
  });

  it('never lets raw HTML through: a post cannot carry a script, a style or an event handler', () => {
    const rendered = renderPostBody(
      '<script>alert(1)</script>\n\nText with <img src=x onerror=alert(1)> and [a link](javascript:alert(1)).\n\n## <b>Bold</b>\n\n`<code>`',
      { slug: 'a-post' },
    );
    // Every tag in the source arrives as text; no element but the renderer's own is made.
    expect(rendered.html.match(/<[a-z0-9]+/g)).toEqual(['<p', '<p', '<h2', '<p', '<code']);
    expect(rendered.html).not.toContain('href="javascript');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.problems).toEqual(
      expect.arrayContaining([
        'line 1: HTML is shown as text, never run: write Markdown instead',
        'line 3: the link "javascript:alert(1" is not a site path, #anchor or https:// address',
      ]),
    );
  });

  it('renders the shapes the article styles expect', () => {
    const { html } = renderPostBody(
      [
        '## Title',
        'A `code` word, **strong**, *em* and [a page](/docs/).',
        '- one',
        '- two',
        '1. first',
        '```sql caption="The constraint"',
        'SELECT 1 < 2;',
        '```',
        '| A | B |',
        '| --- | --- |',
        '| x \\| y | [z](https://example.com/) |',
        '![A van at the depot](/blog/a-post/van.png)',
      ].join('\n'),
      { slug: 'a-post' },
    );
    expect(html).toBe(
      [
        '<h2>Title</h2>',
        '<p>A <code>code</code> word, <strong>strong</strong>, <em>em</em> and <a href="/docs/">a page</a>.</p>',
        '<ul><li>one</li><li>two</li></ul>',
        '<ol><li>first</li></ol>',
        '<figure><figcaption class="post-meta">The constraint</figcaption><pre><code class="language-sql">SELECT 1 &lt; 2;</code></pre></figure>',
        '<table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>x | y</td><td><a href="https://example.com/">z</a></td></tr></tbody></table>',
        '<figure><img src="/blog/a-post/van.png" alt="A van at the depot" loading="lazy" decoding="async"></figure>',
      ].join('\n'),
    );
  });

  it('fills in facts from the code, and names one it does not know', () => {
    const rendered = renderPostBody('Up to {{facts.holdSlotsMax}} slots, and {{facts.nothing}}.', { slug: 'a-post', facts: { holdSlotsMax: 5 } });
    expect(rendered.html).toBe('<p>Up to 5 slots, and {{facts.nothing}}.</p>');
    expect(rendered.problems).toEqual(['{{facts.nothing}} is not a fact the site knows']);
  });

  it('needs alt text on every image, and only the post\'s own files', () => {
    const rendered = renderPostBody('![](/blog/a-post/van.png)\n\n![A van](https://elsewhere.example/van.png)', { slug: 'a-post' });
    expect(rendered.problems).toEqual([
      'line 1: an image needs alt text: ![what it shows](/blog/a-post/van.png)',
      'line 3: an image is a file of this post, /blog/a-post/<name>.png, .jpg or .webp',
    ]);
    expect(rendered.html).not.toContain('elsewhere.example');
  });

  it('checks a post as the site does before it is submitted', () => {
    const draft = post(`Text with a delve — and [a missing page](/nowhere/). ${words(20)}`, {
      seoTitle: 'x'.repeat(70),
      author: 'nobody',
    });
    const checks = checkPost(draft, renderPostBody(draft.body, { slug: draft.slug }), {
      authors: AUTHORS,
      sitePaths: new Set(['/docs/']),
      otherDescriptions: { 'other-post': draft.front.description },
    });
    const failed = Object.fromEntries(checks.filter((check) => !check.ok).map((check) => [check.name, check.detail]));
    expect(Object.keys(failed).sort()).toEqual(['Author', 'Copy rules', 'Length', 'Links', 'Search title', 'Unique description']);
    expect(failed['Copy rules']).toContain('an em dash');
    expect(failed['Copy rules']).toContain('"delve"');
    expect(failed.Links).toBe('No page at /nowhere/.');
    expect(failed['Unique description']).toBe('The same as the post other-post.');
    expect(copyFindings('A plain sentence.')).toEqual([]);
  });

  it('renders every post in the repository cleanly, and each passes the checks the build does not cover', () => {
    const facts = new Proxy({}, { get: () => 1 }) as Record<string, unknown>;
    // Posts are written in the admin console now, so the repository may hold few or none: the two
    // fixture posts (once published here) keep the checks exercised on real writing.
    const files = ['site/content/blog', 'src/__tests__/fixtures/blog'].flatMap((directory) =>
      readdirSync(directory)
        .filter((file) => file.endsWith('.md'))
        .map((file) => `${directory}/${file}`),
    );
    expect(files.length).toBeGreaterThanOrEqual(2);
    const descriptions: Record<string, string> = {};
    const parsed = files.map((file) => parsePost(readFileSync(file, 'utf8'), (file.split('/').at(-1) as string).slice(0, -3)));
    for (const one of parsed) descriptions[one.slug] = one.front.description;
    for (const one of parsed) {
      const rendered = renderPostBody(one.body, { slug: one.slug, facts });
      expect(rendered.problems, one.slug).toEqual([]);
      const failed = checkPost(one, rendered, { authors: AUTHORS, otherDescriptions: descriptions }).filter((check) => !check.ok);
      expect(failed, one.slug).toEqual([]);
      expect(rendered.prose.split(/\s+/).length).toBeGreaterThanOrEqual(POST_MIN_WORDS);
      // Its Markdown twin names the HTML page and makes site links absolute.
      const twin = postTwin(one, { site: 'https://slotlock.pylota.io', author: AUTHORS.maintainers as PostAuthor, longDate: '11 November 2026', facts });
      expect(twin).toContain(`Page: https://slotlock.pylota.io/blog/${one.slug}/`);
      expect(twin).not.toMatch(/\]\(\/[^/]/);
    }
  });
});
