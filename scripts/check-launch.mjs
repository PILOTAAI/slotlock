#!/usr/bin/env node
// Checks, from outside, that everything a launch depends on is live and agrees with the release:
// the site, the API and the dashboard; every registry at the package's version; the GitHub
// repository's topics, the status probe and open incidents; the blog's scheduled and due posts; and,
// given a read-only key, Stripe's live prices and webhook. It prints one line a check, `ok`, `WARN`
// or `FAIL`, and exits 1 when any check fails. launch-check.yml runs it on a schedule, so a failure
// reaches the owner as a failed run.
//   node scripts/check-launch.mjs
// Environment:
//   SLOTLOCK_CHECK_STRIPE_KEY  optional: a restricted live key with Read on Products, Prices and
//                              Webhook Endpoints, and nothing else. Without it, Stripe is skipped.
//   GITHUB_TOKEN               optional: raises GitHub's rate limit; the checks read public data
//   SLOTLOCK_CHECK_URLS        tests only: a JSON object replacing any base URL below
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// The version goes into every registry's URL: it must be a plain semantic version.
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`package.json's version is not a semantic version: ${JSON.stringify(version)}`);
  process.exit(2);
}
/** A post's slug, as post-format.ts allows it: the only file names that go into a URL. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OWNER = 'PILOTAAI';
const REPO = 'slotlock';
const URLS = {
  site: 'https://slotlock.pylota.io',
  api: 'https://slotlock-api.pylota.io',
  dashboard: 'https://app.slotlock.pylota.io',
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  crates: 'https://crates.io',
  nuget: 'https://api.nuget.org',
  goproxy: 'https://proxy.golang.org',
  maven: 'https://repo1.maven.org/maven2',
  mcp: 'https://registry.modelcontextprotocol.io',
  ghcr: 'https://ghcr.io',
  github: 'https://api.github.com',
  stripe: 'https://api.stripe.com',
  ...JSON.parse(process.env.SLOTLOCK_CHECK_URLS ?? '{}'),
};
/** The topics RFC 0005 (0.8) asks for, which scripts/configure-github.sh sets. */
const TOPICS = ['mcp-server', 'model-context-protocol', 'ai-agents', 'booking-api', 'scheduling-api'];
/** What the dashboard's Stripe webhook acts on (docs: "Dashboard on Cloudflare Workers"; RFC 0006, M4). */
const STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
/** The paid plans' prices, in cents, as the site states them (site/src/data, facts.plans). */
const PRICES = [
  ['Developer monthly', 1000, 'month'],
  ['Developer yearly', 10000, 'year'],
  ['Team monthly', 4000, 'month'],
  ['Team yearly', 40000, 'year'],
];

const results = [];
const record = (state, area, detail) => results.push({ state, area, detail });
const ok = (area, detail) => record('ok', area, detail);
const warn = (area, detail) => record('WARN', area, detail);
const fail = (area, detail) => record('FAIL', area, detail);

