// The admin console's pages as server-rendered HTML (RFC 0006, 4.1 and 4.7): the escaping `html`
// template the customer dashboard uses, the shell, the components every page is built from, the
// stylesheet and the console's small scripts. Everything is a file under a strict CSP: no inline
// script, style block or style attribute, so a value that slips past escaping still cannot run.
// Widths, heights and positions that vary come from SVG attributes, never from style.
//
// The look follows goshenemail.com's app and the patterns in RFC 0006, 4.7 (research of 2026-11-14):
// a sidebar on the page background beside one raised card that scrolls on its own, a 52px top bar
// with the breadcrumb title, the account search and the page's actions, fluid data pages on a
// 12-column grid, an inspector rail beside a record, and drawers and popovers for quick edits. The
// colours are the customer dashboard's family (src/design-tokens.ts); the type is Inter and Geist
// Mono, served by the console itself (src/admin/fonts.ts).
import { SLOTLOCK_CONSOLE_TOKENS, SLOTLOCK_DASHBOARD_TOKENS, SLOTLOCK_ANNOUNCEMENT_BANNER_CSS, SLOTLOCK_BANNER_CSS, slotlockCssVars } from '../design-tokens.js';
import { SLOTLOCK_ADMIN_FONTS } from './fonts.js';

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

