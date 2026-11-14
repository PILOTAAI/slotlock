// Phase 6 of the admin console (RFC 0006, M9 to M11): the pages for the site's search and visits,
// for announcements, service notices and the status page, and for the system: hosts, deploys,
// maintenance, webhooks, feature flags and configuration. Rendering only: app.ts reads the data
// through the admin functions and the providers, checks the role and handles the forms.
import { SLOTLOCK_ANNOUNCEMENT_LABELS, slotlockAnnouncementBannerParts } from '../design-tokens.js';
import {
  SLOTLOCK_ANNOUNCEMENT_KINDS,
  SLOTLOCK_ANNOUNCEMENT_MAX,
  SLOTLOCK_ANNOUNCEMENT_MAX_DAYS,
  SLOTLOCK_FEATURE_FLAGS,
  SLOTLOCK_MAINTENANCE_FAILURE_DAYS,
  SLOTLOCK_STAFF_PLANS,
  type SlotlockAnnouncementKind,
  type SlotlockFeatureFlag,
} from '../staff-ddl.js';
import type { SlotlockStatusIssue, SlotlockWorkflowRun } from './github-app.js';
import { type SlotlockSearchReport, type SlotlockSearchRow, type SlotlockVisitReport, slotlockLowClickPages } from './insights.js';
import {
  type Html,
  accountCell,
  chart,
  chip,
  count,
  drawer,
  facts,
  field,
  hashTabs,
  html,
  info,
  lastDays,
  menu,
  pill,
  popover,
  reasonField,
  section,
  stats,
  table,
  tabs,
  when,
} from './ui.js';

/** A provider part of a page: not connected, could not be read, or what it said. */
export type SlotlockProviderRead<T> = { state: 'off' } | { state: 'failed' } | { state: 'ok'; value: T };

/** What a page module gives the console's shell: the page, and what its top bar holds. */
export interface SlotlockPageParts {
  body: Html;
  pills?: Html;
  actions?: Html;
  drawer?: Html | null;
}

/** Where connecting a provider is written down (RFC 0006, Phase 0 and the console's setup). */
export const SLOTLOCK_ADMIN_SETUP_DOCS = 'https://github.com/PILOTAAI/slotlock/blob/main/docs/rfc/0006-admin-console.md';

/** What an announcement is about, as the console names it. */
export const SLOTLOCK_ANNOUNCEMENT_KIND_NAMES: Readonly<Record<SlotlockAnnouncementKind, string>> = Object.freeze({
  maintenance: 'Planned maintenance',
  change: 'A change to Slotlock',
  incident: 'Incident',
  notice: 'Notice',
});

/** Each feature flag as staff read it, and what turning it off does. */
export const SLOTLOCK_FEATURE_FLAG_NAMES: Readonly<Record<SlotlockFeatureFlag, { name: string; off: string }>> = Object.freeze({
  assistant: { name: 'Assistant', off: 'The dashboard hides its chat assistant, and its pages answer "not found".' },
  team_workspaces: { name: 'Creating team workspaces', off: 'The person cannot create a team. Teams they are in work as before.' },
});

