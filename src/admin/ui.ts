// The admin console's pages as server-rendered HTML (RFC 0006, 4.1 and 4.7): the escaping `html`
// template the customer dashboard uses, the shell (sidebar, top bar with search, notices), a few
// components (stat tiles, pills, tables, a bar chart drawn in SVG), the stylesheet and the two
// small scripts. Everything is a file under a strict CSP: no inline script, style block or style
// attribute, so a value that slips past escaping still cannot run.
//
// The look is the Slotlock site's: its colour tokens (site/src/styles/tokens.mjs, Pylota's), in
// light and dark, with the density an operator's tables need. Patterns from goshenemail.com and
// Mobbin (RFC 0006, 4.7): counts on sidebar items, plain status words, one primary action a page,
// a details rail beside an account.

/** Text that is already HTML: the template does not escape it again. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Tagged template that escapes every interpolated value unless it is already `Html`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      if (part === null || part === undefined || part === false) continue;
      out += part instanceof Html ? part.value : escapeHtml(String(part));
    }
    out += strings[index + 1] ?? '';
  });
  return new Html(out);
}

export interface NavItem {
  href: string;
  label: string;
  count?: number | null;
}

export interface Shell {
  title: string;
  /** The path the nav marks as current: itself, or the section it is in. */
  path: string;
  nav: NavItem[];
  staff: { login: string; role: string };
  csrf: string;
  query?: string;
  notice?: { kind: 'done' | 'warn'; text: string } | null;
}

const isCurrent = (path: string, href: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);

/** A page inside the console: sidebar, top bar with search, then the page itself. */
export function layout(shell: Shell, body: Html): Html {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${shell.title} · Slotlock admin</title>
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="side" aria-label="Admin">
    <a class="brand" href="/">${LOGO}<span>Slotlock</span><span class="badge">Admin</span></a>
    <nav class="nav" aria-label="Sections">
      ${shell.nav.map(
        (item) => html`<a href="${item.href}" ${isCurrent(shell.path, item.href) ? new Html('aria-current="page"') : ''}>
          <span>${item.label}</span>${item.count ? html`<span class="count">${item.count.toLocaleString('en-GB')}</span>` : ''}
        </a>`,
      )}
    </nav>
    <div class="side-foot">
      <p class="who"><strong>${shell.staff.login}</strong><span>${shell.staff.role}</span></p>
      <form method="post" action="/sign-out">
        <input type="hidden" name="csrf" value="${shell.csrf}">
        <button class="link" type="submit">Sign out</button>
      </form>
    </div>
  </aside>
  <div class="main-col">
    <header class="top">
      <form class="search" method="get" action="/search" role="search">
        <label class="sr-only" for="q">Find an account</label>
        <input id="q" name="q" type="search" value="${shell.query ?? ''}" placeholder="Find an account: GitHub login or id, slk_ key, cus_ customer, team name" autocomplete="off" spellcheck="false">
        <kbd>⌘K</kbd>
      </form>
    </header>
    <main id="main" class="content">
      ${shell.notice ? html`<p class="notice ${shell.notice.kind}" role="status">${shell.notice.text}</p>` : ''}
      ${body}
    </main>
  </div>
</div>
</body>
</html>`;
}

/** A page outside the console's shell: sign-in, passkey, refusals. */
export function plainPage(title: string, body: Html, script?: string): Html {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Slotlock admin</title>
<link rel="stylesheet" href="/admin.css">
${script ? html`<script src="${script}" defer></script>` : ''}
</head>
<body class="plain">
<main class="card-wrap">
  <div class="card">
    <p class="card-logo">${LOGO}</p>
    ${body}
  </div>
</main>
</body>
</html>`;
}

/** The page title, with an eyebrow and an optional lede and actions. */
export function pageHead(eyebrow: string, title: string, lede?: string | Html | null, actions?: Html): Html {
  return html`<div class="page-head">
    <div>
      <p class="eyebrow">${eyebrow}</p>
      <h1>${title}</h1>
      ${lede ? html`<p class="lede">${lede}</p>` : ''}
    </div>
    ${actions ?? ''}
  </div>`;
}

export interface Stat {
  label: string;
  value: string;
  note?: string | null;
  href?: string;
}

