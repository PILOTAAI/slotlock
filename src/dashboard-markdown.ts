// The assistant's replies are Markdown. This renders the part of it a chat reply uses (paragraphs,
// headings, lists, quotes, rules, tables, code, bold, italic, strikethrough, http(s) links) as HTML,
// escaping everything first, so no input reaches the page as markup.
//
// It is one self-contained function on purpose: the dashboard's app.js embeds its source
// (Function.prototype.toString) to render a reply while it streams, and the server renders the
// stored reply with the very same function, so both always agree. Keep it free of imports and of
// anything outside its own body.

/** Safe HTML for a chat reply written in Markdown. */
export function renderSlotlockMarkdown(source: string): string {
  const text = String(source).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const inline = (value: string): string => {
    const codes: string[] = [];
    let out = value.replace(/`([^`\n]+)`/g, (_match, code: string) => {
      codes.push(`<code>${escape(code)}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    const links: string[] = [];
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
      links.push(`<a href="${escape(url)}" rel="noopener noreferrer">${escape(label)}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    });
    out = escape(out)
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([^\n]*?\S)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>');
    return out
      .replace(/\u0001(\d+)\u0001/g, (_match, index: string) => {
        const link = links[Number(index)] ?? '';
        // A link's label keeps its own emphasis out: it was escaped whole.
        return link;
      })
      .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
  };

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  const isRule = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

  const lines = text.split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const close = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(close)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push(`<pre><code>${escape(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push(`<h4>${inline(heading[2] ?? '')}</h4>`);
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && !listItem.test(line.replace(/\s+$/, '') + ' x')) {
      flush();
      blocks.push('<hr>');
      i += 1;
      continue;
    }
    if (line.includes('|') && isRule(lines[i + 1] ?? '') && cells(line).length > 1) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      blocks.push(
        `<div class="md-table"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${head.map((_cell, index) => `<td>${inline(row[index] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote>${quoted.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (listItem.test(line)) {
      flush();
      // Lists nest by indentation; each level is the kind (ordered or not) of its first item.
      let html = '';
      const open: { indent: number; tag: string }[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = listItem.exec(current);
        if (!item) {
          // A wrapped line continues the item above it; a blank line or anything else ends the list.
          if (current.trim() !== '' && /^\s+\S/.test(current) && open.length > 0) {
            html += `<br>${inline(current.trim())}`;
            i += 1;
            continue;
          }
          break;
        }
        const indent = (item[1] ?? '').replace(/\t/g, '    ').length;
        const tag = /\d/.test(item[2] ?? '') ? 'ol' : 'ul';
        const top = open.at(-1);
        if (!top || indent > top.indent + 1) {
          if (top) html = html.replace(/<\/li>$/, '');
          html += `<${tag}>`;
          open.push({ indent, tag });
        } else {
          while (open.length > 1 && indent < (open.at(-1)?.indent ?? 0) - 1) {
            html += `</li></${open.pop()?.tag}>`;
          }
          html += '</li>';
        }
        html += `<li>${inline(item[3] ?? '')}`;
        i += 1;
      }
      while (open.length > 0) html += `</li></${open.pop()?.tag}>`;
      blocks.push(html);
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return blocks.join('');
}
