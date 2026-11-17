// Hosted Slotlock's status probe and post scheduler, as a Cloudflare Worker on a five-minute Cron
// Trigger. GitHub runs scheduled workflows late, often by hours: status.yml, set to every ten
// minutes, ran every 3.5 to 10.5 hours in November 2026, and scheduled-posts.yml likewise. Cloudflare
// runs Cron Triggers on time. Each run:
//   1. checks the API (/healthz must answer 200 with "status":"ready"), the dashboard and the site,
//      three times 20 seconds apart before calling a part down, and keeps one open issue labelled
//      `status` for each part that is down, as scripts/status-probe.sh does (docs/hosted/status.md).
//      Both use the same titles, so either one opens or closes the same issue;
//   2. starts the Site workflow on main when a blog post's publishAt has passed (within two days) and
//      the live site does not serve it yet, as scripts/publish-due-posts.mjs does, unless a Site run
//      is already queued or running, or started in the last fifteen minutes;
//   3. pings an UptimeRobot heartbeat, so the owner hears when this Worker stops.
// It holds a fine-grained GitHub token for this repository alone (Issues read and write, Actions read
// and write) and the heartbeat URL, both as Worker secrets set by status-worker.yml. Without the token
// it only logs what it finds.
export interface SlotlockStatusEnv {
  /** `owner/repo` whose issues hold the status and whose Site workflow deploys the site. */
  SLOTLOCK_STATUS_REPOSITORY?: string;
  SLOTLOCK_STATUS_API?: string;
  SLOTLOCK_STATUS_DASHBOARD?: string;
  SLOTLOCK_STATUS_SITE?: string;
  /** Seconds between the three checks of a part (20). */
  SLOTLOCK_STATUS_RETRY_SECONDS?: string;
  /** A secret: the GitHub token. */
  SLOTLOCK_STATUS_GITHUB_TOKEN?: string;
  /** A secret: the UptimeRobot heartbeat URL. */
  SLOTLOCK_STATUS_HEARTBEAT_URL?: string;
  /** Tests only: GitHub's API. */
  SLOTLOCK_STATUS_GITHUB_API?: string;
}

interface Part {
  name: 'api' | 'dashboard' | 'site';
  url: string;
  title: string;
}

export interface SlotlockStatusReport {
  parts: { name: string; up: boolean; why?: string; issue?: string }[];
  posts: { due: string[]; missing: string[]; dispatched: boolean; skipped?: string };
  heartbeat: boolean;
  problems: string[];
}

const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLISH_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;
const POST_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const DISPATCH_QUIET_MS = 15 * 60 * 1000;
const USER_AGENT = 'slotlock-status (+https://github.com/PILOTAAI/slotlock)';