const percent = (ratio: number) => `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
const position = (value: number) => (value > 0 ? value.toFixed(1) : '–');
const hidden = (csrf: string) => html`<input type="hidden" name="csrf" value="${csrf}">`;
/** A path on the site, from a full URL a search engine gave; the URL itself when it is another site's. */
const pathOf = (url: string, siteUrl: string) => (url.startsWith(siteUrl) ? url.slice(siteUrl.length) || '/' : url);

/** A provider's part: one compact card to connect it, one line when it failed, else what it read. */
function providerPart<T>(name: string, read: SlotlockProviderRead<T>, off: Html, render: (value: T) => Html): Html {
  if (read.state === 'off') {
    return html`<div class="connect"><span class="grow">${name} is not connected.</span>${info(`Connecting ${name}`, off)}<a class="btn sm" href="${SLOTLOCK_ADMIN_SETUP_DOCS}" rel="noreferrer">Connect</a></div>`;
  }
  if (read.state === 'failed') return html`<div class="connect"><span class="grow">${name} could not be read just now.</span><span class="muted">Tried again on the next visit.</span></div>`;
  return render(read.value);
}

function searchRows(caption: string, first: string, rows: readonly SlotlockSearchRow[], label: (row: SlotlockSearchRow) => Html, empty: string, compact = false): Html {
  return table(caption, compact
    ? [first, { label: 'Clicks', num: true }, { label: 'Impressions', num: true }]
    : [first, { label: 'Clicks', num: true }, { label: 'Impressions', num: true }, { label: 'CTR', num: true }, { label: 'Position', num: true }], rows.map((row) => [
    label(row),
    html`${count(row.clicks)}`,
    html`${count(row.impressions)}`,
    ...(compact ? [] : [html`${percent(row.ctr)}`, html`${position(row.position)}`]),
  ]), empty);
}

/** A workflow run's result, in words. */
function runPill(run: SlotlockWorkflowRun): Html {
  if (run.status !== 'completed') return pill('Running', 'info');
  if (run.conclusion === 'success') return pill('Passed', 'good');
  if (run.conclusion === 'skipped' || run.conclusion === 'cancelled') return pill(run.conclusion === 'skipped' ? 'Skipped' : 'Cancelled', 'muted');
  return pill('Failed', 'bad');
}

function runsTable(caption: string, runs: readonly SlotlockWorkflowRun[], empty: string): Html {
  return table(caption, ['Run', 'Result', 'Commit', 'Started'], runs.map((run) => [
    html`<a href="${run.url}" rel="noreferrer">${run.name}</a><span class="sub">${run.event}</span>`,
    runPill(run),
    html`<code>${run.sha.slice(0, 7)}</code>`,
    html`${when(run.createdAt)}`,
  ]), empty);
}

// ---------- M9: Site and search ----------

export interface SlotlockSitePageData {
  siteUrl: string;
  google: SlotlockProviderRead<SlotlockSearchReport>;
  bing: SlotlockProviderRead<SlotlockSearchReport>;
  visits: SlotlockProviderRead<SlotlockVisitReport>;
  /** The site workflow's last runs on main: its builds, checks and deploys. */
  deploys: SlotlockProviderRead<SlotlockWorkflowRun[]>;
  now: number;
}

export function slotlockSitePage(data: SlotlockSitePageData): SlotlockPageParts {
  const site = data.siteUrl.replace(/\/$/, '');
  const pageLink = (row: SlotlockSearchRow) => {
    const path = pathOf(row.key, site);
    return path.startsWith('/') ? html`<a href="${site}${path}" rel="noreferrer">${path}</a>` : html`${path}`;
  };
  const readAt = (at: number) => info('When it was read', `Read ${when(new Date(at))} UTC, kept for an hour.`);
  const searchPart = (name: string, read: SlotlockProviderRead<SlotlockSearchReport>, off: Html, google: boolean) =>
    providerPart(name, read, off, (report) => {
      const posts = report.pages.filter((row) => /^\/blog\/[a-z0-9-]+\/?$/.test(pathOf(row.key, site)));
      const low = slotlockLowClickPages(report.pages);
      return html`
        ${stats([
          { label: 'Clicks', value: count(report.clicks), note: `${report.from} to ${report.to}` },
          { label: 'Impressions', value: count(report.impressions) },
          { label: 'CTR', value: report.impressions > 0 ? percent(report.clicks / report.impressions) : '–' },
        ])}
        <div class="grid">
          <div class="c6">${section('Top queries', searchRows(`${name} queries`, 'Query', report.queries.slice(0, 15), (row) => html`${row.key}`, 'No queries in this period.', true), { level: 3, info: readAt(report.readAt) })}</div>
          <div class="c6">${section('Top pages', searchRows(`${name} pages`, 'Page', report.pages.slice(0, 15), pageLink, 'No pages in this period.', true), { level: 3 })}</div>
        </div>
        ${google
          ? html`<section class="section" id="titles"><header class="section-head"><h3>Worth a new title</h3>${info('Worth a new title', 'Seen at least 100 times and clicked under 2% of the time (RFC 0005, Phase 5). A clearer title or description may earn the click.')}</header>
              ${searchRows('Pages worth a new title', 'Page', low, pageLink, 'No page is seen often and clicked rarely.')}</section>
            <section class="section" id="posts"><header class="section-head"><h3>Blog posts</h3></header>
              ${searchRows('Blog posts in search', 'Post', posts, pageLink, 'No blog post was seen in Google results in this period.')}</section>
            ${report.sitemaps.length
              ? section('Sitemaps', table('Sitemaps', ['Sitemap', { label: 'Pages', num: true }, 'Last read', { label: 'Errors', num: true }, { label: 'Warnings', num: true }], report.sitemaps.map((entry) => [
                  html`<span class="mono">${entry.path}</span>`,
                  html`${count(entry.submitted)}`,
                  html`${when(entry.lastDownloaded)}`,
                  entry.errors > 0 ? pill(String(entry.errors), 'bad') : html`0`,
                  entry.warnings > 0 ? pill(String(entry.warnings), 'warn') : html`0`,
                ]), 'No sitemaps.'), { level: 3 })
              : ''}`
          : ''}`;
    });
  const googlePart = searchPart('Search Console', data.google,
    html`Add a service account to the property as a restricted user, and set <code>SLOTLOCK_ADMIN_SEARCH_CONSOLE_KEY</code> and <code>SLOTLOCK_ADMIN_SEARCH_CONSOLE_PROPERTY</code>.`, true);
  const bingPart = searchPart('Bing Webmaster Tools', data.bing,
    html`Set <code>SLOTLOCK_ADMIN_BING_KEY</code> to an API key from Bing Webmaster Tools' settings, and <code>SLOTLOCK_ADMIN_BING_SITE</code>.`, false);
  const visitsPart = providerPart('Cloudflare Web Analytics', data.visits,
    html`Set <code>SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN</code> (Account Analytics Read), <code>SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT</code> and <code>SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE</code> (the site tag).`,
    (report) => {
      const days = report.days.length ? report.days.map((point) => point.day) : lastDays(28, data.now);
      return html`
        <div class="box">${chart({
          title: 'Page loads',
          labels: days,
          series: [{ name: 'Page loads', values: days.map((key) => report.days.find((point) => point.day === key)?.count ?? 0) }],
          kind: 'area',
          total: count(report.pageLoads),
          note: `${report.from} to ${report.to}`,
          control: info('Cloudflare Web Analytics', `Counts without cookies and keeps no visitor. Read ${when(new Date(report.readAt))} UTC, kept for an hour.`),
        })}</div>
        <div class="grid">
          <div class="c6">${section('Top pages', table('Top pages by page loads', ['Page', { label: 'Page loads', num: true }], report.pages.map((row) => [
            row.path.startsWith('/') ? html`<a href="${site}${row.path}" rel="noreferrer">${row.path}</a>` : html`${row.path}`, html`${count(row.count)}`,
          ]), 'No page loads in this period.'), { level: 3 })}</div>
          <div class="c6">${section('Referrers', report.referrers === null
            ? html`<p class="muted">Cloudflare did not give referrers just now.</p>`
            : table('Referrers by page loads', ['From', { label: 'Page loads', num: true }], report.referrers.map((row) => [
                html`${row.host}`, html`${count(row.count)}`,
              ]), 'No visits came from another site in this period.'), { level: 3 })}</div>
        </div>`;
    });
  const deployPart = providerPart('GitHub', data.deploys,
    html`The site's deploys come from Slotlock's GitHub App, with Actions (read).`,
    (runs) => runsTable('Site workflow runs on main', runs, 'No runs of the site workflow on main yet.'));
  const body = html`
    ${section('Visitors', visitsPart)}
    ${section('Search', hashTabs('Source', [
      { id: 'google', label: 'Google', body: googlePart },
      { id: 'bing', label: 'Bing', body: bingPart },
    ], 'seg'))}
    ${section('Deploys', deployPart, { id: 'deploys', info: info('Deploys', 'Each run builds the site and runs its copy lint and SEO check before it deploys: a failed run deployed nothing.') })}`;
  return { body, actions: html`<a class="btn" href="${site}/" rel="noreferrer">Open the site</a>` };
}