export function stats(items: Stat[]): Html {
  return html`<ul class="stats">${items.map(
    (item) => html`<li>${item.href ? html`<a href="${item.href}">` : ''}
      <span class="stat-label">${item.label}</span>
      <strong class="stat-value">${item.value}</strong>
      ${item.note ? html`<span class="stat-note">${item.note}</span>` : ''}
    ${item.href ? new Html('</a>') : ''}</li>`,
  )}</ul>`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info';

export function pill(text: string, tone: Tone = 'muted'): Html {
  return html`<span class="pill ${tone}">${text}</span>`;
}

/** A table whose cells are already HTML; on a phone each row stacks with its labels. */
export function table(caption: string, columns: string[], rows: Html[][], empty: string): Html {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<div class="table-wrap"><table>
    <caption class="sr-only">${caption}</caption>
    <thead><tr>${columns.map((column) => html`<th scope="col">${column}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) => html`<tr>${row.map((cell, index) => html`<td data-label="${columns[index] ?? ''}">${cell}</td>`)}</tr>`,
    )}</tbody>
  </table></div>`;
}

/** A bar chart of daily counts, drawn in SVG (attributes, never style), with an accessible summary. */
export function bars(label: string, points: { day: string; count: number }[], days = 30): Html {
  const today = new Date();
  const series: { day: string; count: number }[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back))
      .toISOString()
      .slice(0, 10);
    series.push({ day, count: points.find((point) => point.day === day)?.count ?? 0 });
  }
  const max = Math.max(1, ...series.map((point) => point.count));
  const width = 600;
  const height = 120;
  const step = width / series.length;
  const total = series.reduce((sum, point) => sum + point.count, 0);
  return html`<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}: ${total} in ${days} days" preserveAspectRatio="none">
      ${series.map((point, index) => {
        const h = Math.round((point.count / max) * (height - 4));
        return html`<rect x="${(index * step + 1).toFixed(1)}" y="${height - h}" width="${(step - 2).toFixed(1)}" height="${h}" rx="2"><title>${point.day}: ${point.count}</title></rect>`;
      })}
    </svg>
    <figcaption>${label} · ${total.toLocaleString('en-GB')} in ${days} days</figcaption>
  </figure>`;
}

export const when = (value: string | Date | null | undefined): string => {
  if (!value) return '–';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toISOString().replace('T', ' ').slice(0, 16);
};

export const day = (value: string | Date | null | undefined): string => {
  if (!value) return '–';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '–' : date.toISOString().slice(0, 10);
};

export const count = (value: number | string | bigint | null | undefined): string =>
  value === null || value === undefined ? '–' : Number(value).toLocaleString('en-GB');

/** The padlock of the Slotlock logo, ink and the Signal slot. */
const LOGO = new Html(
  '<svg class="logo" viewBox="0 0 86 78" aria-hidden="true" focusable="false"><path class="logo-ink" d="M13.13 34.46L72.2 34.46C79.45 34.46 85.32 40.33 85.32 47.58L85.32 63.99C85.32 71.24 79.45 77.12 72.2 77.12L13.13 77.12C5.88 77.12 0 71.24 0 63.99L0 47.58C0 40.33 5.88 34.46 13.13 34.46ZM22.97 39.38L22.97 19.69C22.97 8.82 31.79 0 42.66 0C53.54 0 62.35 8.82 62.35 19.69L62.35 39.38L56.61 39.38L56.61 19.69C56.61 11.99 50.36 5.74 42.66 5.74C34.96 5.74 28.71 11.99 28.71 19.69L28.71 39.38Z"/><path class="logo-slot" d="M19.69 52.51L65.63 52.51C67.45 52.51 68.91 53.98 68.91 55.79C68.91 57.6 67.45 59.07 65.63 59.07L19.69 59.07C17.88 59.07 16.41 57.6 16.41 55.79C16.41 53.98 17.88 52.51 19.69 52.51Z"/></svg>',
);

/** Light and dark tokens: the Slotlock site's (site/src/styles/tokens.mjs). */
const TOKENS = {
  light: {
    canvas: '#F6F4EE', 'canvas-2': '#EEEBE3', paper: '#FFFFFF', ink: '#171716', 'ink-2': '#5D5B56',
    'ink-3': '#6B6963', line: 'rgba(26,26,26,0.10)', 'line-2': 'rgba(26,26,26,0.06)',
    accent: '#2655FF', 'accent-ink': '#0E2D9E', 'accent-soft': '#E8EDFF', good: '#167758',
    'good-soft': '#E4F3EC', warn: '#935D12', 'warn-soft': '#F7EBD6', bad: '#A32D2D', 'bad-soft': '#F4E0DF',
  },
  dark: {
    canvas: '#000000', 'canvas-2': '#0A0A0B', paper: '#0E0E10', ink: '#F7F7F7', 'ink-2': '#CFCFCF',
    'ink-3': '#9E9E9E', line: 'rgba(255,255,255,0.10)', 'line-2': 'rgba(255,255,255,0.06)',
    accent: '#AAC0FF', 'accent-ink': '#AAC0FF', 'accent-soft': '#141B33', good: '#4CC49A',
    'good-soft': '#0F2A21', warn: '#E8B76B', 'warn-soft': '#2D2312', bad: '#E87373', 'bad-soft': '#2F1717',
  },
} as const;
const vars = (set: Record<string, string>) =>
  Object.entries(set)
    .map(([name, value]) => `--${name}:${value};`)
    .join('');

export const SLOTLOCK_ADMIN_CSS = `
:root{${vars(TOKENS.light)}--radius:12px;--font:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(TOKENS.dark)}}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--canvas);color:var(--ink);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:inherit}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;padding:8px 12px;background:var(--ink);color:var(--paper);border-radius:999px;z-index:10}
.skip:focus{top:12px}
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:20px;padding:18px 14px;border-right:1px solid var(--line);background:var(--canvas-2)}
.brand{display:flex;align-items:center;gap:8px;padding:4px 8px;text-decoration:none;font-weight:600}
.logo{width:22px;height:20px}.logo-ink{fill:currentColor}.logo-slot{fill:#FF5B2E}
.badge{font:500 10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);border:1px solid var(--line);border-radius:999px;padding:3px 6px}
.nav{display:grid;gap:2px}
.nav a{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:8px;color:var(--ink-2);text-decoration:none}
.nav a:hover{background:var(--line-2);color:var(--ink)}
.nav a[aria-current]{background:var(--line);color:var(--ink);font-weight:500}
.count{font:500 11px/1 var(--mono);padding:3px 6px;border-radius:999px;background:var(--paper);border:1px solid var(--line);color:var(--ink-2)}
.side-foot{margin-top:auto;display:grid;gap:6px;padding:10px;border-top:1px solid var(--line)}
.who{margin:0;display:grid}.who span{color:var(--ink-3);font-size:12px;text-transform:capitalize}
.link{all:unset;cursor:pointer;color:var(--ink-2);font-size:13px}.link:hover{color:var(--ink);text-decoration:underline}
.link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:12px 28px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.search{position:relative;flex:1;max-width:620px}
.search input{width:100%;padding:9px 52px 9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit}
.search input:focus{outline:2px solid var(--accent);outline-offset:1px}
.search kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font:500 11px var(--mono);color:var(--ink-3);border:1px solid var(--line);border-radius:6px;padding:2px 5px}
.content{padding:28px;max-width:1240px}
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.eyebrow{margin:0 0 6px;font:500 11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
h1{margin:0;font-size:26px;font-weight:600;letter-spacing:-.015em}
h2{margin:30px 0 12px;font-size:16px;font-weight:600}
.lede{margin:6px 0 0;color:var(--ink-2);max-width:60ch}
.notice{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--paper)}
.notice.done{border-color:var(--good);background:var(--good-soft)}
.notice.warn{border-color:var(--warn);background:var(--warn-soft)}
.stats{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.stats li{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius)}
.stats li>a{display:grid;gap:4px;padding:14px 16px;text-decoration:none}
.stats li:not(:has(a)){display:grid;gap:4px;padding:14px 16px}
.stats li>a:hover{background:var(--line-2);border-radius:var(--radius)}
.stat-label{color:var(--ink-3);font-size:12px}
.stat-value{font-size:24px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.stat-note{color:var(--ink-3);font-size:12px}
.grid-2{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.attention{list-style:none;margin:0;display:grid;gap:10px}.attention li{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.attention .sub{color:var(--ink-3);font-size:13px}
.rail dl{margin:0;display:grid;gap:10px}
.rail dt{color:var(--ink-3);font-size:12px}.rail dd{margin:0;overflow-wrap:anywhere}
.table-wrap{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);overflow:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:10px 14px;text-align:left;border-top:1px solid var(--line-2);vertical-align:top}
thead th{border-top:0;font:500 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);white-space:nowrap}
tbody tr:hover td{background:var(--line-2)}
td a{text-decoration:none;font-weight:500}td a:hover{text-decoration:underline}
.mono,code{font-family:var(--mono);font-size:12.5px}
.sub{display:block;color:var(--ink-3);font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid transparent;white-space:nowrap}
.pill.good{background:var(--good-soft);color:var(--good)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.info{background:var(--accent-soft);color:var(--accent-ink)}
.pill.muted{border-color:var(--line);color:var(--ink-2)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.filters input,.filters select{padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:500 14px var(--font);text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--ink-3)}.btn.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.btn:focus-visible,.nav a:focus-visible,td a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pager{display:flex;justify-content:flex-end;margin-top:12px}
.empty{padding:28px;text-align:center;color:var(--ink-3);background:var(--paper);border:1px dashed var(--line);border-radius:var(--radius)}
.chart{margin:0;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:14px 14px 10px}
.chart svg{width:100%;height:120px;display:block}.chart rect{fill:var(--accent)}
.chart figcaption{margin-top:8px;color:var(--ink-3);font-size:12px}
.meter{display:grid;gap:4px;margin:0 0 12px}.meter span{display:flex;justify-content:space-between;font-size:13px}
.meter progress{width:100%;height:6px;border:0;border-radius:999px;background:var(--line);appearance:none;-webkit-appearance:none;overflow:hidden}
.meter progress::-webkit-progress-bar{background:var(--line)}.meter progress::-webkit-progress-value{background:var(--ink)}.meter progress::-moz-progress-bar{background:var(--ink)}
body.plain{display:grid;place-items:center;min-height:100vh;padding:16px}
.card{width:min(400px,100%);background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.06)}
.card h1{font-size:20px}.card p{color:var(--ink-2)}
.card-logo{margin:0 0 14px;width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--line);border-radius:12px}
.card form{display:grid;gap:10px;margin-top:16px}
.card input{padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--canvas);color:var(--ink);font:inherit}
.card .btn{justify-content:center}
.fine{font-size:12px;color:var(--ink-3)}
@media (max-width:860px){.app{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center}.nav{display:flex;flex-wrap:wrap}.side-foot{margin:0;border:0;padding:0}.grid-2{grid-template-columns:1fr}.content{padding:18px 16px}.top{padding:10px 16px}
thead{display:none}tr{display:block;border-top:1px solid var(--line-2)}td{display:flex;justify-content:space-between;gap:12px;border:0;padding:6px 14px}td::before{content:attr(data-label);color:var(--ink-3);font-size:12px}}
`;

/**
 * Progressive enhancement only: ⌘K or Ctrl+K (and /) focus the search; "g" then h, a, s or l goes
 * to Home, Accounts, Staff or the staff log; a button with data-copy copies its value.
 */
export const SLOTLOCK_ADMIN_JS = `(() => {
  const search = document.getElementById('q');
  let pending = false;
  const go = { h: '/', a: '/accounts', s: '/staff', l: '/staff/log' };
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      search?.focus();
      search?.select();
      return;
    }
    if (typing) return;
    if (event.key === '/') { event.preventDefault(); search?.focus(); return; }
    if (pending && go[event.key]) { window.location.assign(go[event.key]); pending = false; return; }
    pending = event.key === 'g';
  });
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.hidden = false;
    button.addEventListener('click', () => {
      navigator.clipboard?.writeText(button.getAttribute('data-copy') || '');
      button.textContent = 'Copied';
    });
  }
})();
`;

/**
 * The passkey page's script: ask the server for options, run the browser's WebAuthn ceremony, and
 * send the result back. The server checks everything; this only carries bytes.
 */
export const SLOTLOCK_ADMIN_PASSKEY_JS = `(() => {
  const form = document.getElementById('passkey');
  if (!form || !window.PublicKeyCredential) {
    const note = document.getElementById('passkey-unsupported');
    if (note) note.hidden = false;
    return;
  }
  const status = document.getElementById('passkey-status');
  const toBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const toText = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-slotlock-admin': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The passkey was refused.');
    return data;
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const purpose = form.dataset.purpose;
    const code = form.querySelector('[name=code]')?.value || null;
    const name = form.querySelector('[name=name]')?.value || 'Passkey';
    status.textContent = 'Waiting for your passkey…';
    try {
      const options = await post('/passkey/options', { purpose });
      if (purpose === 'create') {
        const credential = await navigator.credentials.create({ publicKey: {
          ...options,
          challenge: toBytes(options.challenge),
          user: { ...options.user, id: toBytes(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: toBytes(item.id) })),
        } });
        await post('/passkey/register', {
          code, name, id: credential.id,
          attestationObject: toText(credential.response.attestationObject),
          clientDataJSON: toText(credential.response.clientDataJSON),
        });
      } else {
        const credential = await navigator.credentials.get({ publicKey: {
          ...options,
          challenge: toBytes(options.challenge),
          allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: toBytes(item.id) })),
        } });
        await post('/passkey/verify', {
          id: credential.id,
          authenticatorData: toText(credential.response.authenticatorData),
          clientDataJSON: toText(credential.response.clientDataJSON),
          signature: toText(credential.response.signature),
        });
      }
      window.location.assign(form.dataset.next || '/');
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The passkey was refused.';
    }
  });
})();
`;
