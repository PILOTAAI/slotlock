// The CMS's scheduled posts (RFC 0006, 4.5): an Owner schedules a post in the admin console, which
// labels its pull request cms:scheduled and comments, as the "Slotlock CMS" App, the commit it may
// merge and when. Each hour, .github/workflows/cms-schedule.yml runs this as the App and merges each
// scheduled pull request whose time has come, if:
//   - the App's own latest schedule comment names a commit, and every file the pull request
//     changes is the same at its head as at that commit (bringing in main is fine; a change to the
//     post, or a label someone else added, merges nothing);
//   - it changes nothing but blog files (the console's rule, src/admin/cms.ts);
//   - it is up to date with main, as main's ruleset asks (if not, it is updated, and a later run
//     merges it once its checks pass again);
//   - the post is submitted (status: published) and every check on its head passed.
// A pull request whose post changed since it was scheduled loses its label, with a comment saying so.
// Merging as the App, not as the workflow's GITHUB_TOKEN, starts the site's deploy on main.
//
//   CMS_APP_ID=… CMS_APP_INSTALLATION=… CMS_APP_KEY="$(cat key.pem)" CMS_REPOSITORY=owner/name \
//     node scripts/cms-scheduled-merge.mjs
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const LABEL = 'cms:scheduled';
const BRANCH = /^cms\/([a-z0-9]+(?:-[a-z0-9]+){0,15})$/;
const SHA = /^[0-9a-f]{40}$/;

/** The files a CMS pull request may change: the same rule as slotlockCmsPathAllowed in src/admin/cms.ts. */
export function cmsPathAllowed(path) {
  return (
    /^site\/content\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.md$/.test(path) ||
    /^site\/public\/blog\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\/[a-z0-9]+(?:-[a-z0-9]+){0,15}\.(?:png|jpe?g|webp)$/.test(path) ||
    path === 'site/public/_redirects' ||
    path === 'site/src/data/authors.json'
  );
}

/** The App's latest schedule comment, as slotlockScheduleOf in src/admin/cms.ts reads it. */
export function scheduleOf(bodies) {
  for (const body of [...bodies].reverse()) {
    const found = /^<!-- slotlock-cms:(?:schedule sha=([0-9a-f]{40}) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z) by=([A-Za-z0-9-]{1,39})|unschedule) -->/.exec(body);
    if (!found) continue;
    return found[1] && found[2] && found[3] ? { sha: found[1], at: found[2], by: found[3] } : null;
  }
  return null;
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/** A JWT for the App, good for nine minutes, dated a minute back for clock skew. */
function appJwt(appId, privateKey, seconds) {
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey.replace(/\\n/g, '\n'));
  return `${unsigned}.${signature.toString('base64url')}`;
}

/**
 * Merge the scheduled posts whose time has come. Returns what happened to each scheduled pull
 * request: merged, waiting, or why it was left alone.
 */