// ---------- M10: Communications ----------

export interface SlotlockAnnouncementRow {
  id: string;
  audience: string;
  plan: string | null;
  account_ref: string | null;
  kind: SlotlockAnnouncementKind;
  message: string;
  link: string | null;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  ended_at: Date | null;
  state: 'live' | 'scheduled' | 'ended' | 'over';
  /** What its account is called (staff_directory), for one to one account. */
  account_name?: string | null;
  account_display?: string | null;
}

/** An account by what the admin function says it is called, beside its reference. */
const namedCell = (row: { account_ref: string; account_name?: string | null; account_display?: string | null }, accountHref: (ref: string) => string) =>
  accountCell({ ref: row.account_ref, name: row.account_name ?? null, display: row.account_display ?? null, href: accountHref(row.account_ref) });

export interface SlotlockCommunicationsPageData {
  csrf: string;
  /** Whether this member writes announcements and incidents (system.act). */
  mayAct: boolean;
  announcements: readonly SlotlockAnnouncementRow[];
  endedToo: boolean;
  /** An account to prefill a service notice for (?account=). */
  account: string | null;
  /** The status page's incidents, open and recently closed; off without the GitHub App. */
  incidents: SlotlockProviderRead<{ open: SlotlockStatusIssue[]; closed: SlotlockStatusIssue[] }>;
  /** Names for staff references. */
  names: ReadonlyMap<string, string>;
  /** When the page was drawn, for the form's default end. */
  now: number;
}

const STATE_PILLS: Readonly<Record<SlotlockAnnouncementRow['state'], Html>> = {
  live: pill('Showing', 'good'),
  scheduled: pill('Scheduled', 'info'),
  ended: pill('Ended', 'muted'),
  over: pill('Ran out', 'muted'),
};

const PLAN_WORDS: Readonly<Record<string, string>> = Object.freeze({ free: 'Free', developer: 'Developer', team: 'Team' });

