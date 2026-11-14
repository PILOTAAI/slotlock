// The blog's post format (site/src/lib/post-format.ts, RFC 0006, 4.5): one renderer for the site's
// build and the admin console's preview, which never lets raw HTML through, and the checks a post
// passes before the console submits it; every picture, video, player, divider, table and file a
// technical post needs, hostile input in each, and a post's files known by their bytes and sizes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POST_EMBED_ORIGINS,
  POST_FILES_MAX,
  POST_FILE_KINDS,
  POST_MIN_WORDS,
  type ParsedPost,
  type PostAuthor,
  checkPost,
  copyFindings,
  parsePost,
  postEmbed,
  postFileProblem,
  postFileType,
  postFilesProblems,
  postTwin,
  renderPostBody,
  serializePost,
} from '../../site/src/lib/post-format.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'blog', 'a-tour-of-post-formats');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const bytes = (text: string, size = text.length) => {
  const out = new Uint8Array(size);
  out.set(Array.from(text, (character) => character.charCodeAt(0)));
  return out;
};
/** The tags in some HTML, in order: the renderer's own and nothing else. */
const tags = (html: string) => html.match(/<[a-z][a-z0-9]*/g) ?? [];

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
        '<div class="table-scroll" role="region" aria-label="Table: A, B" tabindex="0"><table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>x | y</td><td><a href="https://example.com/">z</a></td></tr></tbody></table></div>',
        '<figure><img src="/blog/a-post/van.png" alt="A van at the depot" loading="lazy" decoding="async"></figure>',
      ].join('\n'),
    );
  });

  it('renders each picture, video and player on a line of its own, with alt text and a caption', () => {
    const { html, problems, images, embeds } = renderPostBody(
      [
        '![A van at the depot](/blog/a-post/van.png "The depot at *dawn*.")',
        '![A van](/blog/a-post/van.jpg)',
        '![A van](/blog/a-post/van.jpeg)',
        '![A diagram](/blog/a-post/diagram.webp)',
        '![A chart](/blog/a-post/chart.avif)',
        '![A hold counting down](/blog/a-post/hold.gif)',
        '![The hold as a video](/blog/a-post/hold.mp4 "Thirty seconds.")',
        '![The hold in WebM](/blog/a-post/hold.webm)',
        '![The talk](https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m5s "From the part on holds.")',
        '![The talk, short link](https://youtu.be/M7lc1UVf-VE)',
        '![A short](https://www.youtube.com/shorts/M7lc1UVf-VE)',
        '![On Vimeo](https://vimeo.com/76979871)',
        '![Vimeo player](https://player.vimeo.com/video/76979871)',
      ].join('\n'),
      { slug: 'a-post' },
    );
    expect(problems).toEqual([]);
    const player = (src: string, title: string, caption = '') =>
      `<figure class="embed"><iframe src="${src}" title="${title}" width="560" height="315" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>${caption}</figure>`;
    expect(html.split('\n')).toEqual([
      '<figure><img src="/blog/a-post/van.png" alt="A van at the depot" loading="lazy" decoding="async"><figcaption>The depot at <em>dawn</em>.</figcaption></figure>',
      '<figure><img src="/blog/a-post/van.jpg" alt="A van" loading="lazy" decoding="async"></figure>',
      '<figure><img src="/blog/a-post/van.jpeg" alt="A van" loading="lazy" decoding="async"></figure>',
      '<figure><img src="/blog/a-post/diagram.webp" alt="A diagram" loading="lazy" decoding="async"></figure>',
      '<figure><img src="/blog/a-post/chart.avif" alt="A chart" loading="lazy" decoding="async"></figure>',
      '<figure><img src="/blog/a-post/hold.gif" alt="A hold counting down" loading="lazy" decoding="async"></figure>',
      '<figure><video src="/blog/a-post/hold.mp4" controls preload="metadata" playsinline aria-label="The hold as a video"></video><figcaption>Thirty seconds.</figcaption></figure>',
      '<figure><video src="/blog/a-post/hold.webm" controls preload="metadata" playsinline aria-label="The hold in WebM"></video></figure>',
      player('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=65', 'The talk', '<figcaption>From the part on holds.</figcaption>'),
      player('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', 'The talk, short link'),
      player('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', 'A short'),
      player('https://player.vimeo.com/video/76979871?dnt=1', 'On Vimeo'),
      player('https://player.vimeo.com/video/76979871?dnt=1', 'Vimeo player'),
    ]);
    expect(images.map((image) => image.kind)).toEqual(['image', 'image', 'image', 'image', 'image', 'image', 'video', 'video']);
    expect(embeds.map((embed) => [embed.provider, embed.id])).toEqual([
      ['youtube', 'M7lc1UVf-VE'], ['youtube', 'M7lc1UVf-VE'], ['youtube', 'M7lc1UVf-VE'], ['vimeo', '76979871'], ['vimeo', '76979871'],
    ]);
    // Every frame the renderer can make is from a host the site's CSP names, and only those.
    const headers = readFileSync('site/public/_headers', 'utf8');
    expect(/frame-src ([^;]+);/.exec(headers)?.[1]?.split(' ')).toEqual([...POST_EMBED_ORIGINS]);
    expect(headers).toContain("media-src 'self';");
  });

  it('renders dividers, a table that scrolls sideways, and a PDF of the post to download', () => {
    const { html, problems, files, links } = renderPostBody(
      [
        'Before.',
        '',
        '---',
        '***',
        '',
        '| Approach | **Double** bookings |',
        '| --- | ---: |',
        '| Exclusion constraint | `1` |',
        '',
        'Get [the slides (PDF)](/blog/a-post/slides.pdf), [the screenshot](/blog/a-post/van.png) or [this post](/blog/a-post/#top).',
      ].join('\n'),
      { slug: 'a-post' },
    );
    expect(problems).toEqual([]);
    expect(html.split('\n')).toEqual([
      '<p>Before.</p>',
      '<hr>',
      '<hr>',
      '<div class="table-scroll" role="region" aria-label="Table: Approach, Double bookings" tabindex="0"><table><thead><tr><th scope="col">Approach</th><th scope="col"><strong>Double</strong> bookings</th></tr></thead><tbody><tr><td>Exclusion constraint</td><td><code>1</code></td></tr></tbody></table></div>',
      '<p>Get <a href="/blog/a-post/slides.pdf" type="application/pdf" download>the slides (PDF)</a>, <a href="/blog/a-post/van.png">the screenshot</a> or <a href="/blog/a-post/#top">this post</a>.</p>',
    ]);
    expect(files).toEqual(['slides.pdf', 'van.png']);
    expect(links).toEqual(['/blog/a-post/#top']);
  });

  it('never lets hostile media through: scripts in addresses, malformed players, HTML in alt text and captions', () => {
    const rendered = renderPostBody(
      [
        '![x](javascript:alert(1))',
        '![x](data:image/svg+xml;base64,PHN2Zz4=)',
        '![x](/blog/other-post/van.png)',
        '![x](/blog/a-post/../other-post/van.png)',
        '![x](/blog/a-post/logo.svg)',
        '![x](/blog/a-post/page.html)',
        '![x](/blog/a-post/slides.pdf)',
        '![x](https://www.youtube.com/watch?v=M7lc1UVf-V)',
        '![x](https://www.youtube.com/watch?v=M7lc1UVf-VEX)',
        '![x](https://www.youtube.com/watch?v=M7lc1UVf"VE)',
        '![x](https://www.youtube.com.evil.example/watch?v=M7lc1UVf-VE)',
        '![x](https://evil.example/www.youtube.com/watch?v=M7lc1UVf-VE)',
        '![x](http://www.youtube.com/watch?v=M7lc1UVf-VE)',
        '![x](https://user:pass@www.youtube.com/watch?v=M7lc1UVf-VE)',
        '![x](https://www.youtube.com:8443/watch?v=M7lc1UVf-VE)',
        '![x](https://youtu.be/M7lc1UVf-VE/extra)',
        '![x](https://vimeo.com/76979871abc)',
        '![x](https://vimeo.com/channels/staffpicks/76979871)',
        '![x](https://player.vimeo.com/video/0123)',
        '![<img src=x onerror=alert(1)>](/blog/a-post/van.png "<script>alert(1)</script>")',
        '![" onload="alert(1)](/blog/a-post/hold.mp4)',
        '![<b>Talk</b>](https://youtu.be/M7lc1UVf-VE "</figcaption><iframe src=//evil.example>")',
        'Read [this](javascript:alert(1)) and [that](/blog/a-post/run.exe).',
        '<iframe src="https://evil.example"></iframe>',
      ].join('\n'),
      { slug: 'a-post' },
    );
    // Only the renderer's own elements, and only frames from the two players' hosts.
    expect([...new Set(tags(rendered.html))].sort()).toEqual(['<a', '<figcaption', '<figure', '<iframe', '<img', '<p', '<video'].sort().filter((tag) => tag !== '<a'));
    for (const src of rendered.html.matchAll(/<iframe src="([^"]+)"/g)) expect(POST_EMBED_ORIGINS).toContain(new URL(src[1] as string).origin);
    expect(rendered.html).not.toMatch(/(?:src|href)="(?:javascript|data|http:)/);
    // evil.example is only ever text: never an address a page loads or links to.
    expect(rendered.html).not.toMatch(/(?:src|href)="[^"]*evil\.example/);
    expect(rendered.html).not.toContain('other-post');
    expect(rendered.html).toContain('alt="&lt;img src=x onerror=alert(1)&gt;"');
    expect(rendered.html).toContain('<figcaption>&lt;script&gt;alert(1)&lt;/script&gt;</figcaption>');
    expect(rendered.html).toContain('aria-label="&quot; onload=&quot;alert(1)"');
    expect(rendered.html).toContain('title="&lt;b&gt;Talk&lt;/b&gt;"');
    expect(rendered.html).toContain('<figcaption>&lt;/figcaption&gt;&lt;iframe src=//evil.example&gt;</figcaption>');
    expect(rendered.html).toContain('&lt;iframe src=&quot;https://evil.example&quot;&gt;&lt;/iframe&gt;');
    // Each refused line says why; the four hostile alt texts and captions render, escaped.
    expect(rendered.problems).toHaveLength(22);
    expect(rendered.problems[0]).toBe('line 1: the link "javascript:alert(1" is not a site path, #anchor or https:// address');
    for (const line of [2, 3, 4, 5, 6]) {
      expect(rendered.problems).toContain(`line ${line}: a picture or video is a file of this post, /blog/a-post/<name>.png, .jpg, .webp, .avif, .gif, .mp4 or .webm, or a YouTube or Vimeo address`);
    }
    for (const line of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) expect(rendered.problems.some((problem) => problem.startsWith(`line ${line}: "https`) || problem.startsWith(`line ${line}: "http:`)), String(line)).toBe(true);
    expect(rendered.problems).toContain('line 7: a PDF is a link to download, [What it is (PDF)](/blog/a-post/slides.pdf), not a picture');
    expect(rendered.problems).toContain('line 8: "https://www.youtube.com/watch?v=M7lc1UVf-V" is not a YouTube or Vimeo video: a picture or video is a file of this post, /blog/a-post/<name>.png');
    expect(rendered.problems).toContain('line 23: the link "javascript:alert(1" is not a site path, #anchor or https:// address');
    expect(rendered.problems).toContain('line 23: "/blog/a-post/run.exe" is not a file a post carries: /blog/a-post/<name>.pdf, or a picture or video');
    expect(rendered.problems).toContain('line 24: HTML is shown as text, never run: write Markdown instead');
    // A player without a title, or a picture without alt text, fails.
    expect(renderPostBody('https://youtu.be/M7lc1UVf-VE\n\n![](/blog/a-post/hold.webm)', { slug: 'a-post' }).problems).toEqual([
      'line 1: a video from YouTube needs a title: ![What it shows](https://youtu.be/M7lc1UVf-VE)',
      'line 3: a video needs alt text: ![what it shows](/blog/a-post/hold.webm)',
    ]);
  });

  it('reads a player only from a YouTube or Vimeo address of exactly the right shape', () => {
    expect(postEmbed('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=90')).toEqual({ provider: 'youtube', id: 'M7lc1UVf-VE', src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=90' });
    expect(postEmbed('https://m.youtube.com/watch?v=M7lc1UVf-VE&t=90s')?.src).toBe('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=90');
    expect(postEmbed('https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1h2m3s')?.src).toBe('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=3723');
    expect(postEmbed('https://www.youtube.com/watch?v=M7lc1UVf-VE&t=soon')?.src).toBe('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE');
    for (const address of ['https://www.youtube.com/watch?list=x', 'https://www.youtube.com/', 'https://youtu.be/', 'https://vimeo.com/', 'https://vimeo.com/12345', 'not a url', 'javascript:alert(1)', 'https://www.youtube.com/embed/M7lc1UVf-VE/x']) {
      expect(postEmbed(address), address).toBeNull();
    }
  });

  it('knows a post\'s file by its first bytes, never by its name, and holds each kind to its size', () => {
    const kinds: [string, string][] = [
      ['calendar-week.png', 'png'], ['van-at-dawn.jpg', 'jpg'], ['how-a-hold-works.webp', 'webp'], ['double-bookings-chart.avif', 'avif'],
      ['hold-expires.gif', 'gif'], ['hold-to-booking.mp4', 'mp4'], ['hold-to-booking.webm', 'webm'], ['holds-talk-slides.pdf', 'pdf'],
    ];
    for (const [name, type] of kinds) {
      expect(postFileType(fixture(name)), name).toBe(type);
      expect(postFileProblem(name, fixture(name)), name).toBeNull();
    }
    // Nothing else, whatever it is called.
    expect(postFileType(bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    expect(postFileType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(postFileType(bytes('\0\0\0\x14ftypqt  \0\0\0\0qt  ', 64))).toBeNull();
    expect(postFileType(bytes('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 64))).toBeNull();
    expect(postFileType(bytes('\x1aE\xdf\xa3\x9fB\x86\x81\x01B\x82\x88matroska', 64))).toBeNull();
    expect(postFileType(bytes('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(postFileType(new Uint8Array(0))).toBeNull();
    // Mislabelled, oversized, or not a post's file name.
    expect(postFileProblem('van.gif', fixture('calendar-week.png'))).toBe('van.gif: its bytes are a PNG file, not GIF: name it .png');
    expect(postFileProblem('van.png', bytes('<svg/>'))).toContain('van.png: its bytes are not a PNG, JPEG, WebP, AVIF or GIF picture, an MP4 or WebM video, or a PDF');
    expect(postFileProblem('van.svg', bytes('<svg/>'))).toContain("van.svg: a post's file is named in lowercase words and hyphens");
    expect(postFileProblem('Van.png', fixture('calendar-week.png'))).toContain('a post\'s file is named');
    expect(postFileProblem('van.mov', fixture('hold-to-booking.mp4'))).toContain('a post\'s file is named');
    const big = (name: string, size: number) => {
      const out = new Uint8Array(size);
      out.set(fixture(name));
      return out;
    };
    expect(postFileProblem('big.png', big('calendar-week.png', 5_000_001))).toBe('big.png: 5,000,001 bytes, over the 5 MB a picture may be');
    expect(postFileProblem('big.png', big('calendar-week.png', 5_000_000))).toBeNull();
    expect(postFileProblem('big.gif', big('hold-expires.gif', 10_500_000))).toBe('big.gif: 10.5 MB, over the 10 MB a GIF may be');
    expect(postFileProblem('big.webm', big('hold-to-booking.webm', 20_000_001))).toBe('big.webm: 20,000,001 bytes, over the 20 MB a video may be');
    expect(postFileProblem('big.pdf', big('holds-talk-slides.pdf', 10_000_001))).toContain('over the 10 MB a PDF may be');
    // Under what carries them: Cloudflare's 25 MiB static asset, GitHub's 100 MB, the console Worker's 128 MB.
    for (const kind of Object.values(POST_FILE_KINDS)) expect(kind.max).toBeLessThanOrEqual(20_000_000);
    expect(Math.max(...Object.values(POST_FILE_KINDS).map((kind) => kind.max))).toBeLessThan(25 * 1024 * 1024);
  });

  it('checks a post\'s folder as the build does: each file, how many, how much, and every one the post shows', () => {
    const rendered = renderPostBody('![A van](/blog/a-post/van.png)\n\n![Hold](/blog/a-post/hold.mp4)\n\nGet [the slides](/blog/a-post/slides.pdf).', { slug: 'a-post' });
    const png = { name: 'van.png', bytes: fixture('calendar-week.png') };
    expect(postFilesProblems('a-post', [png, { name: 'hold.mp4', bytes: fixture('hold-to-booking.mp4') }, { name: 'slides.pdf', bytes: fixture('holds-talk-slides.pdf') }], rendered)).toEqual([]);
    expect(postFilesProblems('a-post', [png, { name: 'evil.png', bytes: bytes('<svg/>') }], rendered)).toEqual([
      expect.stringContaining('evil.png: its bytes are not'),
      'hold.mp4 is not in public/blog/a-post/',
      'slides.pdf is not in public/blog/a-post/',
    ]);
    const many = Array.from({ length: POST_FILES_MAX + 1 }, (_, index) => ({ name: `van-${index}.png`, bytes: fixture('calendar-week.png') }));
    expect(postFilesProblems('a-post', many)).toEqual([`${POST_FILES_MAX + 1} files, over the ${POST_FILES_MAX} a post may have`]);
    const heavy = Array.from({ length: 3 }, (_, index) => {
      const out = new Uint8Array(19_000_000);
      out.set(fixture('hold-to-booking.mp4'));
      return { name: `hold-${index}.mp4`, bytes: out };
    });
    expect(postFilesProblems('a-post', heavy)).toEqual(['57 MB of files, over the 50 MB a post may have']);
  });

  it('counts a post\'s media in its checks, and names a file it shows that is not uploaded', () => {
    const draft = post(`![A van](/blog/a-post/van.png)\n\n![Hold](/blog/a-post/hold.webm)\n\n![The talk](https://youtu.be/M7lc1UVf-VE)\n\nGet [the slides](/blog/a-post/slides.pdf). ${words(10)}`);
    const rendered = renderPostBody(draft.body, { slug: draft.slug });
    const media = (files: string[]) => checkPost(draft, rendered, { authors: AUTHORS, imageFiles: new Set(files) }).find((check) => check.name === 'Media');
    expect(media(['van.png', 'hold.webm', 'slides.pdf'])).toEqual({ name: 'Media', ok: true, detail: '1 picture, 1 video, 1 player, 1 file, each described in 1 to 200 characters.' });
    expect(media(['van.png'])).toEqual({ name: 'Media', ok: false, detail: 'Not uploaded: hold.webm, slides.pdf.' });
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
      'line 3: "https://elsewhere.example/van.png" is not a YouTube or Vimeo video: a picture or video is a file of this post, /blog/a-post/<name>.png',
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
    // Staff add and delete posts in the admin console, so the repository may hold few or none: the
    // two fixture posts (copies of published ones) keep the checks exercised on real writing.
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