// ---------- Icons: 16px strokes, drawn for the console ----------
const ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  home: 'M2.5 7.2 8 2.6l5.5 4.6v6.1a.7.7 0 0 1-.7.7H10V10H6v4H3.2a.7.7 0 0 1-.7-.7z',
  accounts: 'M6 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM1.8 13.6c.4-2.4 2.1-3.9 4.2-3.9s3.8 1.5 4.2 3.9M10.6 2.9a2.3 2.3 0 0 1 0 4.5M11.6 9.8c1.4.4 2.4 1.7 2.6 3.8',
  billing: 'M2.6 3.6h10.8a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1zM1.6 6.6h12.8M4.4 9.8h2.8',
  usage: 'M3 13.4V8.6M6.4 13.4V3.6M9.8 13.4V9.8M13.2 13.4V6',
  cases: 'M3.4 14.2V2.4M3.4 2.8h8.8l-1.8 3 1.8 3H3.4',
  privacy: 'M8 1.9 13.2 4v3.7c0 3-2.2 5.4-5.2 6.4-3-1-5.2-3.4-5.2-6.4V4z',
  content: 'M4 1.9h5.6l3 3v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.5a.6.6 0 0 1 .6-.6zM9.2 2v3.3h3.3M5.8 8.6h4.4M5.8 11h4.4',
  site: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM2 8h12M8 2c1.6 1.6 2.4 3.6 2.4 6S9.6 12.4 8 14C6.4 12.4 5.6 10.4 5.6 8S6.4 3.6 8 2z',
  communications: 'M2.4 6.4v3.2h2.2l5.2 3.2V3.2L4.6 6.4zM12 5.8a2.6 2.6 0 0 1 0 4.4M4.6 9.6l.9 3.8',
  system: 'M3.2 2.4h9.6a.8.8 0 0 1 .8.8v3a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8v-3a.8.8 0 0 1 .8-.8zM3.2 9h9.6a.8.8 0 0 1 .8.8v3a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8v-3a.8.8 0 0 1 .8-.8zM5 4.7h.6M5 11.3h.6',
  staff: 'M8 7.8a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4zM2.8 13.8c.6-2.5 2.6-4 5.2-4s4.6 1.5 5.2 4',
  log: 'M6 4h7.6M6 8h7.6M6 12h7.6M2.6 4h.8M2.6 8h.8M2.6 12h.8',
  search: 'M7 11.6a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2zM10.4 10.4 14 14',
  more: 'M3.4 8h.2M8 8h.2M12.6 8h.2',
  close: 'M4 4l8 8M12 4 4 12',
  info: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 7.4V11M8 5h.01',
  plus: 'M8 3.4v9.2M3.4 8h9.2',
  filter: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 5.6v4.8M5.6 8h4.8',
  download: 'M8 2.4v8.2M4.8 7.6 8 10.8l3.2-3.2M2.8 13.6h10.4',
  copy: 'M5.6 5.6h7.2a.8.8 0 0 1 .8.8v7.2a.8.8 0 0 1-.8.8H5.6a.8.8 0 0 1-.8-.8V6.4a.8.8 0 0 1 .8-.8zM2.4 10.4V3.2a.8.8 0 0 1 .8-.8h7.2',
  external: 'M9.6 2.4h4v4M13.6 2.4 7.6 8.4M11.6 9.6v3.2a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8h3.2',
  chevron: 'M6 3.6 10.4 8 6 12.4',
  signout: 'M6 13.6H3.2a.8.8 0 0 1-.8-.8V3.2a.8.8 0 0 1 .8-.8H6M10.4 11.2 13.6 8l-3.2-3.2M13.6 8H6',
  check: 'M3.2 8.4 6.4 11.6 12.8 4.8',
});

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: string, label?: string): Html {
  const path = ICON_PATHS[name] ?? ICON_PATHS.more ?? '';
  return label
    ? html`<svg class="ico" viewBox="0 0 16 16" role="img" aria-label="${label}"><path d="${path}"/></svg>`
    : html`<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

// ---------- The shell ----------
export interface NavItem {
  href: string;
  label: string;
  icon?: string;
  count?: number | null;
  /** Starts a group: a little space above it. */
  group?: boolean;
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface MenuItem {
  label: string;
  href?: string;
  /** A destructive item: red, in the menu's last group. */
  danger?: boolean;
  /** An item that opens its own form in place (a confirm asking for a reason). */
  form?: Html;
  external?: boolean;
}

export interface Shell {
  title: string;
  /** The path the nav marks as current: itself, or the section it is in. */
  path: string;
  nav: NavItem[];
  staff: { login: string; role: string };
  csrf: string;
  query?: string;
  notice?: { kind: 'done' | 'warn'; text: string; undo?: { href: string; label: string } } | null;
  /** A page's own script, beside admin.js (the CMS editor's). */
  script?: string;
  /** The breadcrumb before the title; the title itself is last. */
  crumbs?: Crumb[];
  /** Status pills beside the title. */
  pills?: Html;
  /** The page's own buttons, in the top bar: at most one primary. */
  actions?: Html;
  /** The ⋯ menu beside them. */
  menu?: MenuItem[];
  /** A drawer over the page (a quick edit, from ?panel=…). */
  drawer?: Html;
  /** The page fills the card edge to edge (split views). */
  flush?: boolean;
}

const isCurrent = (path: string, href: string) =>
  href === '/' ? path === '/' : path === href || (path.startsWith(`${href}/`) && !(href === '/staff' && path.startsWith('/staff/log')));

const FONT_PRELOAD = SLOTLOCK_ADMIN_FONTS[0]?.path ?? '';

/** A page inside the console: sidebar, then one card with the top bar and the page. */
export function layout(shell: Shell, body: Html): Html {
  const crumbs = shell.crumbs ?? [];
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${shell.title} · Slotlock admin</title>
<link rel="preload" href="${FONT_PRELOAD}" as="font" type="font/woff2" crossorigin>
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
        (item) => html`<a href="${item.href}"${item.group ? new Html(' class="gap"') : ''} ${isCurrent(shell.path, item.href) ? new Html('aria-current="page"') : ''}>${icon(item.icon ?? 'more')}<span>${item.label}</span>${item.count ? html`<span class="count">${item.count.toLocaleString('en-GB')}</span>` : ''}</a>`,
      )}
    </nav>
    <div class="side-foot">
      ${avatar(shell.staff.login)}
      <p class="who"><strong>${shell.staff.login}</strong><span>${shell.staff.role}</span></p>
      <form method="post" action="/sign-out">
        <input type="hidden" name="csrf" value="${shell.csrf}">
        <button class="icon-btn ghost" type="submit" title="Sign out">${icon('signout', 'Sign out')}</button>
      </form>
    </div>
  </aside>
  <div class="work">
    <header class="top">
      <div class="title">
        <h1>${crumbs.map((crumb) => html`${crumb.href ? html`<a href="${crumb.href}">${crumb.label}</a>` : html`<span class="crumb">${crumb.label}</span>`}<span class="sep" aria-hidden="true">/</span>`)}<span class="here">${shell.title}</span></h1>
        ${shell.pills ? html`<span class="title-pills">${shell.pills}</span>` : ''}
      </div>
      <form class="search" method="get" action="/search" role="search">
        ${icon('search')}
        <label class="sr-only" for="q">Find an account</label>
        <input id="q" name="q" type="search" value="${shell.query ?? ''}" placeholder="Find an account" autocomplete="off" spellcheck="false">
        <kbd>⌘K</kbd>
      </form>
      ${shell.actions || shell.menu?.length ? html`<div class="actions">${shell.actions ?? ''}${shell.menu?.length ? menu(shell.menu, 'More actions') : ''}</div>` : ''}
    </header>
    <div class="scroll">
      <main id="main" class="content${shell.flush ? ' flush' : ''}">
        ${body}
      </main>
    </div>
  </div>
</div>
${shell.drawer ?? ''}
${shell.notice ? toast(shell.notice) : ''}
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
<link rel="preload" href="${FONT_PRELOAD}" as="font" type="font/woff2" crossorigin>
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

/** What an action did: bottom right, gone after five seconds unless it is a warning. */
function toast(notice: NonNullable<Shell['notice']>): Html {
  return html`<div class="notice toast ${notice.kind}" role="${notice.kind === 'warn' ? 'alert' : 'status'}">
    <span>${notice.text}</span>${notice.undo ? html`<a class="toast-undo" href="${notice.undo.href}">${notice.undo.label}</a>` : ''}
    <button class="icon-btn ghost sm toast-x" type="button" data-dismiss hidden>${icon('close', 'Dismiss')}</button>
  </div>`;
}

// ---------- Small parts ----------
export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info';

/** A status: a dot and a word on its tint. */
export function pill(text: string, tone: Tone = 'muted'): Html {
  return html`<span class="pill ${tone}">${text}</span>`;
}

/** A label that is not a status (a plan, a kind, "Public"). */
export function chip(text: string, tone: 'plain' | 'info' | 'warn' = 'plain'): Html {
  return html`<span class="chip ${tone}">${text}</span>`;
}

/** Two letters for a name or a reference. */
export function initials(text: string): string {
  const words = text
    .replace(/^[a-z-]+:/i, '')
    .split(/[\s._~:@/-]+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? text).slice(0, 2);
  return letters.toUpperCase() || '·';
}

export function avatar(text: string, size: 'sm' | 'md' = 'md'): Html {
  // A bare reference has no name to take letters from: a team, or a person.
  if (/^[a-z][a-z-]*:/.test(text)) {
    return html`<span class="avatar ${size} glyph" aria-hidden="true">${icon(text.startsWith('team:') || text.startsWith('github-org:') || text.startsWith('partner:') ? 'accounts' : 'staff')}</span>`;
  }
  return html`<span class="avatar ${size}" aria-hidden="true">${initials(text)}</span>`;
}

export interface AccountLike {
  ref: string;
  /** The account's own name (a team's, an organization's, a partner account's). */
  name?: string | null;
  /** What else names it: a person's GitHub login. */
  display?: string | null;
  /** Where it links; none for a reference with no page (an erased account). */
  href?: string | null;
  /** A second line instead of the reference. */
  sub?: Html | string | null;
}

/**
 * An account in a table or a list: initials, its name (or, without one, its reference) and a muted
 * second line. name ?? display ?? reference, as everywhere in the console.
 */
export function accountCell(account: AccountLike): Html {
  const label = account.name ?? account.display ?? null;
  const shown = label ?? account.ref;
  const link = account.href
    ? label
      ? html`<a href="${account.href}">${label}</a>`
      : html`<a href="${account.href}" class="mono">${account.ref}</a>`
    : html`<span class="${label ? '' : 'mono'}">${shown}</span>`;
  const second = account.sub ?? (label ? html`<span class="mono">${account.ref}</span>` : null);
  return html`<span class="ac">${avatar(shown)}<span class="ac-text">${link}${second ? html`<span class="sub">${second}</span>` : ''}</span></span>`;
}

/** A copy button for a value: shown once the script runs. */
export function copyButton(value: string, label = 'Copy'): Html {
  return html`<button class="icon-btn ghost sm" type="button" data-copy="${value}" title="${label}" hidden>${icon('copy', label)}</button>`;
}

/** An ⓘ that opens a definition in place. */
export function info(label: string, body: Html | string): Html {
  return html`<details class="info"><summary title="${label}">${icon('info', label)}</summary><div class="pop">${body}</div></details>`;
}

/** The ⋯ menu: links, forms that open in place, and destructive items last, in red. */
export function menu(items: MenuItem[], label = 'More'): Html {
  const plain = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);
  const render = (item: MenuItem) =>
    item.form
      ? html`<details class="confirm"><summary class="menu-item${item.danger ? ' danger' : ''}">${item.label}</summary><div class="confirm-body">${item.form}</div></details>`
      : html`<a class="menu-item${item.danger ? ' danger' : ''}" href="${item.href ?? '#'}"${item.external ? new Html(' rel="noreferrer"') : ''}>${item.label}${item.external ? icon('external') : ''}</a>`;
  return html`<details class="menu"><summary class="icon-btn" title="${label}">${icon('more', label)}</summary><div class="menu-pop">
    ${plain.map(render)}
    ${danger.length ? html`${plain.length ? html`<div class="menu-sep" role="separator"></div>` : ''}<p class="menu-label">Danger zone</p>${danger.map(render)}` : ''}
  </div></details>`;
}

/** A button that opens a small form in place: a confirmation asking for a reason, or a quick edit. */
export function popover(summary: Html | string, body: Html, options: { tone?: 'danger' | 'primary' | 'plain'; align?: 'left' | 'right'; size?: 'sm' } = {}): Html {
  const tone = options.tone === 'danger' ? ' danger-ghost' : options.tone === 'primary' ? ' primary' : '';
  return html`<details class="popover${options.align === 'left' ? ' left' : ''}"><summary class="btn${tone}${options.size === 'sm' ? ' sm' : ''}">${summary}</summary><div class="pop">${body}</div></details>`;
}

/** A drawer over the page, from ?panel=…: closing it is a link back. */
export function drawer(title: string, body: Html, closeHref: string): Html {
  return html`<a class="scrim" href="${closeHref}" tabindex="-1" aria-hidden="true"></a>
<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-close="${closeHref}">
  <header class="drawer-head"><h2 id="drawer-title">${title}</h2><a class="icon-btn ghost" href="${closeHref}">${icon('close', 'Close')}</a></header>
  <div class="drawer-body">${body}</div>
</aside>`;
}

/** One line, and the next thing to do. */
export function emptyState(text: string | Html, action?: Html | null): Html {
  return html`<div class="empty"><p>${text}</p>${action ?? ''}</div>`;
}

/** A section of a page: its title, an optional link or control on the right, then its content. */
export function section(title: string, body: Html, options: { id?: string; aside?: Html | null; level?: 2 | 3; info?: Html | null } = {}): Html {
  const heading = options.level === 3 ? html`<h3>${title}</h3>` : html`<h2>${title}</h2>`;
  return html`<section class="section"${options.id ? html` id="${options.id}"` : ''}><header class="section-head">${heading}${options.info ?? ''}${options.aside ? html`<div class="section-aside">${options.aside}</div>` : ''}</header>${body}</section>`;
}

/** Facts as a definition list: term, then what it is. */
export function facts(rows: ([string, Html | string] | null | false)[]): Html {
  return html`<dl class="kv">${rows.filter((row): row is [string, Html | string] => Boolean(row)).map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>`;
}

export interface Tab {
  label: string;
  href: string;
  current?: boolean;
  count?: number | null;
}

/** Views of one page (Open, Closed, All), each a URL; counts where the console knows them. */
export function tabs(label: string, items: Tab[], kind: 'tabs' | 'views' = 'tabs'): Html {
  return html`<nav class="${kind}" aria-label="${label}">${items.map(
    (item) => html`<a href="${item.href}"${item.current ? new Html(' aria-current="page"') : ''}>${item.label}${item.count !== undefined && item.count !== null ? html`<span class="count">${count(item.count)}</span>` : ''}</a>`,
  )}</nav>`;
}

/**
 * Tabs within one page, each a section the page already holds: the first shows until a link names
 * another (#keys), so every form stays on the page and a reload keeps the tab.
 */
export function hashTabs(label: string, panels: { id: string; label: string; body: Html; count?: number | null }[], style: 'tabs' | 'seg' = 'tabs'): Html {
  return html`<div class="tabbed">
    <nav class="${style}" aria-label="${label}" data-hash-tabs>${panels.map(
      (panel, index) => html`<a href="#${panel.id}"${index === 0 ? new Html(' aria-current="page"') : ''}>${panel.label}${panel.count ? html`<span class="count">${count(panel.count)}</span>` : ''}</a>`,
    )}</nav>
    ${panels.map((panel) => html`<section class="tab-panel" id="${panel.id}" aria-label="${panel.label}">${panel.body}</section>`)}
  </div>`;
}

/** A filter as a chip: ⊕ and its name, then the value it is set to; a menu of values, each a URL. */
export function filterChip(label: string, options: { label: string; href: string; current: boolean }[], clearHref: string): Html {
  const chosen = options.find((option) => option.current);
  return html`<details class="chip-filter${chosen ? ' on' : ''}"><summary>${icon(chosen ? 'check' : 'filter')}${label}${chosen ? html`<span class="chip-value">${chosen.label}</span>` : ''}</summary><div class="pop left menu-pop">
    ${options.map((option) => html`<a class="menu-item" href="${option.href}"${option.current ? new Html(' aria-current="true"') : ''}>${option.label}</a>`)}
    ${chosen ? html`<div class="menu-sep" role="separator"></div><a class="menu-item" href="${clearHref}">Clear</a>` : ''}
  </div></details>`;
}

/** The URL of this page with some parameters changed (null removes one); `after` always goes. */
export function withParams(url: URL, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(url.searchParams);
  // A notice, a page cursor, a drawer and a search's GitHub label hold for one view only.
  for (const name of ['done', 'error', 'after', 'before', 'panel', 'for']) next.delete(name);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

// ---------- Numbers ----------
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

/** A count for an axis or a tile: 1.2k, 3.4M. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return value.toLocaleString('en-GB');
}

/** How long ago, in words, with the exact time as its title. */
export function ago(value: string | Date | null | undefined, now: number): Html {
  if (!value) return html`–`;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return html`–`;
  const minutes = Math.round((now - date.getTime()) / 60_000);
  const text =
    minutes < 1 ? 'Just now'
      : minutes < 60 ? `${minutes} min ago`
        : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago`
          : minutes < 60 * 24 * 60 ? `${Math.round(minutes / (60 * 24))} days ago`
            : day(date);
  return html`<time datetime="${date.toISOString()}" title="${when(date)} UTC">${minutes < 0 ? day(date) : text}</time>`;
}

/** How many days ago a day was (a date with no time): Today, Yesterday, 3 days ago. */
export function daysAgo(value: string | Date | null | undefined, now: number): Html {
  if (!value) return html`–`;
  const key = day(value);
  if (key === '–') return html`–`;
  const days = Math.round((Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${key}T00:00:00Z`)) / 86_400_000);
  const text = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 60 ? `${days} days ago` : key;
  return html`<time datetime="${key}" title="${key}">${text}</time>`;
}

/** A change between two periods, as a badge: +12%, −4%. */
export function delta(current: number, previous: number): { text: string; tone: 'up' | 'down' | 'flat' } | null {
  if (!previous) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  return { text: `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)}%`, tone: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

// ---------- Stats ----------
export interface Stat {
  label: string;
  value: string;
  /** A short line under the value. */
  note?: string | Html | null;
  href?: string;
  delta?: { text: string; tone: 'up' | 'down' | 'flat' } | null;
  /** A small trend under the value. */
  spark?: number[] | null;
  /** A share of a limit, drawn as a bar. */
  meter?: { value: number; max: number } | null;
  /** This tile is the chart's metric (a tab). */
  current?: boolean;
}

/** Joined tiles: a label, the value, a change and a trend; each a link to its list. */
export function stats(items: Stat[], options: { vertical?: boolean } = {}): Html {
  return html`<ul class="stats n${String(items.length)}${options.vertical ? ' vertical' : ''}">${items.map((item) => {
    const inner = html`<span class="stat-label">${item.label}</span><strong class="stat-value">${item.value}</strong>
      ${item.delta || item.note ? html`<span class="stat-foot">${item.delta ? html`<span class="delta ${item.delta.tone}">${item.delta.text}</span>` : ''}${item.note ? html`<span class="stat-note">${item.note}</span>` : ''}</span>` : ''}
      ${item.meter ? meter(item.meter.value, item.meter.max) : ''}
      ${item.spark && item.spark.length > 1 ? sparkline(item.spark) : ''}`;
    return html`<li>${item.href ? html`<a href="${item.href}"${item.current ? new Html(' aria-current="true"') : ''}>${inner}</a>` : html`<div>${inner}</div>`}</li>`;
  })}</ul>`;
}

/** A trend in 28px: an area and its line, no axes. */
export function sparkline(values: number[]): Html {
  const max = Math.max(1, ...values);
  const step = 100 / Math.max(1, values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(24 - (value / max) * 22).toFixed(2)}`);
  return html`<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="spark-area" d="M0,24L${points.join('L')}L100,24Z"/><path class="spark-line" vector-effect="non-scaling-stroke" d="M${points.join('L')}"/></svg>`;
}

