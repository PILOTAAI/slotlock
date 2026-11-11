import { describe, expect, it } from 'vitest';
import { renderSlotlockMarkdown as md } from '../dashboard-markdown.js';

describe('the assistant reply renderer (dashboard-markdown.ts)', () => {
  it('renders what the dashboard showed as raw asterisks: bold, lists and paragraphs', () => {
    expect(md('No vehicles with the label **"van"** were found.')).toBe(
      '<p>No vehicles with the label <strong>&quot;van&quot;</strong> were found.</p>',
    );
    expect(md('This could mean:\n\n- Vans aren\'t labelled\n- None are set up\n\nAsk me to **list them**.')).toBe(
      '<p>This could mean:</p><ul><li>Vans aren&#39;t labelled</li><li>None are set up</li></ul><p>Ask me to <strong>list them</strong>.</p>',
    );
  });

  it('never lets the reply write markup', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
      '[click](data:text/html,<b>x</b>)',
      '[x](https://a.example/"onmouseover="alert(1))',
      '`<b>code</b>`',
      '```\n<script>alert(1)</script>\n```',
      '| <i>a</i> | b |\n|---|---|\n| <svg onload=alert(1)> | c |',
      '**<u>bold</u>**',
      '> <iframe src=//x>',
    ];
    for (const source of hostile) {
      const out = md(source);
      expect(out, source).not.toMatch(/<(script|img|iframe|svg|u|i|b)\b/i);
      // An event handler only matters inside a tag; escaped text may say anything.
      expect(out, source).not.toMatch(/<[^>]*\son\w+=/i);
      expect(out, source).not.toMatch(/href="(?!https?:\/\/)/);
    }
    // A link's URL stays inside its quoted attribute.
    expect(md('[x](https://a.example/"onmouseover="alert(1))')).not.toContain('href="https://a.example/"o');
  });

  it('links only http and https URLs, and opens nothing in the dashboard’s name', () => {
    expect(md('See [the docs](https://slotlock.pylota.io/docs/).')).toBe(
      '<p>See <a href="https://slotlock.pylota.io/docs/" rel="noopener noreferrer">the docs</a>.</p>',
    );
    expect(md('[x](ftp://example.com/)')).toBe('<p>[x](ftp://example.com/)</p>');
  });

  it('renders headings, ordered and nested lists, quotes, rules and strikethrough', () => {
    expect(md('## Free vans\n1. Van 1\n2. Van 2\n   - morning only')).toBe(
      '<h4>Free vans</h4><ol><li>Van 1</li><li>Van 2<ul><li>morning only</li></ul></li></ol>',
    );
    expect(md('> Booked for Ana\n\n---\n\n~~09:00~~ 10:00')).toBe(
      '<blockquote>Booked for Ana</blockquote><hr><p><del>09:00</del> 10:00</p>',
    );
    expect(md('*one* and _two_ but not snake_case_name or 2*3*4')).toBe(
      '<p><em>one</em> and <em>two</em> but not snake_case_name or 2*3*4</p>',
    );
  });

  it('renders tables and code, keeping code exactly as written', () => {
    expect(md('| Van | Free |\n|---|:-:|\n| Van 1 | **09:00** |')).toBe(
      '<div class="md-table"><table><thead><tr><th>Van</th><th>Free</th></tr></thead><tbody><tr><td>Van 1</td><td><strong>09:00</strong></td></tr></tbody></table></div>',
    );
    expect(md('Use `slotlock key list`:\n\n```sh\na **b** <c>\n```')).toBe(
      '<p>Use <code>slotlock key list</code>:</p><pre><code>a **b** &lt;c&gt;</code></pre>',
    );
  });

  it('renders a reply still streaming: an unclosed fence or bold stays readable', () => {
    expect(md('Here:\n```\nslotlock key')).toBe('<p>Here:</p><pre><code>slotlock key</code></pre>');
    expect(md('Checking **Van')).toBe('<p>Checking **Van</p>');
  });

  it('keeps line breaks inside a paragraph, and drops NUL', () => {
    expect(md('Line one\nLine two\u0000')).toBe('<p>Line one<br>Line two</p>');
  });

  it('is self-contained, so app.js can run its source in the browser', () => {
    const source = md.toString();
    // Bundlers that keep names (Wrangler's esbuild) wrap inner functions in __name(): app.js
    // defines it, and nothing else may come from outside the function.
    const run = new Function('__name', `return (${source});`)((fn: unknown) => fn) as typeof md;
    const sample = '## A\n- **b** [c](https://d.example/)\n\n| e | f |\n|---|---|\n| `g` | h |';
    expect(run(sample)).toBe(md(sample));
  });
});
