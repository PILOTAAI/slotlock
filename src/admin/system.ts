// Phase 6 of the admin console (RFC 0006, M9 to M11): the pages for the site's search and visits,
// for announcements, service notices and the status page, and for the system: hosts, deploys,
// maintenance, webhooks, feature flags and configuration. Rendering only: app.ts reads the data
// through the admin functions and the providers, checks the role and handles the forms.
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
import { type Html, bars, count, html, pageHead, pill, stats, table, when } from './ui.js';

/** A provider part of a page: not connected, could not be read, or what it said. */
export type SlotlockProviderRead<T> = { state: 'off' } | { state: 'failed' } | { state: 'ok'; value: T };

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
const reasonField = (id: string, hint: string) =>
  html`<label for="${id}">Reason <span class="hint">${hint}</span></label><input id="${id}" name="reason" required maxlength="200" autocomplete="off">`;
/** A path on the site, from a full URL a search engine gave; the URL itself when it is another site's. */
const pathOf = (url: string, siteUrl: string) => (url.startsWith(siteUrl) ? url.slice(siteUrl.length) || '/' : url);

function providerPart<T>(name: string, read: SlotlockProviderRead<T>, off: Html, render: (value: T) => Html): Html {
  if (read.state === 'off') return html`<p class="empty">${name} is not connected. ${off}</p>`;
  if (read.state === 'failed') return html`<p class="empty">${name} could not be read just now. It is tried again on the next visit to this page.</p>`;
  return render(read.value);
}