/** A share of a limit as a bar: amber from 80%, red from 100%. */
export function meter(value: number, max: number): Html {
  const share = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = max > 0 && value >= max ? 'bad' : share >= 80 ? 'warn' : 'ok';
  return html`<svg class="meter ${tone}" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${count(value)} of ${count(max)}"><rect class="meter-track" width="100" height="4"/><rect class="meter-fill" width="${share.toFixed(1)}" height="4"/></svg>`;
}

/** A labelled meter row: what, how many of how many, and the bar. */
export function meterRow(label: string, value: number, max: number | null | undefined): Html {
  return html`<div class="meter-row"><span class="meter-label">${label}</span><span class="meter-value">${count(value)}${max ? html`<span class="of"> / ${count(max)}</span>` : ''}</span>${max ? meter(value, max) : ''}</div>`;
}

// ---------- Tables ----------
export interface Column {
  label: string;
  /** Right-aligned, for numbers. */
  num?: boolean;
  /** Hidden from sight but read out (the ⋯ column). */
  quiet?: boolean;
  /** Left out on a phone, where each row stacks: a column the row's own page shows anyway. */
  phone?: false;
}

export interface TableOptions {
  /** Where each row goes when clicked (its first link is the same place, for the keyboard). */
  hrefs?: (string | null)[];
  /** "1–50 of N" and the pages. */
  footer?: Html | null;
  id?: string;
}

/** A table whose cells are already HTML: sticky header, rows that open, numbers on the right; on a phone each row stacks with its labels. */
export function table(caption: string, columns: (string | Column)[], rows: Html[][], empty: string | Html, options: TableOptions = {}): Html {
  if (rows.length === 0) return typeof empty === 'string' && empty === '' ? html`` : emptyState(empty);
  const cols: Column[] = columns.map((column) => (typeof column === 'string' ? { label: column } : column));
  const cls = (column: Column | undefined) => [column?.num ? 'num' : '', column?.quiet ? 'quiet' : '', column?.phone === false ? 'nophone' : ''].filter(Boolean).join(' ');
  return html`<div class="table-wrap"${options.id ? html` id="${options.id}"` : ''}><table>
    <caption class="sr-only">${caption}</caption>
    <thead><tr>${cols.map((column) => html`<th scope="col"${cls(column) ? html` class="${cls(column)}"` : ''}>${column.quiet ? html`<span class="sr-only">${column.label}</span>` : column.label}</th>`)}</tr></thead>
    <tbody>${rows.map(
      // Each cell's content in one box, so a stacked row on a phone keeps it together beside its label.
      (row, rowIndex) => html`<tr${options.hrefs?.[rowIndex] ? html` data-href="${options.hrefs[rowIndex] ?? ''}"` : ''}>${row.map((cell, index) => html`<td data-label="${cols[index]?.quiet ? '' : (cols[index]?.label ?? '')}"${cls(cols[index]) ? html` class="${cls(cols[index])}"` : ''}><div class="cell">${cell}</div></td>`)}</tr>`,
    )}</tbody>
  </table></div>${options.footer ?? ''}`;
}

/** Under a table: which rows these are, and the way to the next page. */
export function tableFooter(first: number, shown: number, total: number | null, links: { first?: string | null; next?: string | null }): Html {
  if (shown === 0) return html``;
  const range = `${count(first)}–${count(first + shown - 1)}${total !== null ? ` of ${count(total)}` : ''}`;
  return html`<div class="table-foot"><span>${range}</span><span class="pager">${links.first ? html`<a class="btn sm" href="${links.first}">First page</a>` : ''}${links.next ? html`<a class="btn sm" href="${links.next}">Next</a>` : ''}</span></div>`;
}

// ---------- Charts ----------
/** Days, oldest first, ending today (UTC). */
export function lastDays(days: number, now: number): string[] {
  const today = new Date(now);
  const out: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    out.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back)).toISOString().slice(0, 10));
  }
  return out;
}

export type Range = '7d' | '30d' | '90d' | '12m';
export const RANGE_DAYS: Readonly<Record<Range, number>> = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, '12m': 365 });
export const rangeOf = (value: string | null, fallback: Range = '30d'): Range =>
  value && Object.hasOwn(RANGE_DAYS, value) ? (value as Range) : fallback;

/**
 * Daily values summed into the points a range draws: days up to a month, weeks for 90 days, months
 * for a year. Labels are each point's first day.
 */
export function rollup(days: string[], values: number[], range: Range): { labels: string[]; values: number[] } {
  if (range === '7d' || range === '30d') return { labels: days, values };
  const labels: string[] = [];
  const sums: number[] = [];
  days.forEach((dayKey, index) => {
    const key = range === '12m' ? dayKey.slice(0, 7) : null;
    const last = labels.length - 1;
    const same = range === '12m' ? labels[last]?.slice(0, 7) === key : index % 7 !== 0;
    if (last >= 0 && same) sums[last] = (sums[last] ?? 0) + (values[index] ?? 0);
    else {
      labels.push(range === '12m' ? (key ?? dayKey.slice(0, 7)) : dayKey);
      sums.push(values[index] ?? 0);
    }
  });
  return { labels, values: sums };
}