export async function mergeDuePosts({ appId, installationId, privateKey, repository, fetch = globalThis.fetch, now = Date.now }) {
  if (!/^[1-9][0-9]{0,15}$/.test(String(appId)) || !/^[1-9][0-9]{0,15}$/.test(String(installationId))) {
    throw new Error('CMS_APP_ID and CMS_APP_INSTALLATION are numbers');
  }
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(String(repository))) throw new Error('CMS_REPOSITORY is owner/name');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'slotlock-cms-schedule' };
  const tokenResponse = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${appJwt(String(appId), privateKey, Math.floor(now() / 1000))}` },
  });
  if (!tokenResponse.ok) throw new Error(`GitHub refused the App's token (${tokenResponse.status})`);
  const { token } = await tokenResponse.json();
  const repo = `/repos/${repository}`;
  async function call(method, path, body, allow = []) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !allow.includes(response.status)) throw new Error(`GitHub answered ${response.status} to ${method} ${path.split('?')[0]}`);
    const text = response.status === 204 ? '' : await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  const results = [];
  const { body: pulls } = await call('GET', `${repo}/pulls?state=open&base=main&per_page=100`);
  for (const pull of pulls ?? []) {
    const slug = BRANCH.exec(pull.head?.ref ?? '')?.[1];
    // Only this repository's own cms/ branches, never a fork's of the same name.
    if (!slug || pull.head?.repo?.full_name !== repository || !(pull.labels ?? []).some((label) => label.name === LABEL)) continue;
    const number = pull.number;
    const sha = pull.head?.sha ?? '';
    const note = (outcome) => results.push({ number, slug, outcome });
    const { body: comments } = await call('GET', `${repo}/issues/${number}/comments?per_page=100`);
    const schedule = scheduleOf((comments ?? []).filter((c) => String(c.performed_via_github_app?.id ?? '') === String(appId)).map((c) => String(c.body ?? '')));
    const unschedule = async (why) => {
      await call('DELETE', `${repo}/issues/${number}/labels/${encodeURIComponent(LABEL)}`, undefined, [404]);
      await call('POST', `${repo}/issues/${number}/comments`, {
        body: `<!-- slotlock-cms:unschedule -->\nNot published on schedule: ${why} Publish it again from the admin console.`,
      });
      note(`unscheduled: ${why}`);
    };
    if (!schedule || !SHA.test(sha)) {
      await unschedule('the admin console did not schedule it.');
      continue;
    }
    if (Date.parse(schedule.at) > now()) {
      note(`waiting for ${schedule.at}`);
      continue;
    }
    const files = [];
    for (let page = 1; page <= 3; page += 1) {
      const { body } = await call('GET', `${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      for (const file of body ?? []) files.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if ((body ?? []).length < 100) break;
    }
    if (files.length === 0 || files.length >= 300 || !files.every(cmsPathAllowed)) {
      note('left alone: it changes files outside the blog');
      continue;
    }
    // A head that is not the scheduled commit is accepted only when it brought in main and nothing
    // else: every file the pull request changes is the same as in the commit the Owner scheduled.
    if (schedule.sha !== sha) {
      const blob = async (path, ref) => {
        const { status, body } = await call('GET', `${repo}/contents/${path}?ref=${ref}`, undefined, [404]);
        return status === 200 ? String(body?.sha ?? '') : null;
      };
      let same = true;
      for (const path of new Set(files)) {
        if ((await blob(path, schedule.sha)) !== (await blob(path, sha))) {
          same = false;
          break;
        }
      }
      if (!same) {
        await unschedule('the post changed after an Owner scheduled it.');
        continue;
      }
    }
    // Main's ruleset merges only a branch that is up to date with main; its checks then run again,
    // and a later run merges it.
    const { body: live } = await call('GET', `${repo}/pulls/${number}`);
    if (live?.mergeable_state === 'behind') {
      await call('PUT', `${repo}/pulls/${number}/update-branch`, { expected_head_sha: sha }, [422]);
      note('updating: it was behind main, and its checks run again');
      continue;
    }
    if (live?.mergeable_state === 'dirty') {
      note('left alone: it conflicts with main');
      continue;
    }
    const { status: found, body: file } = await call('GET', `${repo}/contents/site/content/blog/${slug}.md?ref=${sha}`, undefined, [404]);
    const text = found === 200 && typeof file?.content === 'string' ? Buffer.from(file.content, 'base64').toString('utf8') : '';
    const front = text.split('\n---\n')[0] ?? '';
    if (!/^status: published$/m.test(front)) {
      note('left alone: the post is not submitted');
      continue;
    }
    const { body: runs } = await call('GET', `${repo}/commits/${sha}/check-runs?per_page=100`);
    const checks = runs?.check_runs ?? [];
    if (checks.length === 0 || checks.some((run) => run.status !== 'completed')) {
      note('waiting: its checks have not finished');
      continue;
    }
    if (checks.some((run) => !['success', 'skipped', 'neutral'].includes(run.conclusion ?? ''))) {
      note('left alone: a check failed');
      continue;
    }
    const { body: commits } = await call('GET', `${repo}/pulls/${number}/commits?per_page=100`);
    const signOffs = new Set();
    for (const item of commits ?? []) {
      for (const line of String(item.commit?.message ?? '').split('\n')) {
        if (/^Signed-off-by: [^<>\n]{1,100} <[^<>\s]{3,200}>$/.test(line.trim())) signOffs.add(line.trim());
      }
    }
    const { status, body: merged } = await call(
      'PUT',
      `${repo}/pulls/${number}/merge`,
      {
        merge_method: 'squash',
        sha,
        commit_title: `${pull.title} (#${number})`,
        commit_message: [`Published on schedule (${schedule.at}), as ${schedule.by} scheduled it in the admin console.`, '', ...signOffs].join('\n'),
      },
      [405, 409, 422],
    );
    if (status !== 200 || merged?.merged !== true) {
      note(`left alone: GitHub would not merge it (${status})`);
      continue;
    }
    await call('DELETE', `${repo}/git/refs/heads/cms/${slug}`, undefined, [404, 422]);
    note('merged');
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = (name) => {
    const value = process.env[name]?.trim();
    if (!value) {
      console.error(`::error::${name} is not set`);
      process.exit(2);
    }
    return value;
  };
  const results = await mergeDuePosts({
    appId: env('CMS_APP_ID'),
    installationId: env('CMS_APP_INSTALLATION'),
    privateKey: env('CMS_APP_KEY'),
    repository: env('CMS_REPOSITORY'),
  });
  // Pull request numbers and outcomes only: a title is untrusted text in a workflow log.
  for (const result of results) console.log(`#${result.number}: ${result.outcome}`);
  if (results.length === 0) console.log('No scheduled posts.');
}