const audienceText = (row: SlotlockAnnouncementRow, accountHref: (ref: string) => string): Html =>
  row.audience === 'everyone'
    ? html`Every account`
    : row.audience === 'plan'
      ? html`${chip(PLAN_WORDS[row.plan ?? ''] ?? row.plan ?? '', 'info')} plan`
      : namedCell({ ...row, account_ref: row.account_ref ?? '' }, accountHref);

/** A datetime-local value, in UTC as the form says. */
const minuteInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** The dashboard's banner, with its own markup and CSS, on its own canvas in one theme. */
function bannerPreview(theme: 'light' | 'dark', kind: SlotlockAnnouncementKind): Html {
  const parts = slotlockAnnouncementBannerParts(kind);
  return html`<div class="banner-frame ${theme}"><span class="frame-label">Dashboard, ${theme}</span><p class="${parts.className}" data-banner data-placeholder="Your message, as customers read it."><strong>${parts.label}</strong> <span data-banner-message>Your message, as customers read it.</span> <a href="#" hidden>${parts.more}</a></p></div>`;
}

export function slotlockCommunicationsPage(data: SlotlockCommunicationsPageData, accountHref: (ref: string) => string): SlotlockPageParts {
  const csrf = hidden(data.csrf);
  const rows = data.announcements.map((row) => [
    html`<strong>${SLOTLOCK_ANNOUNCEMENT_KIND_NAMES[row.kind]}.</strong> ${row.message}${row.link ? html`<span class="sub"><a href="${row.link}" rel="noreferrer">${row.link}</a></span>` : ''}`,
    audienceText(row, accountHref),
    html`${when(row.starts_at)}<span class="sub">to ${when(row.ends_at)} UTC</span>`,
    html`${STATE_PILLS[row.state]}<span class="sub">${data.names.get(row.created_by) ?? row.created_by}</span>`,
    data.mayAct && (row.state === 'live' || row.state === 'scheduled')
      ? html`<form class="inline" method="post" action="/communications/end">${csrf}<input type="hidden" name="announcement" value="${row.id}"><button class="btn sm" type="submit">End now</button></form>`
      : html``,
  ]);
  const kindOptions = SLOTLOCK_ANNOUNCEMENT_KINDS.map((kind) => html`<option value="${kind}">${SLOTLOCK_ANNOUNCEMENT_KIND_NAMES[kind]}</option>`);
  const planOptions = SLOTLOCK_STAFF_PLANS.map((plan) => html`<option value="${plan}">${PLAN_WORDS[plan] ?? plan}</option>`);
  const audience = (value: string, label: string, checked: boolean) =>
    html`<label><input type="radio" name="audience" value="${value}"${checked ? html` checked` : ''}><span>${label}</span></label>`;
  const firstKind = SLOTLOCK_ANNOUNCEMENT_KINDS[0] ?? 'notice';
  const composer = data.mayAct
    ? html`<section class="section" aria-labelledby="compose-title">
        <header class="section-head"><h2 id="compose-title">New announcement</h2>${info('Announcements', `One line above every page of the dashboard while it runs, at most ${SLOTLOCK_ANNOUNCEMENT_MAX_DAYS} days. A notice to one account is a service notice: its audit log says Slotlock staff sent it. Never marketing.`)}</header>
        <div class="composer">
          <form class="form" method="post" action="/communications" data-banner-form data-banner-labels="${JSON.stringify(SLOTLOCK_ANNOUNCEMENT_LABELS)}">${csrf}
            <div class="form-grid">
              ${field({ id: 'announce-kind', label: 'Kind', control: html`<select id="announce-kind" name="kind">${kindOptions}</select>` })}
              <div class="field"><span class="label" id="announce-audience-label">Audience</span>
                <fieldset class="segmented" aria-labelledby="announce-audience-label">
                  ${audience('everyone', 'Everyone', !data.account)}${audience('plan', 'Plan', false)}${audience('account', 'Account', Boolean(data.account))}
                </fieldset></div>
              <div class="if-plan wide">${field({ id: 'announce-plan', label: 'Plan', control: html`<select id="announce-plan" name="plan"><option value="">Choose a plan</option>${planOptions}</select>` })}</div>
              <div class="if-account wide">${field({ id: 'announce-account', label: 'Account', control: html`<span class="typeahead"><input id="announce-account" name="account" value="${data.account ?? ''}" maxlength="500" autocomplete="off" spellcheck="false" placeholder="Search by name or reference" data-typeahead></span>` })}</div>
              ${field({ id: 'announce-message', label: 'Message', public: true, wide: true, extra: html`<span class="counter" data-count-for="announce-message"></span>`, control: html`<input id="announce-message" name="message" required maxlength="${SLOTLOCK_ANNOUNCEMENT_MAX}" autocomplete="off">` })}
              ${field({ id: 'announce-link', label: 'Link', optional: true, public: true, wide: true, control: html`<input id="announce-link" name="link" type="url" maxlength="300" placeholder="https://" autocomplete="off">` })}
              ${field({ id: 'announce-starts', label: 'From, UTC', optional: true, control: html`<input id="announce-starts" name="starts" type="datetime-local">`, after: html`<span class="readback" data-local-for="announce-starts" data-empty="Now"></span>` })}
              ${field({ id: 'announce-ends', label: 'Until, UTC', control: html`<input id="announce-ends" name="ends" type="datetime-local" required value="${minuteInput(data.now + 86_400_000)}">`, after: html`<span class="readback" data-local-for="announce-ends"></span>` })}
            </div>
            <div class="form-actions"><button class="btn primary" type="submit">Announce</button></div>
          </form>
          <div class="composer-preview" aria-label="Preview">
            ${bannerPreview('dark', firstKind)}
            ${bannerPreview('light', firstKind)}
          </div>
        </div>
      </section>`
    : '';
  const list = section(data.endedToo ? 'All announcements' : 'Showing and scheduled', table('Announcements', ['Message', 'Audience', 'Runs', 'State', { label: 'Actions', quiet: true }], rows, data.endedToo ? 'No announcements yet.' : 'Nothing is showing or scheduled.'), {
    aside: tabs('Announcements', [
      { label: 'Current', href: '/communications', current: !data.endedToo },
      { label: 'All', href: '/communications?ended=1', current: data.endedToo },
    ], 'views'),
  });
  const incidents = providerPart('The status page', data.incidents,
    html`It needs Slotlock's GitHub App with Issues (read and write).`,
    ({ open, closed }) => html`
      ${open.length === 0
        ? html`<div class="callout good"><p>No open incident. The status page shows hosted Slotlock as up.</p></div>`
        : html`<div class="incidents">${open.map((issue) => html`<div class="incident">
            <p><a href="${issue.url}" rel="noreferrer"><strong>#${issue.number} ${issue.title}</strong></a> <span class="muted">Opened ${when(issue.createdAt)} · ${count(issue.comments)} ${issue.comments === 1 ? 'update' : 'updates'}</span></p>
            ${data.mayAct
              ? html`<form class="form" method="post" action="/communications/status/update">${csrf}<input type="hidden" name="issue" value="${issue.number}">
                  ${field({ id: `update-${issue.number}`, label: 'Update', public: true, control: html`<textarea id="update-${issue.number}" name="body" rows="2" maxlength="2000" required></textarea>` })}
                  <label class="check"><input type="checkbox" name="close" value="1"> Resolved: close the incident with this update</label>
                  <div class="form-actions"><button class="btn sm" type="submit">Post update</button></div></form>`
              : ''}
          </div>`)}</div>`}
      ${closed.length
        ? section('Recently resolved', table('Resolved incidents', ['Incident', 'Opened', 'Resolved'], closed.map((issue) => [
            html`<a href="${issue.url}" rel="noreferrer">#${issue.number} ${issue.title}</a>`, html`${when(issue.createdAt)}`, html`${when(issue.closedAt)}`,
          ]), ''), { level: 3 })
        : ''}`);
  const statusPanel = html`${section('Incidents', incidents, {
    info: info('The status page', html`Incidents are issues labelled <code>status</code> (docs/hosted/status.md); the probe opens and closes its own. Read from GitHub as the page opens.`),
    aside: html`${data.mayAct && data.incidents.state === 'ok'
      ? popover('Open an incident', html`<form class="form" method="post" action="/communications/status">${csrf}
          ${field({ id: 'incident-title', label: 'Title', public: true, control: html`<input id="incident-title" name="title" required maxlength="120" autocomplete="off">` })}
          ${field({ id: 'incident-body', label: 'What is happening', public: true, control: html`<textarea id="incident-body" name="body" rows="3" maxlength="2000" required></textarea>` })}
          <div class="form-actions"><button class="btn danger" type="submit">Open incident</button></div></form>`, { tone: 'danger', size: 'sm' })
      : ''}`,
  })}`;
  const openCount = data.incidents.state === 'ok' ? data.incidents.value.open.length : 0;
  const body = hashTabs('Communications', [
    { id: 'announcements', label: 'Announcements', body: html`${composer}${list}` },
    { id: 'status', label: 'Status page', body: statusPanel, count: openCount },
  ]);
  return { body, ...(openCount ? { pills: pill(`${openCount} open ${openCount === 1 ? 'incident' : 'incidents'}`, 'bad') } : {}) };
}

// ---------- M11: System ----------

export interface SlotlockHostHealth {
  name: string;
  url: string;
  up: boolean;
  /** What it answered: a status code, "not ready", or why there was no answer. */
  answer: string;
  version: string | null;
  ms: number;
}

export interface SlotlockSystemData {
  webhooks: {
    accounts: number; capped: boolean; endpoints: number; failing: number; failing_accounts: number;
    failing_since: string | null; disabled: number;
  };
  rounds: { started_at: string; finished_at: string; attention: boolean; summary: Record<string, number> }[];
  failing: {
    account_ref: string; first_failed_at: string; last_failed_at: string; failures: number; error: string;
    code: string | null; message: string | null; account_name?: string | null; account_display?: string | null;
  }[];
  failing_total: number;
  jobs: Record<string, { finished_at: string; attention: boolean }>;
}

export interface SlotlockFlagsData {
  flags: { id: string; flag: SlotlockFeatureFlag; plan: string | null; account_ref: string | null; enabled: boolean; reason: string; set_by: string; set_at: string; account_name?: string | null; account_display?: string | null }[];
  history: { occurred_at: string; staff_ref: string; action: string; account_ref: string | null; reason: string | null; metadata: { flag?: string; plan?: string | null; from?: boolean | null; to?: boolean | null }; account_name?: string | null; account_display?: string | null }[];
}

export interface SlotlockSystemPageData {
  csrf: string;
  mayAct: boolean;
  system: SlotlockSystemData;
  flags: SlotlockFlagsData;
  hosts: SlotlockHostHealth[];
  deploys: SlotlockProviderRead<{ workflow: string; label: string; runs: SlotlockWorkflowRun[] }[]>;
  /** The settings this console runs with: names and values, never a secret. */
  configuration: { name: string; value: string }[];
  names: ReadonlyMap<string, string>;
  now: number;
  /** The drawer the address asks for: a flag to set (?panel=flag), or one to change (?panel=flag&flag=<id>). */
  panel?: { kind: 'flag'; id: string | null } | null;
}

const onOff = (value: boolean | null | undefined) => (value === true ? 'on' : value === false ? 'off' : 'as configured');

export function slotlockSystemPage(data: SlotlockSystemPageData, accountHref: (ref: string) => string): SlotlockPageParts {
  const csrf = hidden(data.csrf);
  const { system } = data;
  const last = system.rounds[0];
  const hourSince = last ? data.now - new Date(last.finished_at).getTime() : null;
  const down = data.hosts.filter((host) => !host.up);
  // The headline: hosts down, then accounts whose maintenance fails, or no maintenance recorded lately.
  const failingTotal = Number(system.failing_total);
  const lateHours = hourSince !== null && hourSince > 3 * 3_600_000 ? Math.floor(hourSince / 3_600_000) : null;
  const problems = [
    ...(down.length ? [`${count(down.length)} ${down.length === 1 ? 'host is' : 'hosts are'} down`] : []),
    ...(failingTotal > 0 ? [`Maintenance failing for ${count(failingTotal)} ${failingTotal === 1 ? 'account' : 'accounts'}`] : []),
    ...(lateHours !== null ? [`No maintenance recorded for ${count(lateHours)} hours`] : []),
  ];
  const tone = down.length ? 'bad' : problems.length ? 'warn' : 'good';
  const flagName = (flag: string) => SLOTLOCK_FEATURE_FLAG_NAMES[flag as SlotlockFeatureFlag]?.name ?? flag;
  const editing = data.panel?.kind === 'flag' && data.mayAct ? (data.flags.flags.find((flag) => flag.id === data.panel?.id) ?? null) : null;
  const option = (value: string, label: string, current: string | null | undefined) => html`<option value="${value}"${current === value ? html` selected` : ''}>${label}</option>`;
  const flagForm = html`<form class="form" method="post" action="/system/flags">${csrf}
      ${field({ id: 'flag-name', label: 'Feature', control: html`<select id="flag-name" name="flag">${SLOTLOCK_FEATURE_FLAGS.map((flag) => option(flag, SLOTLOCK_FEATURE_FLAG_NAMES[flag].name, editing?.flag))}</select>` })}
      <div class="form-grid">
        ${field({ id: 'flag-plan', label: 'For a plan', control: html`<select id="flag-plan" name="plan"><option value="">None: one account</option>${SLOTLOCK_STAFF_PLANS.map((plan) => option(plan, PLAN_WORDS[plan] ?? plan, editing?.plan))}</select>` })}
        ${field({ id: 'flag-state', label: 'Set to', control: html`<select id="flag-state" name="enabled">${option('0', 'Off', editing ? (editing.enabled ? '1' : '0') : '0')}${option('1', 'On', editing ? (editing.enabled ? '1' : '0') : '0')}</select>` })}
      </div>
      ${field({ id: 'flag-account', label: 'Or one account', control: html`<span class="typeahead"><input id="flag-account" name="account" maxlength="500" autocomplete="off" spellcheck="false" value="${editing?.account_ref ?? ''}" placeholder="Search by name or reference" data-typeahead></span>` })}
      ${reasonField('flag-reason', { public: true })}
      <dl class="kv">${SLOTLOCK_FEATURE_FLAGS.map((flag) => html`<div><dt>${SLOTLOCK_FEATURE_FLAG_NAMES[flag].name} off</dt><dd class="muted">${SLOTLOCK_FEATURE_FLAG_NAMES[flag].off}</dd></div>`)}</dl>
      <div class="form-actions"><button class="btn primary" type="submit">Set flag</button></div>
    </form>
    ${editing
      ? section('Remove', html`<form class="form" method="post" action="/system/flags/clear">${csrf}<input type="hidden" name="flag" value="${editing.id}">${reasonField(`clear-drawer-${editing.id}`, { public: Boolean(editing.account_ref) })}<div class="form-actions"><button class="btn danger" type="submit">Remove flag</button></div></form>`, { level: 3 })
      : ''}`;
  const flagDrawer = data.panel?.kind === 'flag' && data.mayAct
    ? drawer(editing ? `${flagName(editing.flag)}, ${editing.account_ref ? (editing.account_name || editing.account_display || editing.account_ref) : `the ${editing.plan ?? ''} plan`}` : 'Set a flag', flagForm, '/system#flags')
    : null;
  const body = html`
    <nav class="anchors" aria-label="On this page"><a href="#hosts">Hosts</a><a href="#maintenance">Maintenance</a><a href="#webhooks">Webhooks</a><a href="#deploys">Deploys</a><a href="#flags">Flags</a><a href="#configuration">Configuration</a></nav>
    <div class="headline"><span class="pill ${tone} dot-only" aria-hidden="true"></span><span class="headline-text">${problems.length ? problems.join(' · ') : 'All systems operational'}</span></div>
    ${section('Hosts', table('Hosts', ['Host', 'State', 'Version', { label: 'Latency', num: true }], data.hosts.map((host) => [
      html`${host.name}<span class="sub mono">${host.url}</span>`,
      host.up ? pill('Up', 'good') : html`${pill('Down', 'bad')}<span class="sub">${host.answer}</span>`,
      html`${host.version ? html`<code>${host.version}</code>` : '–'}`,
      html`${count(host.ms)} ms`,
    ]), 'No hosts to check.'), { id: 'hosts', info: info('Hosts', 'Asked as this page opened, with a five-second limit. The public status page probes them every five minutes, from a Cloudflare Worker.') })}

    <section class="section" id="maintenance"><header class="section-head"><h2>Maintenance</h2></header>
      ${stats([
        { label: 'Accounts failing', value: count(system.failing_total) },
        { label: 'Last hour recorded', value: last ? `${when(last.finished_at).slice(11)} UTC` : 'Never', note: last ? `${when(last.finished_at).slice(0, 10)} · ${count(last.summary.passes ?? 0)} passes, ${count(last.summary.failed ?? 0)} failed` : null },
      ])}
      ${lateHours !== null ? html`<div class="callout warn section"><p>No server has recorded maintenance for ${count(lateHours)} hours. Check that <code>slotlock serve</code> is running.</p></div>` : ''}
      ${section('Accounts whose maintenance is failing', table('Accounts whose maintenance is failing', ['Account', 'Failing since', 'Last failed', { label: 'Failures', num: true }, 'Error'], system.failing.map((row) => [
        namedCell(row, accountHref),
        html`${when(row.first_failed_at)}`,
        html`${when(row.last_failed_at)}`,
        html`${count(row.failures)}`,
        html`<code>${row.error}${row.code ? ` ${row.code}` : ''}</code>${row.message ? html`<span class="sub">${row.message}</span>` : ''}`,
      ]), 'Every account’s last pass ran.'), { level: 3, info: info('Errors', `The error's class, code and first line up to its first quotation mark, where a value would start: never the account's data. Cleared when a pass runs; kept ${SLOTLOCK_MAINTENANCE_FAILURE_DAYS} days otherwise.`) })}
      ${section('The last day, by server hour', table('Maintenance hours', ['Hour to', { label: 'Passes', num: true }, { label: 'Failed', num: true }, { label: 'Extended', num: true }, { label: 'Pruned', num: true }, { label: 'Released', num: true }], system.rounds.map((round) => [
        html`${when(round.finished_at)}<span class="sub">from ${when(round.started_at)}</span>`,
        html`${count(round.summary.passes ?? 0)}`,
        round.attention ? pill(count(round.summary.failed ?? 0), 'bad') : html`0`,
        html`${count(round.summary.extended ?? 0)}`,
        html`${count(round.summary.pruned ?? 0)}`,
        html`${count((round.summary.noShows ?? 0) + (round.summary.approvalsExpired ?? 0))}`,
      ]), 'No hour recorded yet.'), { level: 3 })}
      ${section('Billing jobs', table('Billing jobs', ['Job', 'Last run', 'State'], ['billing_daily', 'overage_report'].map((job) => [
        html`<code>${job.replace('_', ' ')}</code>`,
        html`${when(system.jobs[job]?.finished_at)}`,
        system.jobs[job] ? (system.jobs[job]?.attention ? pill('Needs attention', 'warn') : pill('Clean', 'good')) : pill('Never run', 'muted'),
      ]), ''), { level: 3 })}
    </section>

    ${section('Webhooks', stats([
      { label: 'Endpoints', value: count(system.webhooks.endpoints), note: `${count(system.webhooks.accounts)} accounts${system.webhooks.capped ? ', the first counted' : ''}` },
      { label: 'Failing', value: count(system.webhooks.failing), note: system.webhooks.failing ? `in ${count(system.webhooks.failing_accounts)} accounts, since ${when(system.webhooks.failing_since)}` : null },
      { label: 'Turned off', value: count(system.webhooks.disabled) },
    ]), { id: 'webhooks', info: info('Webhooks', 'Counts only: no endpoint address and no payload. Each account’s own page lists its endpoints. Turned off: by their owner, or after failing for days.') })}

    ${section('Deploys', providerPart('GitHub', data.deploys, html`Deploys come from Slotlock's GitHub App, with Actions (read).`, (workflows) => html`${workflows.map(
      (workflow) => section(workflow.label, runsTable(`${workflow.label} runs on main`, workflow.runs, 'No runs on main yet.'), { level: 3 }),
    )}`), { id: 'deploys' })}

    ${section('Feature flags', html`
      ${table('Feature flags', ['Feature', 'Scope', 'State', 'Reason', { label: 'Actions', quiet: true }], data.flags.flags.map((flag) => [
        html`${flagName(flag.flag)}`,
        flag.account_ref ? namedCell({ ...flag, account_ref: flag.account_ref }, accountHref) : html`${chip(PLAN_WORDS[flag.plan ?? ''] ?? flag.plan ?? '', 'info')} plan`,
        flag.enabled ? pill('On', 'good') : pill('Off', 'warn'),
        html`${flag.reason}<span class="sub">${data.names.get(flag.set_by) ?? flag.set_by} · ${when(flag.set_at)}</span>`,
        data.mayAct
          ? menu([
              { label: 'Change', href: `/system?panel=flag&flag=${flag.id}#flags` },
              { label: 'Remove flag', danger: true, form: html`<form class="form" method="post" action="/system/flags/clear">${csrf}<input type="hidden" name="flag" value="${flag.id}">${reasonField(`clear-${flag.id}`, { public: Boolean(flag.account_ref) })}<button class="btn danger" type="submit">Remove flag</button></form>` },
            ], `More for ${flagName(flag.flag)}`)
          : html``,
      ]), 'No feature is turned on or off: each follows the deployment.', { hrefs: data.mayAct ? data.flags.flags.map((flag) => `/system?panel=flag&flag=${flag.id}#flags`) : [] })}
      ${section('Changes', table('Feature flag changes', ['When', 'Who', 'Feature', 'Change', 'Why'], data.flags.history.map((event) => [
        html`${when(event.occurred_at)}`,
        html`${data.names.get(event.staff_ref) ?? event.staff_ref}`,
        html`${flagName(event.metadata.flag ?? '')}<span class="sub">${event.account_ref ? (event.account_name || event.account_display || event.account_ref) : `the ${event.metadata.plan ?? ''} plan`}</span>`,
        html`${onOff(event.metadata.from)} → ${event.action === 'flag.cleared' ? 'as configured' : onOff(event.metadata.to)}`,
        html`${event.reason ?? ''}`,
      ]), 'No changes yet.'), { level: 3 })}`, {
      id: 'flags',
      info: info('Feature flags', 'A feature turned on or off for a plan, or for one account, which outranks its plan. Nothing here turns on a feature the deployment has not configured.'),
      aside: data.mayAct ? html`<a class="btn sm" href="/system?panel=flag#flags">Set a flag</a>` : null,
    })}

    ${section('Configuration', facts(data.configuration.map((entry) => [entry.name, html`<span class="mono">${entry.value}</span>`])), { id: 'configuration', info: info('Configuration', 'What this console runs with. Secrets are never shown: only whether each is set.') })}`;
  return {
    body,
    pills: down.length
      ? pill(`${count(down.length)} down`, 'bad')
      : failingTotal > 0 ? pill('Maintenance failing', 'warn') : lateHours !== null ? pill('Maintenance late', 'warn') : pill('Operational', 'good'),
    drawer: flagDrawer,
  };
}