function searchRows(caption: string, first: string, rows: readonly SlotlockSearchRow[], label: (row: SlotlockSearchRow) => Html, empty: string): Html {
  return table(caption, [first, 'Clicks', 'Impressions', 'Click-through', 'Position'], rows.map((row) => [
    label(row),
    html`${count(row.clicks)}`,
    html`${count(row.impressions)}`,
    html`${percent(row.ctr)}`,
    html`${position(row.position)}`,
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
}

export function slotlockSitePage(data: SlotlockSitePageData): Html {
  const site = data.siteUrl.replace(/\/$/, '');
  const pageLink = (row: SlotlockSearchRow) => {
    const path = pathOf(row.key, site);
    return path.startsWith('/') ? html`<a href="${site}${path}" rel="noreferrer">${path}</a>` : html`${path}`;
  };
  const read = (at: number) => html`<p class="fine">Read ${when(new Date(at))}, kept for an hour.</p>`;
  const googlePart = providerPart('Search Console', data.google,
    html`Add a service account to the property as a restricted user, and set <code>SLOTLOCK_ADMIN_SEARCH_CONSOLE_KEY</code> and <code>SLOTLOCK_ADMIN_SEARCH_CONSOLE_PROPERTY</code>.`,
    (report) => {
      const posts = report.pages.filter((row) => /^\/blog\/[a-z0-9-]+\/?$/.test(pathOf(row.key, site)));
      const low = slotlockLowClickPages(report.pages);
      return html`
        ${stats([
          { label: 'Clicks', value: count(report.clicks), note: `${report.from} to ${report.to}` },
          { label: 'Impressions', value: count(report.impressions) },
          { label: 'Click-through', value: report.impressions > 0 ? percent(report.clicks / report.impressions) : '–' },
        ])}
        <h3>Top queries</h3>
        ${searchRows('Search Console queries', 'Query', report.queries.slice(0, 15), (row) => html`${row.key}`, 'No queries in this period.')}
        <h3>Top pages</h3>
        ${searchRows('Search Console pages', 'Page', report.pages.slice(0, 15), pageLink, 'No pages in this period.')}
        <h3 id="titles">Worth a new title</h3>
        <p class="fine">Seen at least 100 times and clicked under 2% of the time (RFC 0005, Phase 5). A clearer title or description may earn the click.</p>
        ${searchRows('Pages worth a new title', 'Page', low, pageLink, 'No page is seen often and clicked rarely.')}
        <h3 id="posts">Blog posts</h3>
        ${searchRows('Blog posts in search', 'Post', posts, pageLink, 'No blog post was seen in Google results in this period.')}
        ${report.sitemaps.length
          ? html`<h3>Sitemaps</h3>${table('Sitemaps', ['Sitemap', 'Pages', 'Last read', 'Errors', 'Warnings'], report.sitemaps.map((entry) => [
              html`<span class="mono">${entry.path}</span>`,
              html`${count(entry.submitted)}`,
              html`${when(entry.lastDownloaded)}`,
              entry.errors > 0 ? pill(String(entry.errors), 'bad') : html`0`,
              entry.warnings > 0 ? pill(String(entry.warnings), 'warn') : html`0`,
            ]), 'No sitemaps.')}`
          : ''}
        ${read(report.readAt)}`;
    });
  const bingPart = providerPart('Bing Webmaster Tools', data.bing,
    html`Set <code>SLOTLOCK_ADMIN_BING_KEY</code> to an API key from Bing Webmaster Tools' settings, and <code>SLOTLOCK_ADMIN_BING_SITE</code>.`,
    (report) => html`
      ${stats([
        { label: 'Clicks', value: count(report.clicks), note: `${report.from} to ${report.to}, by week` },
        { label: 'Impressions', value: count(report.impressions) },
        { label: 'Click-through', value: report.impressions > 0 ? percent(report.clicks / report.impressions) : '–' },
      ])}
      <h3>Top queries</h3>
      ${searchRows('Bing queries', 'Query', report.queries.slice(0, 15), (row) => html`${row.key}`, 'No queries in this period.')}
      <h3>Top pages</h3>
      ${searchRows('Bing pages', 'Page', report.pages.slice(0, 15), pageLink, 'No pages in this period.')}
      ${read(report.readAt)}`);
  const visitsPart = providerPart('Cloudflare Web Analytics', data.visits,
    html`Set <code>SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN</code> (Account Analytics Read), <code>SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT</code> and <code>SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE</code> (the site tag).`,
    (report) => html`
      ${stats([{ label: 'Page loads', value: count(report.pageLoads), note: `${report.from} to ${report.to}` }])}
      ${bars('Page loads', report.days, 28)}
      <div class="grid-2">
        <div>
          <h3>Top pages</h3>
          ${table('Top pages by page loads', ['Page', 'Page loads'], report.pages.map((row) => [
            html`<a href="${site}${row.path}" rel="noreferrer">${row.path}</a>`, html`${count(row.count)}`,
          ]), 'No page loads in this period.')}
        </div>
        <div>
          <h3>Referrers</h3>
          ${report.referrers === null
            ? html`<p class="empty">Cloudflare did not give referrers just now.</p>`
            : table('Referrers by page loads', ['From', 'Page loads'], report.referrers.map((row) => [
                html`${row.host}`, html`${count(row.count)}`,
              ]), 'No visits came from another site in this period.')}
        </div>
      </div>
      <p class="fine">Cloudflare Web Analytics counts without cookies and keeps no visitor. Read ${when(new Date(report.readAt))}, kept for an hour.</p>`);
  const deployPart = providerPart('GitHub', data.deploys,
    html`The site's deploys come from the Slotlock CMS GitHub App, with Actions (read).`,
    (runs) => html`${runsTable('Site workflow runs on main', runs, 'No runs of the site workflow on main yet.')}
      <p class="fine">Each run builds the site and runs its copy lint and SEO check before it deploys: a failed run deployed nothing.</p>`);
  return html`
    ${pageHead('Slotlock Cloud', 'Site and search', 'How the site does in search and with visitors over the last 28 days, and its last deploys. Counts only, never a visitor.')}
    <h2>Google</h2>
    ${googlePart}
    <h2>Bing</h2>
    ${bingPart}
    <h2>Visitors</h2>
    ${visitsPart}
    <h2 id="deploys">Deploys</h2>
    ${deployPart}`;
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
}

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

const audienceText = (row: SlotlockAnnouncementRow, accountHref: (ref: string) => string): Html =>
  row.audience === 'everyone'
    ? html`Every account`
    : row.audience === 'plan'
      ? html`The ${row.plan ?? ''} plan`
      : html`<a href="${accountHref(row.account_ref ?? '')}" class="mono">${row.account_ref ?? ''}</a><span class="sub">A service notice</span>`;

/** A datetime-local value, in UTC as the form says. */
const minuteInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);

export function slotlockCommunicationsPage(data: SlotlockCommunicationsPageData, accountHref: (ref: string) => string): Html {
  const csrf = hidden(data.csrf);
  const rows = data.announcements.map((row) => [
    html`<strong>${SLOTLOCK_ANNOUNCEMENT_KIND_NAMES[row.kind]}.</strong> ${row.message}${row.link ? html`<span class="sub"><a href="${row.link}" rel="noreferrer">${row.link}</a></span>` : ''}`,
    audienceText(row, accountHref),
    html`${when(row.starts_at)}<span class="sub">to ${when(row.ends_at)}</span>`,
    html`${STATE_PILLS[row.state]}<span class="sub">${data.names.get(row.created_by) ?? row.created_by}</span>`,
    data.mayAct && (row.state === 'live' || row.state === 'scheduled')
      ? html`<form class="inline" method="post" action="/communications/end">${csrf}<input type="hidden" name="announcement" value="${row.id}"><button class="btn" type="submit">End now</button></form>`
      : html``,
  ]);
  const kindOptions = SLOTLOCK_ANNOUNCEMENT_KINDS.map((kind) => html`<option value="${kind}">${SLOTLOCK_ANNOUNCEMENT_KIND_NAMES[kind]}</option>`);
  const planOptions = SLOTLOCK_STAFF_PLANS.map((plan) => html`<option value="${plan}">${plan}</option>`);
  const writeForm = data.mayAct
    ? html`<section class="panel" aria-labelledby="write">
        <h2 id="write">Write an announcement</h2>
        <p class="fine">One line above every page of the dashboard while it runs, at most ${SLOTLOCK_ANNOUNCEMENT_MAX_DAYS} days. A notice to one account is a service notice: its audit log says Slotlock staff sent it. Never marketing.</p>
        <form class="form" method="post" action="/communications">${csrf}
          <label for="announce-kind">About</label><select id="announce-kind" name="kind">${kindOptions}</select>
          <label for="announce-audience">For</label>
          <select id="announce-audience" name="audience">
            <option value="everyone"${data.account ? '' : html` selected`}>Every account</option>
            <option value="plan">The accounts on a plan</option>
            <option value="account"${data.account ? html` selected` : ''}>One account (a service notice)</option>
          </select>
          <label for="announce-plan">Plan <span class="hint">for a plan's accounts</span></label><select id="announce-plan" name="plan"><option value="">None</option>${planOptions}</select>
          <label for="announce-account">Account <span class="hint">for one account: its reference</span></label><input id="announce-account" name="account" value="${data.account ?? ''}" maxlength="500" autocomplete="off" spellcheck="false">
          <label for="announce-message">Message <span class="hint">one line, up to ${SLOTLOCK_ANNOUNCEMENT_MAX} characters; the customer reads it</span></label><input id="announce-message" name="message" required maxlength="${SLOTLOCK_ANNOUNCEMENT_MAX}" autocomplete="off">
          <label for="announce-link">Link <span class="hint">optional; https, such as the incident on the status page</span></label><input id="announce-link" name="link" type="url" maxlength="300" placeholder="https://" autocomplete="off">
          <label for="announce-starts">From <span class="hint">UTC; empty for now</span></label><input id="announce-starts" name="starts" type="datetime-local">
          <label for="announce-ends">Until <span class="hint">UTC</span></label><input id="announce-ends" name="ends" type="datetime-local" required value="${minuteInput(data.now + 86_400_000)}">
          <button class="btn primary" type="submit">Announce</button>
        </form>
      </section>`
    : '';
  const incidents = providerPart('The status page', data.incidents,
    html`It needs the Slotlock CMS GitHub App with Issues (read and write).`,
    ({ open, closed }) => html`
      ${open.length === 0
        ? html`<p class="empty">No open incident. The status page shows hosted Slotlock as up.</p>`
        : html`<ul class="panel incidents">${open.map((issue) => html`<li>
            <p><a href="${issue.url}" rel="noreferrer">#${issue.number} ${issue.title}</a> <span class="sub">Opened ${when(issue.createdAt)}, ${count(issue.comments)} ${issue.comments === 1 ? 'update' : 'updates'}</span></p>
            ${data.mayAct
              ? html`<form class="form" method="post" action="/communications/status/update">${csrf}<input type="hidden" name="issue" value="${issue.number}">
                  <label for="update-${issue.number}">Update <span class="hint">public, on the status page</span></label><textarea id="update-${issue.number}" name="body" rows="2" maxlength="2000" required></textarea>
                  <label class="check"><input type="checkbox" name="close" value="1"> Resolved: close the incident with this update</label>
                  <button class="btn" type="submit">Post the update</button></form>`
              : ''}
          </li>`)}</ul>`}
      ${data.mayAct
        ? html`<details class="act"><summary class="btn">Open an incident</summary>
            <form class="pop form" method="post" action="/communications/status">${csrf}
              <label for="incident-title">Title <span class="hint">public: what is affected</span></label><input id="incident-title" name="title" required maxlength="120" autocomplete="off">
              <label for="incident-body">What is happening <span class="hint">public</span></label><textarea id="incident-body" name="body" rows="3" maxlength="2000" required></textarea>
              <button class="btn danger" type="submit">Open the incident</button></form></details>`
        : ''}
      ${closed.length
        ? html`<h3>Recently resolved</h3>${table('Resolved incidents', ['Incident', 'Opened', 'Resolved'], closed.map((issue) => [
            html`<a href="${issue.url}" rel="noreferrer">#${issue.number} ${issue.title}</a>`, html`${when(issue.createdAt)}`, html`${when(issue.closedAt)}`,
          ]), '')}`
        : ''}
      <p class="fine">Incidents are issues labelled <code>status</code> (docs/hosted/status.md); the probe opens and closes its own. Read from GitHub as the page opens.</p>`);
  return html`
    ${pageHead('Slotlock Cloud', 'Communications', 'What customers are told: announcements and service notices on their dashboard, and incidents on the status page. No marketing email is sent from here.')}
    <h2>Announcements</h2>
    ${table('Announcements', ['Message', 'For', 'Runs', 'State', 'Action'], rows, data.endedToo ? 'No announcements yet.' : 'Nothing is showing or scheduled.')}
    <p class="pager">${data.endedToo ? html`<a href="/communications">Hide ended ones</a>` : html`<a href="/communications?ended=1">Show ended ones too</a>`}</p>
    ${writeForm}
    <h2 id="status">Status page</h2>
    ${incidents}`;
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
    code: string | null; message: string | null;
  }[];
  failing_total: number;
  jobs: Record<string, { finished_at: string; attention: boolean }>;
}

export interface SlotlockFlagsData {
  flags: { id: string; flag: SlotlockFeatureFlag; plan: string | null; account_ref: string | null; enabled: boolean; reason: string; set_by: string; set_at: string }[];
  history: { occurred_at: string; staff_ref: string; action: string; account_ref: string | null; reason: string | null; metadata: { flag?: string; plan?: string | null; from?: boolean | null; to?: boolean | null } }[];
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
}

const onOff = (value: boolean | null | undefined) => (value === true ? 'on' : value === false ? 'off' : 'as configured');

export function slotlockSystemPage(data: SlotlockSystemPageData, accountHref: (ref: string) => string): Html {
  const csrf = hidden(data.csrf);
  const { system } = data;
  const last = system.rounds[0];
  const hourSince = last ? data.now - new Date(last.finished_at).getTime() : null;
  const flagOptions = SLOTLOCK_FEATURE_FLAGS.map((flag) => html`<option value="${flag}">${SLOTLOCK_FEATURE_FLAG_NAMES[flag].name}</option>`);
  const planOptions = SLOTLOCK_STAFF_PLANS.map((plan) => html`<option value="${plan}">${plan}</option>`);
  return html`
    ${pageHead('Slotlock Cloud', 'System', 'Whether each part of the service answers, what last deployed, how maintenance and webhooks are doing, and the features turned on or off.')}
    <h2>Hosts</h2>
    ${table('Hosts', ['Host', 'State', 'Version', 'Answered in'], data.hosts.map((host) => [
      html`${host.name}<span class="sub mono">${host.url}</span>`,
      host.up ? pill('Up', 'good') : html`${pill('Down', 'bad')}<span class="sub">${host.answer}</span>`,
      html`${host.version ?? '–'}`,
      html`${count(host.ms)} ms`,
    ]), 'No hosts to check.')}
    <p class="fine">Asked as this page opened, with a five-second limit. The public status page probes them from GitHub every ten minutes.</p>

    <h2 id="maintenance">Maintenance</h2>
    ${stats([
      { label: 'Accounts failing', value: count(system.failing_total), note: 'A pass failed and none has run since' },
      { label: 'Last hour recorded', value: last ? `${when(last.finished_at).slice(11)} UTC` : 'Never', note: last ? `${when(last.finished_at).slice(0, 10)}: ${count(last.summary.passes ?? 0)} passes, ${count(last.summary.failed ?? 0)} failed` : 'No server has recorded maintenance' },
    ])}
    ${hourSince !== null && hourSince > 3 * 3_600_000 ? html`<p class="notice warn">No server has recorded maintenance for ${Math.floor(hourSince / 3_600_000)} hours. Check that <code>slotlock serve</code> is running.</p>` : ''}
    <h3>Accounts whose maintenance is failing</h3>
    ${table('Accounts whose maintenance is failing', ['Account', 'Failing since', 'Last failed', 'Failures', 'Error'], system.failing.map((row) => [
      html`<a href="${accountHref(row.account_ref)}" class="mono">${row.account_ref}</a>`,
      html`${when(row.first_failed_at)}`,
      html`${when(row.last_failed_at)}`,
      html`${count(row.failures)}`,
      html`<code>${row.error}${row.code ? ` ${row.code}` : ''}</code>${row.message ? html`<span class="sub">${row.message}</span>` : ''}`,
    ]), 'Every account’s last pass ran.')}
    <p class="fine">The error's class, code and first line, with anything in quotes taken out: never the account's data. Cleared when a pass runs; kept ${SLOTLOCK_MAINTENANCE_FAILURE_DAYS} days otherwise.</p>
    <h3>The last day, by server hour</h3>
    ${table('Maintenance hours', ['Hour to', 'Passes', 'Failed', 'Extended', 'Pruned', 'Released'], system.rounds.map((round) => [
      html`${when(round.finished_at)}<span class="sub">from ${when(round.started_at)}</span>`,
      html`${count(round.summary.passes ?? 0)}`,
      round.attention ? pill(count(round.summary.failed ?? 0), 'bad') : html`0`,
      html`${count(round.summary.extended ?? 0)}`,
      html`${count(round.summary.pruned ?? 0)}`,
      html`${count((round.summary.noShows ?? 0) + (round.summary.approvalsExpired ?? 0))}`,
    ]), 'No hour recorded yet.')}
    <h3>Billing jobs</h3>
    ${table('Billing jobs', ['Job', 'Last run', 'State'], ['billing_daily', 'overage_report'].map((job) => [
      html`<code>${job.replace('_', ' ')}</code>`,
      html`${when(system.jobs[job]?.finished_at)}`,
      system.jobs[job] ? (system.jobs[job]?.attention ? pill('Needs attention', 'warn') : pill('Clean', 'good')) : pill('Never run', 'muted'),
    ]), '')}

    <h2 id="webhooks">Webhooks</h2>
    ${stats([
      { label: 'Endpoints', value: count(system.webhooks.endpoints), note: `${count(system.webhooks.accounts)} accounts with webhooks${system.webhooks.capped ? ', the first counted' : ''}` },
      { label: 'Failing', value: count(system.webhooks.failing), note: system.webhooks.failing ? `in ${count(system.webhooks.failing_accounts)} accounts, since ${when(system.webhooks.failing_since)}` : 'Every endpoint answered its last delivery' },
      { label: 'Turned off', value: count(system.webhooks.disabled), note: 'By their owner, or after failing for days' },
    ])}
    <p class="fine">Counts only: no endpoint address and no payload. Each account's own page lists its endpoints.</p>

    <h2 id="deploys">Deploys</h2>
    ${providerPart('GitHub', data.deploys, html`Deploys come from the Slotlock CMS GitHub App, with Actions (read).`, (workflows) => html`${workflows.map(
      (workflow) => html`<h3>${workflow.label}</h3>${runsTable(`${workflow.label} runs on main`, workflow.runs, 'No runs on main yet.')}`,
    )}`)}

    <h2 id="flags">Feature flags</h2>
    <p class="fine">A feature turned on or off for a plan, or for one account, which outranks its plan. Nothing here turns on a feature the deployment has not configured.</p>
    ${table('Feature flags', ['Feature', 'For', 'Set to', 'Why', 'Action'], data.flags.flags.map((flag) => [
      html`${SLOTLOCK_FEATURE_FLAG_NAMES[flag.flag]?.name ?? flag.flag}`,
      flag.account_ref ? html`<a href="${accountHref(flag.account_ref)}" class="mono">${flag.account_ref}</a>` : html`The ${flag.plan ?? ''} plan`,
      flag.enabled ? pill('On', 'good') : pill('Off', 'warn'),
      html`${flag.reason}<span class="sub">${data.names.get(flag.set_by) ?? flag.set_by}, ${when(flag.set_at)}</span>`,
      data.mayAct
        ? html`<details class="act"><summary class="btn">Remove</summary><form class="pop form" method="post" action="/system/flags/clear">${csrf}<input type="hidden" name="flag" value="${flag.id}">${reasonField(`clear-${flag.id}`, flag.account_ref ? 'the customer sees it in their audit log' : 'for the staff log')}<button class="btn" type="submit">Remove the flag</button></form></details>`
        : html``,
    ]), 'No feature is turned on or off: each follows the deployment.')}
    ${data.mayAct
      ? html`<section class="panel" aria-labelledby="set-flag"><h3 id="set-flag">Turn a feature on or off</h3>
          <form class="form" method="post" action="/system/flags">${csrf}
            <label for="flag-name">Feature</label><select id="flag-name" name="flag">${flagOptions}</select>
            <label for="flag-plan">For a plan</label><select id="flag-plan" name="plan"><option value="">None: for one account</option>${planOptions}</select>
            <label for="flag-account">Or for one account <span class="hint">its reference</span></label><input id="flag-account" name="account" maxlength="500" autocomplete="off" spellcheck="false">
            <label for="flag-state">Set to</label><select id="flag-state" name="enabled"><option value="0">Off</option><option value="1">On</option></select>
            ${reasonField('flag-reason', 'an account sees it in its audit log')}
            <ul class="fine">${SLOTLOCK_FEATURE_FLAGS.map((flag) => html`<li><strong>${SLOTLOCK_FEATURE_FLAG_NAMES[flag].name}</strong> off: ${SLOTLOCK_FEATURE_FLAG_NAMES[flag].off}</li>`)}</ul>
            <button class="btn primary" type="submit">Set the flag</button>
          </form></section>`
      : ''}
    <h3>Changes</h3>
    ${table('Feature flag changes', ['When', 'Who', 'Feature', 'Change', 'Why'], data.flags.history.map((event) => [
      html`${when(event.occurred_at)}`,
      html`${data.names.get(event.staff_ref) ?? event.staff_ref}`,
      html`${SLOTLOCK_FEATURE_FLAG_NAMES[(event.metadata.flag ?? '') as SlotlockFeatureFlag]?.name ?? event.metadata.flag ?? ''}<span class="sub">${event.account_ref ? event.account_ref : `the ${event.metadata.plan ?? ''} plan`}</span>`,
      html`${onOff(event.metadata.from)} → ${event.action === 'flag.cleared' ? 'as configured' : onOff(event.metadata.to)}`,
      html`${event.reason ?? ''}`,
    ]), 'No changes yet.')}

    <h2 id="configuration">Configuration</h2>
    ${table('Configuration', ['Setting', 'Value'], data.configuration.map((entry) => [html`${entry.name}`, html`<span class="mono">${entry.value}</span>`]), '')}
    <p class="fine">What this console runs with. Secrets are never shown: only whether each is set.</p>`;
}