async function request(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'manual',
    ...options,
    headers: { 'user-agent': 'slotlock-launch-check (+https://github.com/PILOTAAI/slotlock)', ...options.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** Runs one check; a network error or a thrown message fails it with that reason. */
async function check(area, run) {
  try {
    await run();
  } catch (error) {
    fail(area, error instanceof Error ? error.message : String(error));
  }
}

const expectStatus = async (area, url, wanted = 200, options = {}) => {
  const { status } = await request(url, options);
  if (status === wanted) ok(area, `${url} answers ${status}`);
  else fail(area, `${url} answers ${status}, not ${wanted}`);
};

// ---------- The service ----------

for (const path of ['/', '/pricing/', '/docs/quickstart/', '/blog/', '/sitemap-index.xml']) {
  await check('site', () => expectStatus('site', `${URLS.site}${path}`));
}
await check('api', async () => {
  const { status, json } = await request(`${URLS.api}/healthz`);
  if (status !== 200 || json?.status !== 'ready') throw new Error(`/healthz answers ${status} ${json?.status ?? ''}`.trim());
  ok('api', `/healthz is ready, on ${json.version}`);
  if (json.version !== version) {
    warn('api', `Slotlock Cloud runs ${json.version}; the latest release is ${version} (deploy it when it is due)`);
  }
});
await check('api', () => expectStatus('api', `${URLS.api}/.well-known/agent-card.json`));
await check('api', () => expectStatus('api', `${URLS.api}/openapi.json`));
await check('api', async () => {
  // MCP without a key must be refused: a 200 would mean the endpoint is open to anyone.
  const { status } = await request(`${URLS.api}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (status === 401) ok('api', '/mcp refuses a call without a key (401)');
  else fail('api', `/mcp answers ${status} to a call without a key, not 401`);
});
await check('dashboard', () => expectStatus('dashboard', `${URLS.dashboard}/dashboard`));

// ---------- The registries, at the package's version ----------

const atVersion = (area, found) => {
  if (found === version) ok(area, `has ${version}`);
  else fail(area, `has ${found ?? 'nothing'}, not ${version}`);
};
await check('npm', async () => atVersion('npm', (await request(`${URLS.npm}/slotlock`)).json?.['dist-tags']?.latest));
await check('PyPI', async () => atVersion('PyPI', (await request(`${URLS.pypi}/pypi/slotlock/json`)).json?.info?.version));
await check('crates.io', async () =>
  atVersion('crates.io', (await request(`${URLS.crates}/api/v1/crates/slotlock`)).json?.crate?.max_version),
);
await check('NuGet', async () => {
  const versions = (await request(`${URLS.nuget}/v3-flatcontainer/slotlock.client/index.json`)).json?.versions ?? [];
  atVersion('NuGet', versions.includes(version) ? version : versions.at(-1));
});
await check('Go', async () => {
  // The module proxy spells capitals as ! and the lower-case letter.
  const module = `github.com/${OWNER}/${REPO}/clients/go`.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
  const { status } = await request(`${URLS.goproxy}/${module}/@v/v${version}.info`);
  atVersion('Go', status === 200 ? version : undefined);
});
await check('Maven Central', async () => {
  const { status } = await request(`${URLS.maven}/io/pylota/slotlock/${version}/slotlock-${version}.pom`);
  if (status === 200) ok('Maven Central', `has ${version}`);
  else fail('Maven Central', `has no ${version} (${status}): publish its deployment in the Central Portal, or release the next version`);
});
await check('MCP Registry', async () => {
  const { json } = await request(`${URLS.mcp}/v0/servers?search=${REPO}&version=latest`);
  const entry = (json?.servers ?? []).find((item) => item.server?.name === `io.github.${OWNER}/${REPO}`);
  const status = entry?._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (entry && status !== 'active') fail('MCP Registry', `the entry is ${status}`);
  else atVersion('MCP Registry', entry?.server?.version);
});
await check('ghcr.io', async () => {
  const image = `${OWNER.toLowerCase()}/${REPO}`;
  const token = (await request(`${URLS.ghcr}/token?scope=repository:${image}:pull`)).json?.token;
  const { status } = await request(`${URLS.ghcr}/v2/${image}/manifests/${version}`, {
    method: 'HEAD',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  atVersion('ghcr.io', status === 200 ? version : undefined);
});

// ---------- GitHub ----------

/** A public GitHub read: with GITHUB_TOKEN when it works, without it when GitHub refuses it. */
async function github(path) {
  const url = `${URLS.github}/repos/${OWNER}/${REPO}${path}`;
  const accept = { accept: 'application/vnd.github+json' };
  let answer = process.env.GITHUB_TOKEN
    ? await request(url, { headers: { ...accept, authorization: `Bearer ${process.env.GITHUB_TOKEN}` } })
    : undefined;
  if (!answer || answer.status === 401) answer = await request(url, { headers: accept });
  if (answer.status !== 200) throw new Error(`GitHub answered ${answer.status} for ${path}: ${answer.json?.message ?? ''}`);
  return answer;
}
await check('GitHub', async () => {
  const names = (await github('/topics')).json?.names ?? [];
  const missing = TOPICS.filter((topic) => !names.includes(topic));
  if (missing.length === 0) ok('GitHub', 'the repository has its search topics');
  else fail('GitHub', `topics missing: ${missing.join(', ')} (run scripts/configure-github.sh)`);
});
await check('status', async () => {
  const run = (await github('/actions/workflows/status.yml/runs?per_page=1&status=completed')).json?.workflow_runs?.[0];
  if (!run) throw new Error('the status probe has never run');
  const jobs = (await github(`/actions/runs/${run.id}/jobs`)).json?.jobs ?? [];
  const age = (Date.now() - Date.parse(run.created_at)) / 60_000;
  // GitHub runs this schedule hours late (docs/hosted/status.md): the status Worker and UptimeRobot
  // watch every five minutes, and this workflow is their backup. Off is a failure; late is a warning.
  if (jobs.every((job) => job.conclusion === 'skipped')) fail('status', 'the status probe is off: set SLOTLOCK_STATUS_PROBE to on');
  else if (age > 12 * 60) warn('status', `the GitHub status probe last ran ${Math.round(age / 60)} hours ago`);
  else ok('status', `the GitHub status probe ran ${Math.round(age)} minutes ago (${run.conclusion})`);
});
await check('status', async () => {
  const open = (await github('/issues?labels=status&state=open&per_page=10')).json ?? [];
  if (open.length === 0) ok('status', 'no open incident');
  else warn('status', `open incidents: ${open.map((issue) => `#${issue.number} ${issue.title}`).join('; ')}`);
});

// ---------- The blog's scheduled posts ----------

const blog = join(root, 'site', 'content', 'blog');
for (const file of readdirSync(blog).filter((name) => name.endsWith('.md')).sort()) {
  const slug = file.slice(0, -'.md'.length);
  if (!SLUG.test(slug)) {
    fail('blog', `content/blog/${file} is not named as a post slug`);
    continue;
  }
  const text = readFileSync(join(blog, file), 'utf8');
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const status = /^status:[ \t]*(\S+)/m.exec(head)?.[1];
  const publishAt = /^publishAt:[ \t]*(\S+)/m.exec(head)?.[1];
  if (status !== 'published' || !publishAt) continue;
  if (Date.parse(publishAt) > Date.now()) {
    ok('blog', `${slug} is scheduled for ${publishAt}`);
    continue;
  }
  await check('blog', () => expectStatus('blog', `${URLS.site}/blog/${slug}/`));
}

// ---------- Stripe, live mode ----------

const stripeKey = process.env.SLOTLOCK_CHECK_STRIPE_KEY;
if (!stripeKey) {
  warn('Stripe', 'skipped: set SLOTLOCK_CHECK_STRIPE_KEY (a restricted live key, Read on Products, Prices and Webhook Endpoints)');
} else {
  const stripe = (path) => request(`${URLS.stripe}/v1/${path}`, { headers: { authorization: `Bearer ${stripeKey}` } });
  await check('Stripe', async () => {
    const { status, json } = await stripe('prices?active=true&limit=100');
    if (status !== 200) throw new Error(`prices answer ${status}: ${json?.error?.message ?? ''}`);
    const prices = json.data ?? [];
    if (prices.some((price) => price.livemode === false)) {
      fail('Stripe', 'the key is a test-mode key: the check needs a live one');
      return;
    }
    for (const [name, amount, interval] of PRICES) {
      const found = prices.find(
        (price) => price.unit_amount === amount && price.currency === 'usd' && price.recurring?.interval === interval,
      );
      if (found) ok('Stripe', `${name}: ${found.id}`);
      else fail('Stripe', `no active live price for ${name} (${amount / 100} USD a ${interval})`);
    }
  });
  await check('Stripe', async () => {
    const { status, json } = await stripe('webhook_endpoints?limit=100');
    if (status !== 200) throw new Error(`webhook endpoints answer ${status}: ${json?.error?.message ?? ''}`);
    const url = `${URLS.dashboard}/stripe/webhook`;
    const endpoint = (json.data ?? []).find((item) => item.url === url && item.status === 'enabled');
    if (!endpoint) {
      fail('Stripe', `no enabled webhook endpoint at ${url}`);
      return;
    }
    const events = endpoint.enabled_events ?? [];
    const missing = events.includes('*') ? [] : STRIPE_EVENTS.filter((event) => !events.includes(event));
    if (missing.length === 0) ok('Stripe', `the webhook at ${url} gets every event it needs`);
    else fail('Stripe', `the webhook at ${url} does not get: ${missing.join(', ')}`);
  });
}

// ---------- Report ----------

for (const { state, area, detail } of results) console.log(`${state.padEnd(4)} ${area}: ${detail}`);
const failed = results.filter((result) => result.state === 'FAIL').length;
const warned = results.filter((result) => result.state === 'WARN').length;
console.log(`\n${results.length} checks against ${version}: ${failed} failed, ${warned} warnings.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  // Details carry text from the network (an issue's title, a registry's answer): one line, at most
  // 300 characters, with no Markdown that could add a link, an image or HTML to the summary.
  const cell = (text) =>
    text
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .slice(0, 300)
      .replace(/[\\|<>[\]()!`*_]/g, (character) => `\\${character}`);
  const rows = results.map(({ state, area, detail }) => `| ${state} | ${cell(area)} | ${cell(detail)} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [`### Launch check against ${version}`, '', '| | Area | Detail |', '| --- | --- | --- |', ...rows, ''].join('\n'),
  );
}
process.exit(failed > 0 ? 1 : 0);