function settings(env: SlotlockStatusEnv) {
  const trim = (url: string) => url.replace(/\/+$/, '');
  return {
    repository: env.SLOTLOCK_STATUS_REPOSITORY ?? 'PILOTAAI/slotlock',
    api: trim(env.SLOTLOCK_STATUS_API ?? 'https://slotlock-api.pylota.io'),
    dashboard: trim(env.SLOTLOCK_STATUS_DASHBOARD ?? 'https://app.slotlock.pylota.io'),
    site: trim(env.SLOTLOCK_STATUS_SITE ?? 'https://slotlock.pylota.io'),
    retryMs: Math.max(0, Number(env.SLOTLOCK_STATUS_RETRY_SECONDS ?? '20')) * 1000,
    githubApi: trim(env.SLOTLOCK_STATUS_GITHUB_API ?? 'https://api.github.com'),
    token: env.SLOTLOCK_STATUS_GITHUB_TOKEN?.trim() || undefined,
    heartbeat: env.SLOTLOCK_STATUS_HEARTBEAT_URL?.trim() || undefined,
  };
}
type Settings = ReturnType<typeof settings>;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One check of a part: up, or why not, in words the issue can quote. */
async function probe(part: Part): Promise<{ up: boolean; why: string }> {
  let response: Response;
  try {
    response = await fetch(part.url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { up: false, why: `no answer: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { up: false, why: `HTTP ${response.status}` };
  }
  if (part.name !== 'api') {
    await response.body?.cancel();
    return { up: true, why: '' };
  }
  // serve answers 200 {"status":"ready",...} only while its database answers.
  const status = await response
    .json()
    .then((body) => (body as { status?: unknown }).status)
    .catch(() => undefined);
  if (status === 'ready') return { up: true, why: '' };
  return { up: false, why: `not ready: ${typeof status === 'string' ? status.slice(0, 100) : 'no status in the answer'}` };
}

async function github(config: Settings, method: string, path: string, body?: unknown, accept = 'application/vnd.github+json') {
  if (!config.token) throw new Error('no GitHub token');
  const response = await fetch(`${config.githubApi}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${config.token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new Error(`GitHub answered ${response.status} to ${method} ${path.split('?')[0]}: ${text}`);
  }
  return response;
}

/** Opens the part's issue when it is down and has none; closes it when it is up again. */
async function reconcile(config: Settings, part: Part, up: boolean, why: string, now: string): Promise<string | undefined> {
  const repo = `/repos/${config.repository}`;
  const issues = (await (await github(config, 'GET', `${repo}/issues?labels=status&state=open&per_page=100`)).json()) as {
    number: number;
    title: string;
    pull_request?: unknown;
  }[];
  const open = issues.find((issue) => !issue.pull_request && issue.title === part.title);
  if (up && open) {
    await github(config, 'POST', `${repo}/issues/${open.number}/comments`, { body: `Up again: ${part.url} answered at ${now}.` });
    await github(config, 'PATCH', `${repo}/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
    return `closed #${open.number}`;
  }
  if (!up && !open) {
    const created = (await (
      await github(config, 'POST', `${repo}/issues`, {
        title: part.title,
        labels: ['status'],
        body: `${part.url} failed three checks in a row from Cloudflare, the last at ${now}: ${why}.\n\nThis issue closes itself when it answers again. Self-hosted Slotlock is not affected.`,
      })
    ).json()) as { number: number };
    return `opened #${created.number}`;
  }
  return undefined;
}

/** The frontmatter's `status` and `publishAt`, as post-format.ts writes them. */
function front(text: string): { status?: string; publishAt?: string } {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*(\\S+)`, 'm').exec(head)?.[1];
  const status = value('status');
  const publishAt = value('publishAt');
  return { ...(status ? { status } : {}), ...(publishAt ? { publishAt } : {}) };
}

/** Starts the Site workflow when a post is due and not live yet. */
async function publishDuePosts(config: Settings, nowMs: number): Promise<SlotlockStatusReport['posts']> {
  const repo = `/repos/${config.repository}`;
  const listing = (await (await github(config, 'GET', `${repo}/contents/site/content/blog?ref=main`)).json()) as {
    name: string;
    path: string;
    type: string;
  }[];
  const due: string[] = [];
  for (const file of listing) {
    if (file.type !== 'file' || !file.name.endsWith('.md')) continue;
    const slug = file.name.slice(0, -'.md'.length);
    if (!POST_SLUG.test(slug)) continue;
    const text = await (await github(config, 'GET', `${repo}/contents/${file.path}?ref=main`, undefined, 'application/vnd.github.raw')).text();
    const { status, publishAt } = front(text);
    if (status !== 'published' || !publishAt || !PUBLISH_AT.test(publishAt)) continue;
    const at = Date.parse(publishAt);
    if (at <= nowMs && nowMs - at <= POST_WINDOW_MS) due.push(slug);
  }
  const missing: string[] = [];
  for (const slug of due) {
    const response = await fetch(`${config.site}/blog/${slug}/`, {
      method: 'HEAD',
      headers: { 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (response?.status === 404) missing.push(slug);
  }
  if (missing.length === 0) return { due, missing, dispatched: false };
  const runs = (
    (await (await github(config, 'GET', `${repo}/actions/workflows/site.yml/runs?branch=main&per_page=5`)).json()) as {
      workflow_runs?: { status: string; created_at: string }[];
    }
  ).workflow_runs ?? [];
  const busy = runs.find(
    (run) => run.status !== 'completed' || nowMs - Date.parse(run.created_at) < DISPATCH_QUIET_MS,
  );
  if (busy) return { due, missing, dispatched: false, skipped: `a Site run is ${busy.status === 'completed' ? 'recent' : busy.status}` };
  await github(config, 'POST', `${repo}/actions/workflows/site.yml/dispatches`, { ref: 'main' });
  return { due, missing, dispatched: true };
}

/** One run: the probes, the posts and the heartbeat. Exported for tests. */
export async function runSlotlockStatus(env: SlotlockStatusEnv, nowMs = Date.now()): Promise<SlotlockStatusReport> {
  const config = settings(env);
  const parts: Part[] = [
    { name: 'api', url: `${config.api}/healthz`, title: 'Hosted Slotlock API is down' },
    { name: 'dashboard', url: `${config.dashboard}/dashboard`, title: 'Hosted Slotlock dashboard is down' },
    { name: 'site', url: `${config.site}/`, title: 'Slotlock site is down' },
  ];
  const report: SlotlockStatusReport = {
    parts: [],
    posts: { due: [], missing: [], dispatched: false },
    heartbeat: false,
    problems: [],
  };
  const results = await Promise.all(
    parts.map(async (part) => {
      let result = await probe(part);
      for (let tries = 1; !result.up && tries < 3; tries += 1) {
        await wait(config.retryMs);
        result = await probe(part);
      }
      return { part, ...result };
    }),
  );
  const now = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const { part, up, why } of results) {
    const entry: SlotlockStatusReport['parts'][number] = { name: part.name, up, ...(up ? {} : { why }) };
    if (config.token) {
      try {
        const issue = await reconcile(config, part, up, why, now);
        if (issue) entry.issue = issue;
      } catch (error) {
        report.problems.push(`${part.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    report.parts.push(entry);
  }
  if (config.token) {
    try {
      report.posts = await publishDuePosts(config, nowMs);
    } catch (error) {
      report.problems.push(`posts: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    report.problems.push('no GitHub token: issues and posts are left alone');
  }
  // The heartbeat says this Worker ran, whatever it found: UptimeRobot alerts when it stops.
  if (config.heartbeat) {
    const response = await fetch(config.heartbeat, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    );
    report.heartbeat = response?.ok ?? false;
    if (!report.heartbeat) report.problems.push(`heartbeat: ${response ? `HTTP ${response.status}` : 'no answer'}`);
  }
  return report;
}

export default {
  async scheduled(_controller: unknown, env: SlotlockStatusEnv, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    ctx.waitUntil(runSlotlockStatus(env).then((report) => console.log(JSON.stringify(report))));
  },
  async fetch(): Promise<Response> {
    return new Response('Slotlock status probe: it runs on a schedule and serves nothing.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