/** The range control: 7d, 30d, 90d, 12m, each a URL. */
export function rangeControl(url: URL, current: Range, offered: Range[] = ['7d', '30d', '90d', '12m'], param = 'range'): Html {
  return html`<nav class="seg" aria-label="Range">${offered.map((range) => html`<a href="${withParams(url, { [param]: range })}"${range === current ? new Html(' aria-current="true"') : ''}>${range}</a>`)}</nav>`;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartInput {
  title: string;
  /** Point labels: days (YYYY-MM-DD) or months. */
  labels: string[];
  series: ChartSeries[];
  /** One series as an area (a trend), or several stacked (parts). */
  kind: 'area' | 'bars';
  total?: string | null;
  control?: Html | null;
  /** Shown under the title instead of the total. */
  note?: string | null;
  format?: (value: number) => string;
}

const niceMax = (value: number) => {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
};
/** A point's label: 14 Nov for a day, Nov 2026 for a month (a label of YYYY-MM). */
const labelOf = (value: string) => {
  const date = new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return value.length === 7
    ? date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

/**
 * A chart 240px tall: the title and total, the range control, then an area (one series) or stacked
 * bars (several) with a y axis, dates under it, and a tooltip (<title>) on every point.
 */
export function chart(input: ChartInput): Html {
  const n = input.labels.length;
  const format = input.format ?? ((value: number) => count(value));
  const totals = input.labels.map((_, index) => input.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const W = Math.max(1, n) * 10;
  const H = 100;
  const y = (value: number) => H - (value / top) * H;
  const ticks = [top, top / 2, 0];
  const xIndexes = n <= 1 ? [0] : [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])];
  const pointTitle = (index: number) =>
    `${labelOf(input.labels[index] ?? '')}: ${input.series.map((series) => `${input.series.length > 1 ? `${series.name} ` : ''}${format(series.values[index] ?? 0)}`).join(', ')}`;
  let marks: Html;
  if (input.kind === 'area') {
    const values = input.series[0]?.values ?? [];
    const step = n > 1 ? W / (n - 1) : W;
    const points = values.map((value, index) => `${(index * step).toFixed(1)},${y(value).toFixed(2)}`);
    marks = html`<path class="area" d="M0,${H}L${points.join('L')}L${W},${H}Z"/><path class="line" vector-effect="non-scaling-stroke" d="M${points.join('L')}"/>`;
  } else {
    const step = W / Math.max(1, n);
    const gap = Math.min(step * 0.3, 4);
    marks = html`${input.labels.flatMap((_, index) => {
      let base = 0;
      return input.series.map((series, s) => {
        const value = series.values[index] ?? 0;
        if (value <= 0) return html``;
        const rect = html`<rect class="s${String((s % 5) + 1)}" x="${(index * step + gap / 2).toFixed(2)}" y="${y(base + value).toFixed(2)}" width="${(step - gap).toFixed(2)}" height="${((value / top) * H).toFixed(2)}"/>`;
        base += value;
        return rect;
      });
    })}`;
  }
  const hitStep = W / Math.max(1, n);
  const hits = input.labels.map((_, index) => {
    const x = input.kind === 'area' ? (n > 1 ? (index * W) / (n - 1) - hitStep / 2 : 0) : index * hitStep;
    return html`<rect class="hit" x="${Math.max(0, x).toFixed(2)}" y="0" width="${hitStep.toFixed(2)}" height="${H}"><title>${pointTitle(index)}</title></rect>`;
  });
  const sum = totals.reduce((a, b) => a + b, 0);
  return html`<figure class="chart">
    <figcaption class="chart-head"><span class="chart-title">${input.title}</span>${input.total !== null ? html`<span class="chart-total">${input.total ?? format(sum)}</span>` : ''}${input.note ? html`<span class="chart-note">${input.note}</span>` : ''}${input.control ?? ''}</figcaption>
    <div class="plot">
      <div class="y-axis" aria-hidden="true">${ticks.map((tick) => html`<span>${compact(tick)}</span>`)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${input.title}: ${format(sum)} from ${labelOf(input.labels[0] ?? '')} to ${labelOf(input.labels.at(-1) ?? '')}">
        <line class="grid-line" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="0.5" y2="0.5"/><line class="grid-line" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/><line class="base-line" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>
        ${marks}${hits}
      </svg>
      <div class="x-axis" aria-hidden="true">${xIndexes.map((index) => html`<span>${labelOf(input.labels[index] ?? '')}</span>`)}</div>
    </div>
    ${input.series.length > 1 ? html`<ul class="legend">${input.series.map((series, s) => html`<li><i class="sw s${String((s % 5) + 1)}"></i>${series.name}<span>${format(series.values.reduce((a, b) => a + b, 0))}</span></li>`)}</ul>` : ''}
  </figure>`;
}

/** Parts of a whole as one bar, with a legend: paying accounts by plan. */
export function partsBar(label: string, parts: { name: string; value: number }[]): Html {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  let x = 0;
  return html`<div class="parts">
    <svg class="parts-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}: ${parts.map((part) => `${part.name} ${count(part.value)}`).join(', ')}">
      <rect class="meter-track" width="100" height="8"/>${parts.map((part, index) => {
        const width = total > 0 ? (part.value / total) * 100 : 0;
        const rect = html`<rect class="s${String((index % 5) + 1)}" x="${x.toFixed(2)}" width="${width.toFixed(2)}" height="8"><title>${part.name}: ${count(part.value)}</title></rect>`;
        x += width;
        return rect;
      })}
    </svg>
    <ul class="legend">${parts.map((part, index) => html`<li><i class="sw s${String((index % 5) + 1)}"></i>${part.name}<span>${count(part.value)}</span></li>`)}</ul>
  </div>`;
}

// ---------- For the pages still on the old head (Site, Communications, System, Content) ----------
/** The page title, with an eyebrow and an optional lede and actions: the pages not moved to the top bar yet. */
export function pageHead(_eyebrow: string, title: string, lede?: string | Html | null, actions?: Html): Html {
  return html`<div class="section-head"><h2>${title}</h2>${actions ? html`<div class="section-aside">${actions}</div>` : ''}</div>${lede ? html`<p class="muted section-lead">${lede}</p>` : ''}`;
}

/** Daily counts as a bar chart: the pages not moved to chart() yet. */
export function bars(label: string, points: { day: string; count: number }[], days = 30): Html {
  const keys = lastDays(days, Date.now());
  return chart({ title: label, labels: keys, series: [{ name: label, values: keys.map((key) => points.find((point) => point.day === key)?.count ?? 0) }], kind: 'bars' });
}

// ---------- Forms ----------
export interface FieldInput {
  id: string;
  label: string;
  control: Html;
  optional?: boolean;
  /** Customers see what is typed here. */
  public?: boolean;
  wide?: boolean;
  /** Beside the label: a counter, an ⓘ. */
  extra?: Html | null;
  /** Under the control, for a value read back (a time in the viewer's zone). */
  after?: Html | null;
}

/** A field: its label above it, "Optional" and "Public" where they apply, and no hint. */
export function field(input: FieldInput): Html {
  return html`<div class="field${input.wide ? ' wide' : ''}"><label for="${input.id}">${input.label}${input.optional ? html`<span class="opt">Optional</span>` : ''}${input.public ? chip('Public', 'info') : ''}${input.extra ?? ''}</label>${input.control}${input.after ?? ''}</div>`;
}

/** The reason a change needs: one line, which the staff log (and, where it says so, the customer) reads. */
export function reasonField(id: string, options: { public?: boolean } = {}): Html {
  return field({ id, label: 'Reason', public: options.public ?? false, control: html`<input id="${id}" name="reason" required maxlength="200" autocomplete="off">` });
}

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

// ---------- The stylesheet ----------
const fontFaces = SLOTLOCK_ADMIN_FONTS.map(
  (font) => `@font-face{font-family:${JSON.stringify(font.family)};src:url(${font.path}) format('woff2');font-weight:100 900;font-style:normal;font-display:swap;unicode-range:${font.unicodeRange}}`,
).join('\n');

/** The dashboard's own tokens, for the banner preview: exactly what a customer's page declares. */
const bannerFrame = (theme: 'light' | 'dark') =>
  `.banner-frame.${theme}{${slotlockCssVars(SLOTLOCK_DASHBOARD_TOKENS[theme], '')}--space-2:8px;--space-3:12px;--space-4:16px;--radius:8px;--text-md:13.5px;--font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--canvas);color:var(--ink);color-scheme:${theme}}`;

export const SLOTLOCK_ADMIN_CSS = `${fontFaces}
:root{${slotlockCssVars(SLOTLOCK_CONSOLE_TOKENS.light, '')}--font:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace;--r-chip:6px;--r-ctl:8px;--r-card:12px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{${slotlockCssVars(SLOTLOCK_CONSOLE_TOKENS.dark, '')}color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font:400 13px/20px var(--font);letter-spacing:-.003em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-synthesis-weight:none;text-rendering:optimizeLegibility}
a{color:var(--accent-ink);text-decoration:none;text-underline-offset:2px}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
::selection{background:var(--accent-tint)}
h1,h2,h3,p{margin:0}
code,.mono,kbd,pre{font-family:var(--mono);font-size:12px;font-variant-ligatures:none}
code{padding:1px 5px;border-radius:5px;background:var(--fill-2);color:var(--ink)}
td code,.sub code{background:none;padding:0}
.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;z-index:60;padding:8px 12px;border-radius:8px;background:var(--primary);color:var(--on-primary)}
.skip:focus{top:12px}
.num,.tnum{font-variant-numeric:tabular-nums}

/* Shell: the sidebar on the page, one card beside it that scrolls on its own */
.app{display:grid;grid-template-columns:232px minmax(0,1fr);height:100vh;height:100dvh;overflow:hidden}
.side{display:flex;flex-direction:column;gap:14px;min-height:0;min-width:0;padding:12px 8px 12px 12px;overflow-y:auto}
.brand{display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;color:var(--ink)}
.brand:hover{text-decoration:none}
.logo{width:19px;height:22px}.lockup{display:block;height:17px;width:auto;aspect-ratio:280.14/55.5}
.logo-word{fill:var(--logo-ink)}.logo-shackle{fill:none;stroke:var(--logo-ink);stroke-width:7}.logo-body,.logo-cut{fill:var(--logo-ink)}.logo-slot{fill:var(--logo-slot)}.logo-cut{display:none}
@media (prefers-color-scheme:dark){.logo-shackle{stroke:var(--logo-slot)}.logo-cut{fill:var(--logo-slot);display:inline}.logo-body,.logo-slot{display:none}}
.badge{font:500 11px/1 var(--mono);color:var(--ink-2);padding:4px 6px;border-radius:var(--r-chip);background:var(--fill-2)}
.nav{display:flex;flex-direction:column;gap:1px}
.nav a{display:flex;align-items:center;gap:9px;height:30px;padding:0 8px;border-radius:var(--r-chip);color:var(--ink-2);font-size:13px;white-space:nowrap}
.nav a.gap{margin-top:12px}
.nav a .ico{color:var(--ink-3)}
.nav a:hover{background:var(--fill);color:var(--ink);text-decoration:none}
.nav a[aria-current]{background:var(--fill-2);color:var(--ink);font-weight:500}
.nav a[aria-current] .ico{color:var(--ink)}
.nav .count{margin-left:auto;font:500 11px/1 var(--mono);color:var(--ink-2)}
.side-foot{margin-top:auto;display:flex;align-items:center;gap:8px;padding:6px 4px 0 8px}
.who{display:flex;flex-direction:column;min-width:0;flex:1;line-height:16px}
.who strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who span{color:var(--ink-2);font-size:12px;text-transform:capitalize}
.side-foot form{margin:0}
.work{display:flex;flex-direction:column;min-width:0;min-height:0;margin:8px 8px 8px 0;background:var(--card);border-radius:var(--r-card);box-shadow:var(--card-shadow);overflow:hidden}
.top{display:flex;align-items:center;gap:12px;flex:none;height:52px;padding:0 12px 0 24px;border-bottom:1px solid var(--line-2)}
.title{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
.title h1{display:flex;align-items:baseline;min-width:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
.title h1 a,.title h1 .crumb{color:var(--ink-2);font-weight:500;flex:none}
.title h1 a:hover{color:var(--ink);text-decoration:none}
.title .sep{color:var(--ink-3);font-weight:400;margin:0 8px;flex:none}
.title .here{overflow:hidden;text-overflow:ellipsis;min-width:0}
.title-pills{display:flex;align-items:center;gap:6px;flex:none}
.search{position:relative;display:flex;align-items:center;flex:0 1 260px;min-width:160px}
.search .ico{position:absolute;left:10px;color:var(--ink-3);pointer-events:none}
.search input{width:100%;height:32px;padding:0 40px 0 32px;border-radius:var(--r-ctl);border:1px solid var(--line);background:var(--fill);color:var(--ink);font:inherit;outline:0}
.search input::placeholder{color:var(--ink-3)}
.search input:focus{border-color:var(--accent);background:var(--card);box-shadow:0 0 0 3px var(--accent-tint)}
.search kbd{position:absolute;right:8px;font:500 11px/1 var(--mono);color:var(--ink-2);border:1px solid var(--line);border-radius:5px;padding:3px 5px;background:var(--card)}
.actions{display:flex;align-items:center;gap:8px;flex:none}
.scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.content{padding:24px}
.content.flush{padding:0;height:100%}

/* Controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--r-ctl);border:1px solid var(--line);background:var(--card);color:var(--ink);font:500 13px/1 var(--font);letter-spacing:-.003em;text-decoration:none;cursor:pointer;white-space:nowrap;list-style:none}
.btn:hover{background:var(--fill);text-decoration:none}
.btn.sm{height:28px;padding:0 10px}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}
.btn.primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.btn.danger{background:var(--danger);border-color:var(--danger);color:var(--on-danger)}
.btn.danger:hover{filter:brightness(1.08)}
.btn.danger-ghost{color:var(--bad-ink)}
.btn.danger-ghost:hover{background:var(--bad-tint)}
.btn .ico{width:14px;height:14px}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border-radius:var(--r-ctl);border:1px solid var(--line);background:var(--card);color:var(--ink-2);cursor:pointer;list-style:none}
.icon-btn:hover{background:var(--fill-2);color:var(--ink);text-decoration:none}
.icon-btn.ghost{border-color:transparent;background:none}
.icon-btn.sm{width:28px;height:28px}
button.link{all:unset;cursor:pointer;color:var(--accent-ink);font-size:13px}
button.link:hover{text-decoration:underline}
button.link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
details>summary{list-style:none;cursor:pointer}
details>summary::-webkit-details-marker{display:none}
input,select,textarea,button{font:inherit;color:inherit}
.field input:not([type=checkbox]):not([type=radio]):not([type=file]),.field select,.field textarea,.input,.toolbar input,.form-inline input,.form-inline select{width:100%;height:32px;padding:0 10px;border-radius:var(--r-ctl);border:1px solid var(--line);background:var(--card);color:var(--ink);font:400 13px var(--font);outline:0}
.field textarea{height:auto;min-height:84px;padding:7px 10px;line-height:20px;resize:vertical}
.field select,.form-inline select{appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6.5 8 10l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;background-size:16px}
.field input:focus,.field select:focus,.field textarea:focus,.toolbar input:focus,.form-inline input:focus,.form-inline select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint)}
.field input::placeholder,.field textarea::placeholder,.toolbar input::placeholder{color:var(--ink-3)}
.field input[type=file]{font-size:12px;color:var(--ink-2)}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:16px;height:16px;margin:0}
.form{display:grid;gap:16px;align-content:start}
.form-grid{display:grid;gap:16px}
.field{display:grid;gap:6px;align-content:start;min-width:0}
.field>label,.label{display:flex;align-items:center;gap:6px;font:500 12px/16px var(--font);color:var(--ink-2)}
.opt{color:var(--ink-3);font-weight:400}
.field .counter{margin-left:auto;font:400 11px/1 var(--mono);color:var(--ink-3)}
.field .counter.off{color:var(--bad-ink)}
.readback{font-size:12px;color:var(--ink-2)}
.form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.check{display:flex;align-items:center;gap:8px;font-size:13px}
.form-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.form-inline input{width:auto;flex:1 1 220px}
form.inline{display:inline;margin:0}
.segmented{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:var(--r-ctl);background:var(--fill-2);border:0;margin:0}
.segmented legend{padding:0}
.segmented label{position:relative;display:inline-flex}
.segmented input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.segmented span{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:var(--r-chip);color:var(--ink-2);font-weight:500}
.segmented input:checked+span{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.08)}
.segmented input:focus-visible+span{outline:2px solid var(--accent);outline-offset:1px}

/* Status */
.pill{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;background:var(--fill-2);color:var(--ink-2);font:500 12px/1 var(--font);white-space:nowrap;vertical-align:middle;flex:none}
.pill::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ink-3);flex:none}
.pill.good{background:var(--good-tint);color:var(--good-ink)}.pill.good::before{background:var(--good)}
.pill.warn{background:var(--warn-tint);color:var(--warn-ink)}.pill.warn::before{background:var(--warn)}
.pill.bad{background:var(--bad-tint);color:var(--bad-ink)}.pill.bad::before{background:var(--bad)}
.pill.info{background:var(--accent-tint);color:var(--accent-ink)}.pill.info::before{background:var(--accent)}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--r-chip);background:var(--fill-2);color:var(--ink-2);font:500 11.5px/1 var(--font);white-space:nowrap;vertical-align:middle;text-transform:capitalize}
.chip.info{background:var(--accent-tint);color:var(--accent-ink);text-transform:none}
.chip.warn{background:var(--warn-tint);color:var(--warn-ink)}
.avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--fill-2);color:var(--ink);font:600 11px/1 var(--font);letter-spacing:0}
.avatar.sm{width:24px;height:24px;font-size:10px}
.avatar.glyph{color:var(--ink-2)}
.avatar.glyph .ico{width:14px;height:14px}
.ac{display:flex;align-items:center;gap:10px;min-width:0}
.ac-text{display:flex;flex-direction:column;min-width:0}
.ac-text>a,.ac-text>span:first-child{color:var(--ink);font-weight:500;overflow-wrap:anywhere}
.ac-text>a.mono,.ac-text>span.mono{font-weight:500}
.sub{display:block;color:var(--ink-2);font-size:12px;line-height:16px;font-weight:400}
.sub.mono,.sub .mono{font-size:11.5px}
.muted{color:var(--ink-2)}
.delta{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--r-chip);font:500 12px/1 var(--font);background:var(--fill-2);color:var(--ink-2)}
.delta.up{background:var(--good-tint);color:var(--good-ink)}
.delta.down{background:var(--bad-tint);color:var(--bad-ink)}

/* Popovers, menus, drawers, toasts */
details.menu,details.popover,details.info,details.chip-filter{position:relative;display:inline-block}
.menu-pop,.pop{position:absolute;z-index:30;top:calc(100% + 6px);right:0;border-radius:var(--r-card);background:var(--raised);box-shadow:var(--pop-shadow);text-align:left}
.menu-pop{min-width:232px;padding:4px}
.pop{width:min(360px,calc(100vw - 32px));padding:16px}
.pop.left,details.left>.pop{right:auto;left:0}
.menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:0 10px;border-radius:var(--r-chip);border:0;background:none;color:var(--ink);font:400 13px var(--font);text-align:left;text-decoration:none;cursor:pointer;white-space:nowrap}
.menu-item:hover,.menu-item[aria-current]{background:var(--fill-2);text-decoration:none}
.menu-item .ico{margin-left:auto;color:var(--ink-3);width:14px;height:14px}
.menu-item.danger{color:var(--bad-ink)}
.menu-item.danger:hover{background:var(--bad-tint)}
.menu-sep{height:1px;background:var(--line-2);margin:4px -4px}
.menu-label{padding:8px 10px 4px;font:500 11px/1 var(--mono);color:var(--ink-2)}
details.confirm[open]>summary{background:var(--fill-2)}
.confirm-body{padding:10px;display:grid;gap:12px;width:min(320px,calc(100vw - 48px))}
.confirm-body .form{gap:12px}
details.info>summary{display:inline-flex;color:var(--ink-3);vertical-align:middle;border-radius:50%}
details.info>summary:hover{color:var(--ink)}
details.info .ico{width:14px;height:14px}
details.info>.pop{left:-8px;right:auto;font-size:12.5px;line-height:19px;color:var(--ink-2);font-weight:400;white-space:normal;letter-spacing:0}
.pop p+p{margin-top:8px}
.scrim{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.42)}
.drawer{position:fixed;z-index:41;top:8px;right:8px;bottom:8px;width:min(480px,calc(100vw - 16px));display:flex;flex-direction:column;border-radius:var(--r-card);background:var(--raised);box-shadow:var(--pop-shadow)}
.drawer-head{display:flex;align-items:center;gap:8px;height:52px;flex:none;padding:0 12px 0 20px;border-bottom:1px solid var(--line-2)}
.drawer-head h2{flex:1;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer-body{flex:1;min-height:0;overflow:auto;padding:20px;display:grid;gap:20px;align-content:start}
.toast{position:fixed;z-index:50;right:16px;bottom:16px;display:flex;align-items:center;gap:12px;max-width:min(460px,calc(100vw - 32px));min-height:44px;padding:8px 8px 8px 14px;border-radius:var(--r-card);background:var(--raised);color:var(--ink);box-shadow:var(--pop-shadow);font-size:13px}
.toast::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--good);flex:none}
.toast.warn::before{background:var(--warn)}
.toast>span{flex:1}
.toast-undo{font-weight:600;color:var(--accent-ink)}
.toast.done{animation:toast-out .2s ease 5s forwards}
.toast.done:hover,.toast.done:focus-within{animation-play-state:paused}
@keyframes toast-out{to{opacity:0;visibility:hidden;transform:translateY(8px)}}

/* Page structure */
.section{margin-top:32px}
.section:first-child,.tab-panel>.section:first-child{margin-top:0}
.section-head{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:12px}
.section-head h2{font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.01em}
.section-head h3,h3{font-size:14px;line-height:20px;font-weight:600}
.section-aside{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px}
.box{border:1px solid var(--line);border-radius:var(--r-card);padding:16px;min-width:0}
.box>.section-head{margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;margin-top:16px}
.grid>*{grid-column:1/-1;min-width:0}
.prose{max-width:68ch;color:var(--ink-2)}
.prose p+p{margin-top:8px}
.pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:68ch;color:var(--ink)}
.callout{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r-card);background:var(--fill);color:var(--ink);margin-bottom:16px;max-width:100%}
.callout.warn{background:var(--warn-tint)}
.callout.bad{background:var(--bad-tint)}
.callout.good{background:var(--good-tint)}
.callout p+p{margin-top:4px}
.headline{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.headline-figure{font-size:40px;line-height:48px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.headline-text{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.02em}
.anchors{position:sticky;top:0;z-index:2;display:flex;gap:4px;margin:-24px -24px 24px;padding:8px 24px;background:var(--card);border-bottom:1px solid var(--line-2);overflow-x:auto;scrollbar-width:none}
.anchors a{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:999px;color:var(--ink-2);font-weight:500;white-space:nowrap}
.anchors a:hover{background:var(--fill);color:var(--ink);text-decoration:none}
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 0;border-bottom:1px solid var(--line-2)}
.list>li:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0}
.list a{color:var(--ink);font-weight:500}
.notes>li{display:block;padding:10px 0}

/* Stat strip: joined tiles */
.stats{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:var(--r-card);overflow:hidden}
.stats>li{box-shadow:1px 1px 0 var(--line);min-width:0}
.stats>li>a,.stats>li>div{display:flex;flex-direction:column;gap:2px;height:100%;padding:14px 16px 12px;color:var(--ink);text-decoration:none}
.stats>li>a:hover{background:var(--fill)}
.stats>li>a[aria-current]{background:var(--fill);box-shadow:inset 0 -2px 0 var(--accent)}
.stat-label{font-size:12px;line-height:16px;color:var(--ink-2)}
.stat-value{font-size:28px;line-height:36px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-foot{display:flex;align-items:center;gap:8px;min-height:20px;font-size:12px;color:var(--ink-2)}
.stat-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.spark{display:block;width:100%;height:28px;margin-top:8px;overflow:visible}
.spark-area{fill:var(--accent-tint)}.spark-line{fill:none;stroke:var(--accent);stroke-width:1.5}
.stats .meter{margin-top:8px}
.stats.vertical{grid-template-columns:minmax(0,1fr)!important}
.stats.vertical>li>a,.stats.vertical>li>div{flex-direction:row;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;padding:12px 16px}
.stats.vertical .stat-label{font-size:13px}
.stats.vertical .stat-value{font-size:20px;line-height:28px}
.pill.dot-only{width:8px;height:8px;padding:0;background:none;gap:0}
.pill.dot-only::before{width:8px;height:8px}
.attention>li{align-items:flex-start;padding:10px 0;min-height:0}
.attention .pill.dot-only{margin-top:6px}
.section-lead{margin-bottom:16px}
.meter{display:block;width:100%;height:6px;border-radius:999px;overflow:hidden}
.meter-track{fill:var(--fill-2)}
.meter-fill{fill:var(--ink-2)}
.meter.warn .meter-fill{fill:var(--warn)}
.meter.bad .meter-fill{fill:var(--bad)}
.meter-row{display:grid;grid-template-columns:1fr auto;gap:4px 8px;align-items:baseline;margin-bottom:12px}
.meter-row .meter{grid-column:1/-1}
.meter-label{color:var(--ink-2)}
.meter-value{font-variant-numeric:tabular-nums;font-weight:500}
.meter-value .of{color:var(--ink-2);font-weight:400}
.cell-meter{display:grid;gap:4px;min-width:96px}

/* Charts */
.chart{margin:0;min-width:0}
.chart-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:28px;margin-bottom:12px}
.chart-title{font-size:14px;font-weight:600}
.chart-total{font-size:14px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.chart-note{font-size:12px;color:var(--ink-2)}
.chart-head .seg{margin-left:auto}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--r-ctl);background:var(--fill-2)}
.seg a{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:var(--r-chip);color:var(--ink-2);font:500 12px/1 var(--font);text-decoration:none}
.seg a:hover{color:var(--ink)}
.seg a[aria-current]{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.tabbed>.seg{margin-bottom:20px}
.seg .count{color:var(--ink-2);font-weight:400;margin-left:6px}
.connect{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border:1px dashed var(--line);border-radius:var(--r-card);color:var(--ink-2)}
.connect .grow{flex:1}
.if-plan,.if-account{display:none}
form:has(input[name=audience][value=plan]:checked) .if-plan,form:has(input[name=audience][value=account]:checked) .if-account{display:grid}
.incident{padding:12px 0;border-bottom:1px solid var(--line-2)}
.incident:last-child{border-bottom:0}
.incident .form{margin-top:10px;max-width:68ch}
.plot{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:180px auto;column-gap:10px}
.y-axis{display:flex;flex-direction:column;justify-content:space-between;margin:-6px 0;font:11px/12px var(--mono);color:var(--ink-2);text-align:right;font-variant-numeric:tabular-nums}
.plot svg{display:block;width:100%;height:180px;overflow:visible}
.x-axis{grid-column:2;display:flex;justify-content:space-between;padding-top:8px;font:11px/12px var(--mono);color:var(--ink-2)}
.grid-line{stroke:var(--line-2);stroke-width:1}
.base-line{stroke:var(--line);stroke-width:1}
.area{fill:var(--accent-tint)}
.line{fill:none;stroke:var(--accent);stroke-width:1.75;stroke-linejoin:round}
.hit{fill:transparent}
.hit:hover{fill:var(--fill-2)}
.s1{fill:var(--c1)}.s2{fill:var(--c2)}.s3{fill:var(--c3)}.s4{fill:var(--c4)}.s5{fill:var(--c5)}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 16px;margin:12px 0 0;padding:0;font-size:12px;color:var(--ink-2)}
.legend li{display:inline-flex;align-items:center;gap:6px}
.legend span{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:500}
.sw{display:inline-block;width:8px;height:8px;border-radius:2px}
i.s1{background:var(--c1)}i.s2{background:var(--c2)}i.s3{background:var(--c3)}i.s4{background:var(--c4)}i.s5{background:var(--c5)}
.parts-bar{display:block;width:100%;height:8px;border-radius:999px;overflow:hidden}

/* Tables */
.table-wrap{margin:0 -12px;min-width:0}
table{width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;z-index:1;height:36px;padding:0 12px;text-align:left;font:500 12px/16px var(--font);color:var(--ink-2);background:var(--card);border-bottom:1px solid var(--line);white-space:nowrap}
td{height:44px;padding:6px 12px;border-bottom:1px solid var(--line-2);vertical-align:middle;overflow-wrap:anywhere}
tbody tr:last-child td{border-bottom:0}
th.num,td.num{text-align:right}
th.quiet,td.quiet{width:44px;text-align:right}
tr[data-href]{cursor:pointer}
tbody tr:hover td{background:var(--fill)}
td a{color:var(--ink);font-weight:500}
td .cell{min-width:0}
td.num .cell{white-space:nowrap}
.table-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;padding-top:8px;border-top:1px solid var(--line-2);font-size:12px;color:var(--ink-2)}
.pager{display:flex;gap:8px}

/* Views, tabs, filters */
.views{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}
.views a{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;color:var(--ink-2);font-weight:500;white-space:nowrap}
.views a:hover{background:var(--fill);color:var(--ink);text-decoration:none}
.views a[aria-current]{background:var(--fill-2);color:var(--ink)}
.views .count,.tabs .count{color:var(--ink-2);font-weight:400;font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:20px;margin:0 0 20px;border-bottom:1px solid var(--line-2);overflow-x:auto;scrollbar-width:none}
.tabs a{display:inline-flex;align-items:center;gap:6px;height:36px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--ink-2);font-weight:500;white-space:nowrap}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--ink)}
.tabbed>.tab-panel{display:none;scroll-margin-top:400px}
.tabbed>.tab-panel:first-of-type{display:block}
.tabbed:has(>.tab-panel:target)>.tab-panel,.tabbed:has(>.tab-panel :target)>.tab-panel{display:none}
.tabbed:has(>.tab-panel:target)>.tab-panel:target,.tabbed:has(>.tab-panel :target)>.tab-panel:has(:target){display:block}
.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.toolbar .find{position:relative;display:flex;align-items:center;flex:0 1 260px;min-width:180px}
.toolbar .find .ico{position:absolute;left:9px;color:var(--ink-3);pointer-events:none}
.toolbar .find input{padding-left:30px;height:28px}
.toolbar .grow{flex:1}
details.chip-filter>summary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px dashed var(--line);color:var(--ink-2);font-weight:500;white-space:nowrap}
details.chip-filter>summary:hover{background:var(--fill)}
details.chip-filter>summary .ico{width:14px;height:14px}
details.chip-filter.on>summary{border-style:solid;background:var(--fill-2);color:var(--ink)}
.chip-value{color:var(--accent-ink)}
.chip-filter .menu-pop{min-width:200px}

/* Records: the page, and an inspector beside it once the page is wide enough (1200px for a whole page) */
.content,.split-item{container-type:inline-size}
.record{display:grid;gap:32px}
@container (min-width:880px){
.record{grid-template-columns:minmax(0,1fr) 340px;gap:0}
.record>.record-main{padding-right:24px;min-width:0}
.record>.inspector{border-left:1px solid var(--line-2);padding-left:24px}
}
@container (max-width:879.98px){
.split-item .record>.inspector{order:-1;padding-bottom:4px;border-bottom:1px solid var(--line-2)}
}
td details.menu>summary{border-color:transparent;background:none}
td details.menu>summary:hover,td details.menu[open]>summary{background:var(--fill-2)}
.inspector .form-grid{grid-template-columns:minmax(0,1fr)!important}
.field input{min-width:0}
.box.fill{display:flex;flex-direction:column}
.box.fill>.chart{flex:1;display:flex;flex-direction:column}
.box.fill .plot{flex:1;grid-template-rows:minmax(180px,1fr) auto;max-height:420px}
.box.fill .plot svg{height:100%;min-height:180px}
.headline .dot-only{width:10px;height:10px}
.mini{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 4px;padding:12px 0;border-top:1px solid var(--line-2);border-bottom:1px solid var(--line-2)}
.mini dt{font-size:12px;color:var(--ink-2)}
.mini dd{margin:2px 0 0;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.inspector{display:grid;gap:0;align-content:start;min-width:0}
.inspector>section{padding:0 0 20px;margin-bottom:20px;border-bottom:1px solid var(--line-2)}
.inspector>section:last-child{border-bottom:0;margin-bottom:0}
.inspector h2{font-size:13px;line-height:20px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.inspector .form{gap:10px}
.kv{display:grid;grid-template-columns:minmax(96px,auto) minmax(0,1fr);gap:8px 16px;margin:0;font-size:13px}
.kv>div{display:contents}
.kv dt{color:var(--ink-2)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kv dd .sub{flex-basis:100%}
.identity{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.identity .avatar{width:40px;height:40px;font-size:14px}
.identity strong{display:block;font-size:14px}

/* Split view: a list beside the open item */
.split{display:grid;min-height:100%}
.split-list{min-width:0;padding:16px 16px 24px;border-bottom:1px solid var(--line-2)}
.split-item{min-width:0;padding:24px}
.split .table-wrap{margin:0 -8px}
.queue{list-style:none;margin:0;padding:0}
.queue>li>a{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:10px 12px;margin:0 -8px;border-radius:var(--r-ctl);color:var(--ink)}
.queue>li>a:hover{background:var(--fill);text-decoration:none}
.queue>li>a[aria-current]{background:var(--fill-2)}
.queue .q-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.queue .sub{grid-column:1/-1}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:0}
.step{display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid var(--line-2)}
.step:last-child{border-bottom:0}
.step h3{margin:3px 0 6px}
.step p{color:var(--ink-2);max-width:68ch}
.step p+p,.step p+form,.step form+p{margin-top:8px}
.step-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--fill-2);font:600 12px/1 var(--mono);color:var(--ink-2)}
.step.done .step-mark{background:var(--good-tint);color:var(--good-ink)}
.word code{font-size:14px;padding:4px 8px}
.danger-box{border:1px solid var(--bad);border-radius:var(--r-card);padding:16px;background:var(--bad-tint)}

/* Communications: the composer, and the banner as a customer sees it */
.composer{display:grid;gap:24px;align-items:start}
.composer-preview{display:grid;gap:12px}
.banner-frame{padding:14px 14px 0;border-radius:var(--r-card);border:1px solid var(--line);font:400 14px/1.5 var(--font)}
.banner-frame .frame-label{display:block;margin:-2px 0 10px;font:500 11px/1 var(--mono);color:var(--ink-3)}
${SLOTLOCK_BANNER_CSS.split('\n').map((line) => `.banner-frame ${line}`).join('\n')}
${SLOTLOCK_ANNOUNCEMENT_BANNER_CSS.split('\n').map((line) => `.banner-frame ${line}`).join('\n')}
${bannerFrame('light')}
${bannerFrame('dark')}
.banner-frame .banner-frame-label{color:var(--ink-3)}
.typeahead{position:relative}
.typeahead-list{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;border-radius:var(--r-card);background:var(--raised);box-shadow:var(--pop-shadow)}
.typeahead-list li{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:var(--r-chip);cursor:pointer}
.typeahead-list li[aria-selected=true],.typeahead-list li:hover{background:var(--fill-2)}

/* The CMS editor: the post beside its preview, the inspector beside both */
.editor{display:grid;gap:24px;align-items:start}
.editor-main{display:grid;gap:16px;min-width:0}
.editor-main .title-input{height:44px;font-size:20px;font-weight:600;letter-spacing:-.02em;padding:0 12px}
.editor-main .cms-body{min-height:520px;font:400 13px/1.65 var(--mono)}
.preview-pane{min-width:0}
.ptabs{display:flex;gap:2px;padding:2px;border-radius:var(--r-ctl);background:var(--fill-2);width:max-content;margin-bottom:16px;border:0}
.ptabs label{position:relative;display:inline-flex}
.ptabs input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;width:100%;height:100%}
.ptabs span{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:var(--r-chip);color:var(--ink-2);font-weight:500;font-size:12.5px}
.ptabs input:checked+span{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.ptabs input:focus-visible+span{outline:2px solid var(--accent)}
.ppanel{display:none}
.preview-pane:has(#pt-article:checked) .pp-article,.preview-pane:has(#pt-serp:checked) .pp-serp,.preview-pane:has(#pt-card:checked) .pp-card{display:block}
.itabs-panel{display:none}
.inspector:has(#it-post:checked) .ip-post,.inspector:has(#it-seo:checked) .ip-seo,.inspector:has(#it-images:checked) .ip-images{display:grid}
.inspector .ptabs{margin-bottom:16px}
.checks{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.checks li{display:flex;gap:8px;align-items:flex-start}
.checks .mark{font-weight:700;width:1em;flex:none}
.checks li.ok .mark{color:var(--good-ink)}
.checks li.bad .mark{color:var(--bad-ink)}
.serp{display:grid;gap:2px;padding:16px;border:1px solid var(--line);border-radius:var(--r-card);max-width:600px}
.serp-url{font-size:12px;color:var(--ink-2)}
.serp-title{font-size:18px;line-height:1.3;color:var(--accent-ink)}
.serp-text{font-size:13px;color:var(--ink-2)}
.og{display:grid;align-content:space-between;gap:8px;max-width:520px;aspect-ratio:1200/630;padding:20px;border-radius:var(--r-card);background:#0a0b0d;color:#f4f3ee}
.og-eyebrow{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:#d9ff43}
.og-title{font-size:22px;font-weight:600;line-height:1.2}
.og-site{font:400 12px var(--mono);color:#b9b8b2}
.images li{display:grid;gap:4px}
.images code{font-size:11.5px;overflow-wrap:anywhere}
.article{max-width:68ch;font-size:15px;line-height:1.7;color:var(--ink-2)}
.article h2{margin:1.6em 0 .5em;font-size:20px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.article h3{margin:1.4em 0 .4em;font-size:16px;color:var(--ink)}
.article p,.article ul,.article ol{margin:0 0 1em}
.article a{color:var(--accent-ink)}
.article strong{color:var(--ink)}
.article code{font-size:.86em}
.article pre{margin:0 0 1.2em;padding:14px 16px;overflow-x:auto;border-radius:10px;background:var(--fill);color:var(--ink);font-size:13px;line-height:1.6}
.article pre code{padding:0;background:none}
.article table{margin:0 0 1.2em;font-size:14px}
.article th,.article td{position:static;height:auto;padding:8px 10px;border-bottom:1px solid var(--line)}
.article blockquote{margin:0 0 1em;padding-left:14px;border-left:3px solid var(--line)}
.article figure{margin:0 0 1.2em}
.article img{max-width:100%;height:auto;border-radius:10px}
.article .post-meta{margin:0 0 6px;font:12px var(--mono);color:var(--ink-2)}

/* Sign-in and refusals */
body.plain{display:grid;place-items:center;min-height:100vh;padding:16px}
.card{width:min(400px,100%);background:var(--card);border-radius:16px;padding:28px;box-shadow:var(--card-shadow)}
.card h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.02em;margin-bottom:6px}
.card p{color:var(--ink-2)}
.card-logo{margin:0 0 16px;width:44px;height:44px;display:grid;place-items:center;border-radius:12px;background:var(--fill-2)}
.card form{display:grid;gap:10px;margin-top:20px}
.card label{font:500 12px/16px var(--font);color:var(--ink-2)}
.card input{height:36px;padding:0 12px;border-radius:var(--r-ctl);border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit}
.card .btn{height:36px;justify-content:center}
.card .status{font-size:12px;color:var(--ink-2);min-height:16px}

/* Wide screens */
@media (min-width:760px){
.stats.n3{grid-template-columns:repeat(3,minmax(0,1fr))}
.stats.n4{grid-template-columns:repeat(4,minmax(0,1fr))}
.stats.n5{grid-template-columns:repeat(5,minmax(0,1fr))}
.stats.n6{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (min-width:1100px){
.c8{grid-column:span 8}.c4{grid-column:span 4}.c6{grid-column:span 6}.c3{grid-column:span 3}.c9{grid-column:span 9}
.form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.form-grid>.wide{grid-column:1/-1}
.composer{grid-template-columns:minmax(0,1fr) minmax(360px,440px)}
.composer-preview{position:sticky;top:0}
.editor{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
}
@media (min-width:1200px){
.editor{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 300px}
.editor>.inspector{border-left:1px solid var(--line-2);padding-left:24px}
.split{grid-template-columns:400px minmax(0,1fr);height:100%}
.split-list{border-bottom:0;border-right:1px solid var(--line-2);overflow:auto}
.split-item{overflow:auto}
}
@media (min-width:1920px){
.stats.n6{grid-template-columns:repeat(6,minmax(0,1fr))}
}
@media (max-width:1199px){
.split.open>.split-list{display:none}
}
@media (max-width:1099px){
.table-wrap{overflow-x:auto}
th{position:static}
.editor .preview-pane{order:3}
}

/* Phones: the sidebar becomes a bar with the sections in a row; the card is the page */
@media (max-width:759px){
.app{display:block;height:auto;overflow:visible}
.side{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:8px 12px 6px;overflow:visible}
.brand{padding:0 4px}
.nav{grid-column:1/-1;flex-direction:row;overflow-x:auto;gap:2px;padding-bottom:4px;scrollbar-width:none}
.nav a,.nav a.gap{flex:none;margin-top:0;height:32px}
.nav .count{margin-left:4px}
.side-foot{grid-row:1;grid-column:2;margin:0;padding:0}
.side-foot .avatar,.who{display:none}
.work{margin:0;border-radius:0;box-shadow:none;border-top:1px solid var(--line-2);overflow:visible}
.top{height:auto;min-height:52px;flex-wrap:wrap;padding:10px 16px;row-gap:10px}
.title{flex:1 1 100%;flex-wrap:wrap;row-gap:6px}
.title h1{font-size:17px;line-height:24px;white-space:normal;flex-wrap:wrap}
.title .here{white-space:normal;overflow-wrap:anywhere}
.search{order:3;flex:1 1 100%}
.actions{order:2}
.scroll{overflow:visible}
.content{padding:16px}
.anchors{margin:-16px -16px 16px;padding:8px 16px}
.table-wrap{margin:0;overflow:visible}
thead{display:none}
table,tbody,tr,td{display:block;width:100%}
tr{padding:10px 0;border-bottom:1px solid var(--line-2)}
tbody tr:last-child{border-bottom:0}
td{height:auto;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:3px 0;border:0}
td::before{content:attr(data-label);color:var(--ink-2);font-size:12px;flex:none}
td .cell{text-align:right;min-width:0}
td:first-child{padding-bottom:6px}
td:first-child::before,td.quiet::before,td[data-label=""]::before{display:none}
td:first-child .cell{text-align:left;flex:1}
th.quiet,td.quiet{width:auto}
td.nophone{display:none}
tbody tr:hover td{background:none}
.pop,.menu-pop,details.info>.pop,.typeahead-list.fixed{position:fixed;left:12px;right:12px;bottom:12px;top:auto;width:auto;max-height:70vh;overflow:auto}
.confirm-body{width:auto}
.drawer{top:auto;left:0;right:0;bottom:0;width:auto;max-height:92vh;border-radius:var(--r-card) var(--r-card) 0 0}
.split-item,.split-list{padding:16px}
.headline-figure{font-size:32px;line-height:40px}
.toast{left:12px;right:12px;bottom:12px;max-width:none}
}
@media (prefers-reduced-motion:reduce){.toast.done{animation-duration:0s}}
`;

/**
 * Progressive enhancement only: ⌘K or Ctrl+K (and /) focus the search; "g" then h, a, c, s or l
 * goes to Home, Accounts, Cases, Staff or the staff log; a button with data-copy copies its value;
 * a row with data-href opens; one menu open at a time, closed by Escape or a click elsewhere; a
 * drawer closes with Escape; tabs within a page follow the address; and, on forms that ask for them,
 * a character count, a time read back in the viewer's zone, an account found by name, and the
 * dashboard banner as the customer will see it.
 */
export const SLOTLOCK_ADMIN_JS = `(() => {
  const search = document.getElementById('q');
  let pending = false;
  const go = { h: '/', a: '/accounts', c: '/cases', s: '/staff', l: '/staff/log' };
  const typingIn = (target) => target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
  const openMenus = () => document.querySelectorAll('details.menu[open], details.popover[open], details.info[open], details.chip-filter[open]');
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      search?.focus();
      search?.select();
      return;
    }
    if (event.key === 'Escape') {
      const open = [...openMenus()];
      if (open.length) { for (const details of open) details.open = false; open[0].querySelector('summary')?.focus(); return; }
      const drawer = document.querySelector('.drawer[data-close]');
      if (drawer && !typingIn(event.target)) { window.location.assign(drawer.getAttribute('data-close')); return; }
    }
    if (typingIn(event.target)) return;
    if (event.key === '/') { event.preventDefault(); search?.focus(); return; }
    if (pending && go[event.key]) { window.location.assign(go[event.key]); pending = false; return; }
    pending = event.key === 'g';
  });
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.hidden = false;
    button.addEventListener('click', () => {
      navigator.clipboard?.writeText(button.getAttribute('data-copy') || '');
      button.setAttribute('title', 'Copied');
      button.classList.add('copied');
    });
  }
  for (const button of document.querySelectorAll('[data-dismiss]')) {
    button.hidden = false;
    button.addEventListener('click', () => button.closest('.toast')?.remove());
  }
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    for (const details of openMenus()) if (!details.contains(target)) details.open = false;
    const row = target.closest('tr[data-href]');
    if (row && !target.closest('a, button, input, select, textarea, summary, details, label') && !window.getSelection()?.toString()) {
      if (event.metaKey || event.ctrlKey) window.open(row.getAttribute('data-href'), '_blank', 'noopener');
      else window.location.assign(row.getAttribute('data-href'));
    }
  });
  document.addEventListener('toggle', (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    if (details.matches('details.menu, details.popover, details.chip-filter, details.info')) {
      for (const other of openMenus()) if (other !== details && !other.contains(details)) other.open = false;
    }
    const first = details.querySelector(':scope > .pop input:not([type=hidden]), :scope > .pop select, :scope > .pop textarea, :scope > .confirm-body input:not([type=hidden]), :scope > .confirm-body select, :scope > .confirm-body textarea');
    if (first) first.focus();
  }, true);
  const drawer = document.querySelector('.drawer');
  if (drawer) drawer.querySelector('input:not([type=hidden]), select, textarea, button, a[href]')?.focus();
  // Tabs within a page: the one the address names is current.
  const hashTabs = () => {
    for (const nav of document.querySelectorAll('[data-hash-tabs]')) {
      const links = [...nav.querySelectorAll('a[href^="#"]')];
      const panels = links.map((link) => document.getElementById(link.getAttribute('href').slice(1)));
      const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      let index = target ? panels.findIndex((panel) => panel && (panel === target || panel.contains(target))) : -1;
      if (index < 0) index = 0;
      links.forEach((link, i) => { if (i === index) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    }
  };
  hashTabs();
  window.addEventListener('hashchange', hashTabs);
  // Counters: n / max, red past it.
  for (const counter of document.querySelectorAll('[data-count-for]')) {
    const input = document.getElementById(counter.getAttribute('data-count-for'));
    if (!input) continue;
    const max = Number(input.getAttribute('maxlength')) || 0;
    const update = () => {
      counter.textContent = input.value.length + ' / ' + max;
      counter.classList.toggle('off', max > 0 && input.value.length > max);
    };
    input.addEventListener('input', update);
    update();
  }
  // A UTC minute read back in the viewer's own zone.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  for (const out of document.querySelectorAll('[data-local-for]')) {
    const input = document.getElementById(out.getAttribute('data-local-for'));
    if (!input) continue;
    const empty = out.getAttribute('data-empty') || '';
    const update = () => {
      if (!input.value) { out.textContent = empty; return; }
      const at = new Date(input.value + ':00Z');
      if (Number.isNaN(at.getTime())) { out.textContent = ''; return; }
      out.textContent = at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' in ' + zone;
    };
    input.addEventListener('input', update);
    update();
  }
  // The dashboard's banner, as the customer will see it, as the form changes.
  const composer = document.querySelector('[data-banner-form]');
  if (composer) {
    const labels = JSON.parse(composer.getAttribute('data-banner-labels') || '{}');
    const value = (name) => { const el = composer.elements.namedItem(name); return el && 'value' in el ? el.value : ''; };
    const update = () => {
      const kind = value('kind') || 'notice';
      for (const banner of document.querySelectorAll('[data-banner]')) {
        banner.className = 'test-banner announcement-banner announcement-' + kind;
        banner.querySelector('strong').textContent = (labels[kind] || '') + '.';
        banner.querySelector('[data-banner-message]').textContent = value('message') || banner.getAttribute('data-placeholder') || '';
        const link = banner.querySelector('a');
        const href = value('link');
        link.hidden = !/^https:\\/\\//.test(href);
        link.previousSibling.textContent = link.hidden ? '' : ' ';
        if (!link.hidden) link.setAttribute('href', href);
      }
    };
    composer.addEventListener('input', update);
    composer.addEventListener('change', update);
    update();
  }
  // An account chosen by name: the field keeps its reference.
  for (const input of document.querySelectorAll('input[data-typeahead]')) {
    const box = input.closest('.typeahead');
    if (!box) continue;
    const list = document.createElement('ul');
    list.className = 'typeahead-list';
    list.id = input.id + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    box.append(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    let timer = 0;
    let asked = 0;
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const choose = (item) => { input.value = item.getAttribute('data-ref'); close(); input.dispatchEvent(new Event('input', { bubbles: true })); };
    const show = (rows) => {
      list.replaceChildren();
      rows.forEach((row, index) => {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.id = list.id + '-' + index;
        item.setAttribute('data-ref', row.ref);
        const mark = document.createElement('span');
        mark.className = 'avatar sm';
        mark.textContent = row.initials;
        const text = document.createElement('span');
        text.className = 'ac-text';
        const name = document.createElement('span');
        name.textContent = row.label;
        const ref = document.createElement('span');
        ref.className = 'sub mono';
        ref.textContent = row.ref;
        text.append(name, ref);
        item.append(mark, text);
        item.addEventListener('mousedown', (event) => { event.preventDefault(); choose(item); });
        list.append(item);
      });
      list.hidden = rows.length === 0;
      input.setAttribute('aria-expanded', rows.length ? 'true' : 'false');
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const mine = ++asked;
        try {
          const response = await fetch('/accounts?' + new URLSearchParams({ q, format: 'json' }), { credentials: 'same-origin', headers: { accept: 'application/json' } });
          const rows = response.ok ? await response.json() : [];
          if (mine === asked) show(Array.isArray(rows) ? rows.slice(0, 8) : []);
        } catch { close(); }
      }, 250);
    });
    input.addEventListener('keydown', (event) => {
      const items = [...list.children];
      if (list.hidden || !items.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((item, index) => item.setAttribute('aria-selected', String(index === active)));
        input.setAttribute('aria-activedescendant', items[active].id);
      } else if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        choose(items[active]);
      } else if (event.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
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
