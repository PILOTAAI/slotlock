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
  /** A page's own script, beside admin.js (the CMS editor's). */
  script?: string;
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
${shell.script ? html`<script src="${shell.script}" defer></script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="side" aria-label="Admin">
    <a class="brand" href="/">${LOCKUP}<span class="badge">Admin</span></a>
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

/**
 * The Slotlock logo from the design system (Logos): the lock alone, and the lock with the wordmark.
 * Ink with a lime slot on a light surface; lime with the slot cut out, and a paper wordmark, on a dark
 * one (the CSS below).
 */
const LOGO = new Html(
  '<svg class="logo" viewBox="0 0 48 55.5" aria-hidden="true" focusable="false"><g transform="translate(-8 -4.5)"><path class="logo-shackle" d="M20 30V20a12 12 0 0 1 24 0V30"/><rect class="logo-body" x="8" y="28" width="48" height="32" rx="9"/><path class="logo-cut" fill-rule="evenodd" d="M17 28h30a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9V37a9 9 0 0 1 9-9ZM32 37a3 3 0 0 0-3 3v9a3 3 0 0 0 6 0v-9a3 3 0 0 0-3-3Z"/><rect class="logo-slot" x="29" y="37" width="6" height="15" rx="3"/></g></svg>',
);
const LOCKUP = new Html(
  '<svg class="lockup" viewBox="0 0 280.14 55.5" role="img" aria-label="Slotlock" focusable="false"><g transform="translate(-8 -4.5)"><path class="logo-shackle" d="M20 30V20a12 12 0 0 1 24 0V30"/><rect class="logo-body" x="8" y="28" width="48" height="32" rx="9"/><path class="logo-cut" fill-rule="evenodd" d="M17 28h30a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9V37a9 9 0 0 1 9-9ZM32 37a3 3 0 0 0-3 3v9a3 3 0 0 0 6 0v-9a3 3 0 0 0-3-3Z"/><rect class="logo-slot" x="29" y="37" width="6" height="15" rx="3"/></g><path class="logo-word" transform="translate(62 55.5)" d="M16.01 0.81Q12.93 0.81 10.44 0.23Q7.95 -0.35 6.15 -1.45Q4.35 -2.55 3.25 -4.09Q2.15 -5.63 1.8 -7.54L8.18 -10.15Q8.41 -8.87 9.45 -7.77Q10.5 -6.67 12.27 -6Q14.04 -5.34 16.53 -5.34Q19.2 -5.34 20.65 -6.12Q22.1 -6.9 22.1 -8.35Q22.1 -9.45 21.29 -10.09Q20.47 -10.73 18.91 -11.19Q17.34 -11.66 15.14 -12.06Q12.99 -12.59 10.76 -13.17Q8.53 -13.75 6.64 -14.79Q4.76 -15.83 3.57 -17.55Q2.38 -19.26 2.38 -21.92Q2.38 -24.71 3.89 -26.8Q5.39 -28.88 8.29 -30.07Q11.19 -31.26 15.37 -31.26Q19.14 -31.26 21.98 -30.25Q24.82 -29.23 26.65 -27.35Q28.48 -25.46 29.12 -22.85L22.33 -20.59Q22.1 -21.98 21.2 -23.03Q20.3 -24.07 18.82 -24.59Q17.34 -25.11 15.37 -25.11Q12.88 -25.11 11.51 -24.3Q10.15 -23.49 10.15 -22.16Q10.15 -21.05 11.05 -20.36Q11.95 -19.66 13.57 -19.23Q15.2 -18.79 17.4 -18.33Q19.72 -17.86 21.92 -17.26Q24.13 -16.65 25.9 -15.66Q27.67 -14.67 28.71 -13.05Q29.75 -11.43 29.75 -8.87Q29.75 -5.86 28.13 -3.68Q26.51 -1.51 23.43 -0.35Q20.36 0.81 16.01 0.81Z M34.63 0V-41.47H42.86V0Z M63.45 0.81Q58.87 0.81 55.39 -1.02Q51.91 -2.84 49.94 -6.41Q47.97 -9.98 47.97 -15.31Q47.97 -20.65 49.97 -24.19Q51.97 -27.72 55.48 -29.49Q58.99 -31.26 63.45 -31.26Q68.03 -31.26 71.54 -29.46Q75.05 -27.67 77.05 -24.1Q79.05 -20.53 79.05 -15.2Q79.05 -9.8 77 -6.24Q74.94 -2.67 71.43 -0.93Q67.92 0.81 63.45 0.81ZM63.74 -5.39Q66 -5.39 67.54 -6.44Q69.08 -7.48 69.86 -9.6Q70.64 -11.72 70.64 -14.73Q70.64 -17.92 69.8 -20.16Q68.96 -22.39 67.34 -23.58Q65.71 -24.77 63.22 -24.77Q61.07 -24.77 59.51 -23.75Q57.94 -22.74 57.13 -20.62Q56.32 -18.5 56.32 -15.43Q56.32 -10.5 58.29 -7.95Q60.26 -5.39 63.74 -5.39Z M95.41 0.7Q90.31 0.7 87.9 -2Q85.49 -4.7 85.49 -10.61V-23.9H81.08L81.2 -30.45H84.27Q86.07 -30.45 86.94 -30.97Q87.81 -31.49 87.99 -32.89L88.74 -37.24H93.5V-30.45H101.21V-23.66H93.5V-10.96Q93.5 -8.87 94.48 -7.95Q95.47 -7.02 97.5 -7.02Q98.6 -7.02 99.62 -7.25Q100.63 -7.48 101.38 -8V-0.23Q99.59 0.35 98.08 0.52Q96.57 0.7 95.41 0.7Z M106.26 0V-41.47H114.49V0Z M135.08 0.81Q130.5 0.81 127.02 -1.02Q123.54 -2.84 121.57 -6.41Q119.6 -9.98 119.6 -15.31Q119.6 -20.65 121.6 -24.19Q123.6 -27.72 127.11 -29.49Q130.62 -31.26 135.08 -31.26Q139.66 -31.26 143.17 -29.46Q146.68 -27.67 148.68 -24.1Q150.68 -20.53 150.68 -15.2Q150.68 -9.8 148.63 -6.24Q146.57 -2.67 143.06 -0.93Q139.55 0.81 135.08 0.81ZM135.37 -5.39Q137.63 -5.39 139.17 -6.44Q140.71 -7.48 141.49 -9.6Q142.27 -11.72 142.27 -14.73Q142.27 -17.92 141.43 -20.16Q140.59 -22.39 138.97 -23.58Q137.34 -24.77 134.85 -24.77Q132.7 -24.77 131.14 -23.75Q129.57 -22.74 128.76 -20.62Q127.95 -18.5 127.95 -15.43Q127.95 -10.5 129.92 -7.95Q131.89 -5.39 135.37 -5.39Z M169.82 0.81Q165.88 0.81 162.92 -0.35Q159.96 -1.51 157.99 -3.6Q156.02 -5.68 155.03 -8.55Q154.05 -11.43 154.05 -14.85Q154.05 -18.44 155.06 -21.43Q156.08 -24.42 158.05 -26.62Q160.02 -28.83 162.92 -30.04Q165.82 -31.26 169.53 -31.26Q173.25 -31.26 176 -30.04Q178.76 -28.83 180.47 -26.65Q182.18 -24.48 182.82 -21.52L175.1 -19.02Q174.93 -20.82 174.15 -22.13Q173.36 -23.43 172.06 -24.1Q170.75 -24.77 169.13 -24.77Q167.45 -24.77 166.23 -24.1Q165.01 -23.43 164.17 -22.19Q163.33 -20.94 162.89 -19.17Q162.46 -17.4 162.46 -15.2Q162.46 -12.06 163.3 -9.89Q164.14 -7.71 165.79 -6.58Q167.45 -5.45 169.88 -5.45Q172.2 -5.45 173.59 -6.35Q174.99 -7.25 175.65 -8.67Q176.32 -10.09 176.49 -11.6L183.8 -9.98Q183.51 -7.71 182.56 -5.74Q181.6 -3.77 179.86 -2.32Q178.12 -0.87 175.65 -0.03Q173.19 0.81 169.82 0.81Z M187.69 0V-41.47H195.92V-18.44Q197.72 -19.66 199.38 -21.08Q201.03 -22.5 202.39 -24.07Q203.75 -25.64 204.83 -27.26Q205.9 -28.88 206.65 -30.45H216.22Q215.35 -28.25 213.93 -26.01Q212.51 -23.78 210.57 -21.9Q208.63 -20.01 206.07 -18.68Q203.52 -17.34 200.45 -16.88V-15.89Q204.33 -16.59 206.89 -15.78Q209.44 -14.96 211.09 -13.2Q212.74 -11.43 213.73 -9.13Q214.72 -6.84 215.53 -4.52L216.86 0H207.76L207 -2.84Q206.19 -5.68 205.2 -7.83Q204.22 -9.98 202.62 -11.17Q201.03 -12.35 198.24 -12.35H195.92V0Z"/></svg>',
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
.logo{width:19px;height:22px}.lockup{display:block;height:20px;width:auto;aspect-ratio:280.14/55.5}.logo-word{fill:#0a0b0d}.logo-shackle{fill:none;stroke:#0a0b0d;stroke-width:7}.logo-body,.logo-cut{fill:#0a0b0d}.logo-slot{fill:#d9ff43}.logo-cut{display:none}
@media (prefers-color-scheme:dark){.logo-word{fill:#f4f3ee}.logo-shackle{stroke:#d9ff43}.logo-cut{fill:#d9ff43;display:inline}.logo-body,.logo-slot{display:none}}
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
.form{display:grid;gap:8px;max-width:560px}.form p{margin:0;color:var(--ink-2)}
.form label{font-weight:500;font-size:13px}.hint{font-weight:400;color:var(--ink-3)}
.form input,.form textarea,.form select{padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:var(--canvas);color:var(--ink);font:inherit;width:100%}
.form textarea{resize:vertical;min-height:64px}
.form input:focus,.form textarea:focus,.form select:focus{outline:2px solid var(--accent);outline-offset:1px}
.form .btn{justify-self:start}
details.act{position:relative;display:inline-block}details.act.wide{display:block;margin:10px 0}
details.act>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;padding:5px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;font-weight:500;background:var(--paper)}
details.act>summary::-webkit-details-marker{display:none}
details.act>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
details.act[open]>summary{border-color:var(--ink-3)}
.pop{margin-top:8px;padding:14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);min-width:min(320px,80vw)}
.rail .pop{min-width:0;padding:10px}
.btn.danger{background:var(--bad);border-color:var(--bad);color:var(--paper)}.btn.danger:hover{filter:brightness(1.08)}
.danger-zone{margin-top:28px;padding:16px;border:1px solid var(--bad);border-radius:var(--radius);background:var(--bad-soft)}
.danger-zone h2{margin-top:0;color:var(--bad)}
.danger-zone .hint,.danger-zone p{color:var(--ink-2)}
.notice p{margin:0 0 4px}.notice p:last-child{margin:0}
.list{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:8px}.list li{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.notes li{display:block;padding:8px 0;border-top:1px solid var(--line-2)}.notes li:first-child{border-top:0}
.pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.rail h3{margin:18px 0 8px;font-size:13px;font-weight:600}
.subhead{margin:18px 0 8px;font-size:14px;font-weight:600}
pre.pop{max-height:320px;overflow:auto;font-size:12px}
.tabs{display:flex;gap:4px;margin:0 0 12px}.tab{padding:6px 12px;border-radius:8px;color:var(--ink-2);text-decoration:none;font-weight:500}
.tab[aria-current]{background:var(--paper);color:var(--ink);border:1px solid var(--line)}
.sub-inline{color:var(--ink-3);font-size:13px}
.cms{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}
.form.cms-main{max-width:none}
.cms-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.cms-row>div{display:grid;gap:8px;align-content:start}
.form .cms-body{min-height:420px;font-size:13px;line-height:1.6}
.cms-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px}
.cms-rail{display:grid;gap:14px}
.cms-rail dl{margin:0 0 10px;display:grid;gap:8px}.cms-rail dt{color:var(--ink-3);font-size:12px}.cms-rail dd{margin:0;overflow-wrap:anywhere}
.rail-title{margin:0 0 10px;font-size:13px;font-weight:600}
.counter{float:right;font:400 12px var(--mono);color:var(--ink-3)}.counter.off{color:var(--bad)}
.checks{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:8px}.checks li{display:flex;gap:8px;align-items:flex-start}
.checks .mark{font-weight:700;width:1em;flex:none}.checks li.ok .mark{color:var(--good)}.checks li.bad .mark{color:var(--bad)}
.serp{display:grid;gap:2px}.serp-url{font-size:12px;color:var(--ink-3)}.serp-title{font-size:17px;line-height:1.3;color:var(--accent-ink)}.serp-text{font-size:13px;color:var(--ink-2)}
.og{display:grid;align-content:space-between;gap:8px;aspect-ratio:1200/630;padding:16px;border-radius:10px;background:#0a0b0d;color:#f4f3ee}
.og-eyebrow{font:500 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:#d9ff43}.og-title{font-size:18px;font-weight:600;line-height:1.2}.og-site{font:400 11px var(--mono);color:#b9b8b2}
.images li{display:grid;gap:4px}.images code{font-size:11.5px;overflow-wrap:anywhere}
.publish{margin-top:10px}
.cms-preview{margin-top:32px;padding:24px;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius)}.cms-preview>h2{margin:0 0 14px}
.article{max-width:44em;font-size:16px;line-height:1.7;color:var(--ink-2)}
.article h2{margin:1.8em 0 .5em;font-size:22px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}.article h3{margin:1.4em 0 .4em;font-size:17px;color:var(--ink)}
.article p,.article ul,.article ol{margin:0 0 1em}.article a{color:var(--accent-ink)}.article strong{color:var(--ink)}
.article code{font-family:var(--mono);font-size:.86em;padding:1px 5px;border-radius:5px;background:var(--canvas-2);color:var(--ink)}
.article pre{margin:0 0 1.2em;padding:14px 16px;overflow-x:auto;border-radius:10px;background:var(--canvas-2);color:var(--ink);font-size:13px;line-height:1.6}.article pre code{padding:0;background:none}
.article table{margin:0 0 1.2em;font-size:14px}.article th,.article td{padding:8px 10px;border-top:1px solid var(--line)}
.article blockquote{margin:0 0 1em;padding-left:14px;border-left:3px solid var(--line)}
.article figure{margin:0 0 1.2em}.article img{max-width:100%;height:auto;border-radius:10px}.article .post-meta{margin:0 0 6px;font:12px var(--mono);color:var(--ink-3)}
@media (max-width:860px){.cms,.cms-row{grid-template-columns:1fr}.app{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center}.nav{display:flex;flex-wrap:wrap}.side-foot{margin:0;border:0;padding:0}.grid-2{grid-template-columns:1fr}.content{padding:18px 16px}.top{padding:10px 16px}
thead{display:none}tr{display:block;border-top:1px solid var(--line-2)}td{display:flex;justify-content:space-between;gap:12px;border:0;padding:6px 14px}td::before{content:attr(data-label);color:var(--ink-3);font-size:12px}}
`;

/**
 * Progressive enhancement only: ⌘K or Ctrl+K (and /) focus the search; "g" then h, a, c, s or l
 * goes to Home, Accounts, Cases, Staff or the staff log; a button with data-copy copies its value.
 */
export const SLOTLOCK_ADMIN_JS = `(() => {
  const search = document.getElementById('q');
  let pending = false;
  const go = { h: '/', a: '/accounts', c: '/cases', s: '/staff', l: '/staff/log' };
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
