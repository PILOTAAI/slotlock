// A fake of the GitHub API the admin console's CMS and the scheduled-merge script use
// (src/admin/github-app.ts, scripts/cms-scheduled-merge.mjs): one repository held in memory, with
// blobs, flat trees, commits, branches, pull requests, labels, comments, check runs, squash merges
// that keep main's ruleset (up to date with main, checks passed), and the one GraphQL query the
// console sends. An App installation token, and the App's installation on the repository, are given
// only for a JWT the App's key signed, issued by its Client ID or its numeric App ID.
import { createHash, generateKeyPairSync, verify } from 'node:crypto';

export const FAKE_APP_ID = '424';
export const FAKE_CLIENT_ID = 'Iv23liFakeReleaseApp';
export const FAKE_APP_SLUG = 'pilotaai-slotlock-release';
export const FAKE_INSTALLATION = '77';
export const FAKE_REPOSITORY = 'PILOTAAI/slotlock';
/** The installation token the fake gives, as the hourly workflow's token step would hand it on. */
export const FAKE_TOKEN = 'ghs_fake_installation_token';
const TOKEN = FAKE_TOKEN;

interface Commit {
  tree: Map<string, string>;
  parents: string[];
  message: string;
  author: { name: string; email: string } | null;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  branch: string;
  state: 'open' | 'closed';
  merged: boolean;
  labels: string[];
  /** Each comment, and whether the App made it (true), another App did ({ id, slug }) or a person (false). */
  comments: { body: string; app: boolean | { id: number; slug: string } }[];
  /** The main commit the branch last started from or caught up with: what the pull request's diff is against. */
  base: string;
  /** The fork it comes from, when it is not this repository's own branch. */
  fork?: string;
}

export interface FakeGithubRepo {
  fetch: typeof fetch;
  /** The App's private key, in GitHub's PKCS#1 download format. */
  privateKey: string;
  /** Every request, "METHOD /path". */
  calls: string[];
  files(ref: string): Map<string, string>;
  text(ref: string, path: string): string | null;
  bytes(ref: string, path: string): Uint8Array | null;
  commit(sha: string): Commit | undefined;
  head(branch: string): string | null;
  pulls: Map<number, FakePull>;
  /** A commit's check runs: every check passes unless a test puts another function here. */
  checksFor: (sha: string) => { status: string; conclusion: string | null }[];
  /** A commit pushed to main by someone else, so open pull requests fall behind. */
  pushToMain(files: Record<string, string | null>, message?: string): string;
  /** A commit pushed straight to a branch (made from main if new) by someone with write access, not by the console. */
  pushToBranch(branch: string, files: Record<string, string | null>, message: string): string;
  /** Open a pull request as a person would, outside the console; from a fork, if named. */
  openPull(branch: string, title: string, fork?: string): FakePull;
  /** The last squash merge's title and message. */
  merges: { title: string; message: string; number: number }[];
  /** The commits a compare/main...<sha> was asked for, in order. */
  compared: string[];
  /** Issues, numbered after the pull requests: the status page's incidents (labelled status) and others. */
  issues: Map<number, FakeIssue>;
  /** Open an issue as a person (or the status probe) would, outside the console. */
  openIssue(title: string, labels: string[]): FakeIssue;
  /** Each workflow file's runs on main, newest first. */
  runs: Map<string, { id: number; name: string; status: string; conclusion: string | null; event: string; head_sha: string; html_url: string; created_at: string }[]>;
  /** The body of each installation token request, in order. */
  tokenRequests: Record<string, unknown>[];
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: string[];
  createdAt: string;
  closedAt: string | null;
}

/** An object id shaped like git's (40 hex characters), from SHA-256: the fake needs only unique names. */
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex').slice(0, 40);
const utf8 = (value: string) => new TextEncoder().encode(value);

export function createFakeGithubRepo(seed: Record<string, string | Uint8Array>, options: { now?: () => number } = {}): FakeGithubRepo {
  const now = options.now ?? (() => Date.now());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, Commit>();
  const refs = new Map<string, string>();
  const pulls = new Map<number, FakePull>();
  const calls: string[] = [];
  const merges: { title: string; message: string; number: number }[] = [];
  let counter = 0;
  let nextPull = 100;

  const putBlob = (bytes: Uint8Array) => {
    const sha = hash(bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const putTree = (tree: Map<string, string>) => {
    const sha = hash(JSON.stringify([...tree].sort()));
    trees.set(sha, new Map(tree));
    return sha;
  };
  const putCommit = (commit: Commit) => {
    counter += 1;
    const sha = hash(`${counter}:${commit.message}:${commit.parents.join(',')}`);
    commits.set(sha, commit);
    return sha;
  };
  const treeOf = (ref: string): Map<string, string> | null => {
    const sha = refs.get(ref) ?? (commits.has(ref) ? ref : null);
    return sha ? (commits.get(sha)?.tree ?? null) : null;
  };
  const withFiles = (tree: Map<string, string>, files: Record<string, string | Uint8Array | null>) => {
    const next = new Map(tree);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) next.delete(path);
      else next.set(path, putBlob(typeof content === 'string' ? utf8(content) : content));
    }
    return next;
  };

  refs.set('main', putCommit({ tree: withFiles(new Map(), seed), parents: [], message: 'Initial', author: null }));

  const ancestors = (sha: string) => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(commits.get(next)?.parents ?? []));
    }
    return seen;
  };
  const fake: FakeGithubRepo = {
    fetch: null as unknown as typeof fetch,
    privateKey: pem,
    calls,
    pulls,
    merges,
    files: (ref) => {
      const tree = treeOf(ref) ?? new Map<string, string>();
      return new Map([...tree].map(([path, sha]) => [path, new TextDecoder().decode(blobs.get(sha))]));
    },
    text: (ref, path) => {
      const sha = treeOf(ref)?.get(path);
      return sha ? new TextDecoder().decode(blobs.get(sha)) : null;
    },
    bytes: (ref, path) => {
      const sha = treeOf(ref)?.get(path);
      return sha ? (blobs.get(sha) ?? null) : null;
    },
    commit: (sha) => commits.get(sha),
    head: (branch) => refs.get(branch) ?? null,
    checksFor: () => [{ status: 'completed', conclusion: 'success' }],
    pushToMain(files, message = 'Elsewhere on main') {
      const parent = refs.get('main') as string;
      const sha = putCommit({ tree: withFiles(commits.get(parent)?.tree ?? new Map(), files), parents: [parent], message, author: null });
      refs.set('main', sha);
      return sha;
    },
    pushToBranch(branch, files, message) {
      const parent = refs.get(branch) ?? (refs.get('main') as string);
      const sha = putCommit({ tree: withFiles(commits.get(parent)?.tree ?? new Map(), files), parents: [parent], message, author: { name: 'someone', email: 'someone@example.com' } });
      refs.set(branch, sha);
      return sha;
    },
    openPull(branch, title, fork) {
      const pull: FakePull = { number: nextPull++, title, body: '', branch, state: 'open', merged: false, labels: [], comments: [], base: refs.get('main') as string, ...(fork ? { fork } : {}) };
      pulls.set(pull.number, pull);
      return pull;
    },
    compared: [],
    issues: new Map(),
    openIssue(title, labels) {
      // Issues and pull requests share their numbers, as on GitHub.
      const issue: FakeIssue = { number: nextPull++, title, body: '', state: 'open', labels: [...labels], comments: [], createdAt: new Date(now()).toISOString(), closedAt: null };
      fake.issues.set(issue.number, issue);
      return issue;
    },
    runs: new Map(),
    tokenRequests: [],
  };

  const diff = (pull: FakePull) => {
    const before = commits.get(pull.base)?.tree ?? new Map<string, string>();
    const after = commits.get(refs.get(pull.branch) ?? '')?.tree ?? new Map<string, string>();
    const changed: string[] = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) if (before.get(path) !== after.get(path)) changed.push(path);
    return changed.sort();
  };
  const behind = (pull: FakePull) => !ancestors(refs.get(pull.branch) ?? '').has(refs.get('main') as string);
  const asPull = (pull: FakePull) => ({
    number: pull.number,
    title: pull.title,
    html_url: `https://github.com/${FAKE_REPOSITORY}/pull/${pull.number}`,
    state: pull.state,
    head: { ref: pull.branch, sha: refs.get(pull.branch) ?? '', repo: { full_name: pull.fork ?? FAKE_REPOSITORY } },
    labels: pull.labels.map((name) => ({ name })),
    user: { login: 'slotlock-cms[bot]' },
    mergeable_state: pull.state !== 'open' ? 'unknown' : behind(pull) ? 'behind' : 'clean',
  });
  const passing = (sha: string) => {
    const runs = fake.checksFor(sha);
    return runs.length > 0 && runs.every((run) => run.status === 'completed' && ['success', 'skipped', 'neutral'].includes(run.conclusion ?? ''));
  };

  fake.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = target.pathname;
    calls.push(`${method} ${path}`);
    const reply = (body: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // GitHub takes the App's Client ID or its App ID as the JWT's issuer.
    const appJwt = () => {
      const [header, payload, signature] = auth.replace(/^Bearer /, '').split('.');
      if (!header || !payload || !signature) return reply({ message: 'A JSON web token could not be decoded' }, 401);
      const ok = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: string; exp?: number; iat?: number };
      const seconds = Math.floor(now() / 1000);
      if (!ok || ![FAKE_APP_ID, FAKE_CLIENT_ID].includes(claims.iss ?? '') || !claims.exp || claims.exp < seconds || claims.exp - (claims.iat ?? 0) > 600) {
        return reply({ message: 'Bad credentials' }, 401);
      }
      return null;
    };
    if (method === 'POST' && path === `/app/installations/${FAKE_INSTALLATION}/access_tokens`) {
      const refused = appJwt();
      if (refused) return refused;
      fake.tokenRequests.push(body);
      return reply({ token: TOKEN, expires_at: new Date(now() + 3_600_000).toISOString() }, 201);
    }
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
      const refused = appJwt();
      if (refused) return refused;
      if (path.toLowerCase() !== `/repos/${FAKE_REPOSITORY}/installation`.toLowerCase()) return reply({ message: 'Not Found' }, 404);
      return reply({
        id: Number(FAKE_INSTALLATION), app_id: Number(FAKE_APP_ID), app_slug: FAKE_APP_SLUG, client_id: FAKE_CLIENT_ID,
        repository_selection: 'selected',
        permissions: { actions: 'read', checks: 'read', contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write', statuses: 'read' },
      });
    }
    if (auth !== `Bearer ${TOKEN}`) return reply({ message: 'Bad credentials' }, 401);

    if (method === 'POST' && path === '/graphql') {
      const variables = (body.variables ?? {}) as Record<string, string>;
      const repository: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(variables)) {
        if (name === 'd') {
          const [ref, dir] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
          const tree = treeOf(ref);
          const entries = [...(tree ?? new Map<string, string>())]
            .filter(([file]) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/'))
            .map(([file, sha]) => ({ name: file.slice(dir.length + 1), type: 'blob', object: { text: new TextDecoder().decode(blobs.get(sha)) } }));
          repository.d = tree ? { entries } : null;
        } else if (/^f\d+$/.test(name)) {
          const [ref, file] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
          const sha = treeOf(ref)?.get(file);
          repository[name] = sha ? { text: new TextDecoder().decode(blobs.get(sha)) } : null;
        } else if (/^c\d+$/.test(name)) {
          const runs = fake.checksFor(value);
          const state = runs.length === 0 ? null : runs.some((run) => run.status !== 'completed') ? 'PENDING' : passing(value) ? 'SUCCESS' : 'FAILURE';
          repository[name] = commits.has(value) ? { statusCheckRollup: state ? { state } : null } : null;
        }
      }
      return reply({ data: { repository } });
    }

    const prefix = `/repos/${FAKE_REPOSITORY}`;
    if (!path.startsWith(prefix)) return reply({ message: 'Not Found' }, 404);
    const rest = path.slice(prefix.length);
    let match: RegExpExecArray | null;

    // compare/main...<sha>: what merging that commit brings, against its merge base with main, with
    // each file's status and, for text, a diff of the lines that went and came.
    if ((match = /^\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const head = match[1] as string;
      if (!commits.has(head)) return reply({ message: 'Not Found' }, 404);
      const onMain = ancestors(refs.get('main') as string);
      const queue = [head];
      let base: string | null = null;
      while (queue.length && !base) {
        const next = queue.shift() as string;
        if (onMain.has(next)) base = next;
        else queue.push(...(commits.get(next)?.parents ?? []));
      }
      const before = commits.get(base ?? '')?.tree ?? new Map<string, string>();
      const after = commits.get(head)?.tree ?? new Map<string, string>();
      const text = (sha: string | undefined) => (sha ? new TextDecoder().decode(blobs.get(sha)) : '');
      const files = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((file) => {
        if (before.get(file) === after.get(file)) return [];
        const status = !before.has(file) ? 'added' : !after.has(file) ? 'removed' : 'modified';
        const binary = /\.(?:png|jpe?g|webp)$/.test(file);
        const was = text(before.get(file)).split('\n').filter(Boolean);
        const now = text(after.get(file)).split('\n').filter(Boolean);
        const patch = binary
          ? undefined
          : ['@@ -1 +1 @@', ...was.filter((line) => !now.includes(line)).map((line) => `-${line}`), ...now.filter((line) => !was.includes(line)).map((line) => `+${line}`)].join('\n');
        return [{ filename: file, status, ...(patch === undefined ? {} : { patch }) }];
      });
      fake.compared.push(head);
      return reply({ status: 'ahead', merge_base_commit: { sha: base }, files });
    }

    if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      const sha = refs.get(decodeURIComponent(match[1] as string));
      return sha ? reply({ object: { sha } }) : reply({ message: 'Not Found' }, 404);
    }
    if ((match = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const commit = commits.get(match[1] as string);
      return commit ? reply({ sha: match[1], tree: { sha: putTree(commit.tree) } }) : reply({ message: 'Not Found' }, 404);
    }
    if (rest === '/git/blobs' && method === 'POST') {
      return reply({ sha: putBlob(new Uint8Array(Buffer.from(String(body.content), 'base64'))) }, 201);
    }
    if (rest === '/git/trees' && method === 'POST') {
      const tree = new Map(trees.get(String(body.base_tree)) ?? []);
      for (const entry of body.tree as { path: string; sha: string | null }[]) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, entry.sha);
      }
      return reply({ sha: putTree(tree) }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      const tree = trees.get(String(body.tree));
      if (!tree) return reply({ message: 'Tree not found' }, 422);
      const author = body.author as { name: string; email: string };
      return reply({ sha: putCommit({ tree, parents: body.parents as string[], message: String(body.message), author }) }, 201);
    }
    if ((match = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const branch = decodeURIComponent(match[1] as string);
      const old = refs.get(branch);
      if (!old) return reply({ message: 'Reference does not exist' }, 422);
      if (!ancestors(String(body.sha)).has(old)) return reply({ message: 'Update is not a fast forward' }, 422);
      refs.set(branch, String(body.sha));
      return reply({ object: { sha: body.sha } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      if (refs.has(branch)) return reply({ message: 'Reference already exists' }, 422);
      refs.set(branch, String(body.sha));
      return reply({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((match = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'DELETE') {
      return refs.delete(decodeURIComponent(match[1] as string)) ? reply(null, 204) : reply({ message: 'Reference does not exist' }, 422);
    }
    if ((match = /^\/contents\/(.+)$/.exec(rest)) && method === 'GET') {
      const file = decodeURIComponent(match[1] as string);
      const tree = treeOf(target.searchParams.get('ref') ?? 'main');
      if (!tree) return reply({ message: 'No commit found for the ref' }, 404);
      const sha = tree.get(file);
      if (sha) return reply({ type: 'file', sha, encoding: 'base64', content: Buffer.from(blobs.get(sha) as Uint8Array).toString('base64') });
      const entries = [...tree.keys()].filter((name) => name.startsWith(`${file}/`) && !name.slice(file.length + 1).includes('/'));
      return entries.length ? reply(entries.map((name) => ({ name: name.slice(file.length + 1), type: 'file' }))) : reply({ message: 'Not Found' }, 404);
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = target.searchParams.get('head');
      return reply([...pulls.values()].filter((pull) => pull.state === 'open' && (!head || head === `PILOTAAI:${pull.branch}`)).map(asPull));
    }
    if (rest === '/pulls' && method === 'POST') {
      if ([...pulls.values()].some((pull) => pull.state === 'open' && pull.branch === body.head)) return reply({ message: 'A pull request already exists' }, 422);
      const branchHead = refs.get(String(body.head));
      if (!branchHead) return reply({ message: 'Validation Failed' }, 422);
      // The branch started from main where its first commit's parent is.
      let base = branchHead;
      const mainCommits = ancestors(refs.get('main') as string);
      while (!mainCommits.has(base)) base = commits.get(base)?.parents[0] ?? base;
      const pull: FakePull = { number: nextPull++, title: String(body.title), body: String(body.body), branch: String(body.head), state: 'open', merged: false, labels: [], comments: [], base };
      pulls.set(pull.number, pull);
      return reply(asPull(pull), 201);
    }
    // Issues (the status page's incidents) and workflow runs (deploys).
    const asIssue = (issue: FakeIssue) => ({
      number: issue.number, title: issue.title, state: issue.state, html_url: `https://github.com/${FAKE_REPOSITORY}/issues/${issue.number}`,
      created_at: issue.createdAt, closed_at: issue.closedAt, comments: issue.comments.length, labels: issue.labels.map((name) => ({ name })),
    });
    if (rest === '/issues' && method === 'GET') {
      const label = target.searchParams.get('labels');
      const state = target.searchParams.get('state') ?? 'open';
      const listed = [...fake.issues.values()]
        .filter((issue) => issue.state === state && (!label || issue.labels.includes(label)))
        .sort((a, b) => b.number - a.number)
        .slice(0, Number(target.searchParams.get('per_page') ?? 30));
      return reply(listed.map(asIssue));
    }
    if (rest === '/issues' && method === 'POST') {
      const issue = fake.openIssue(String(body.title), (body.labels as string[] | undefined) ?? []);
      issue.body = String(body.body ?? '');
      return reply(asIssue(issue), 201);
    }
    const onIssue = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    const issue = onIssue ? fake.issues.get(Number(onIssue[1])) : undefined;
    if (onIssue && issue) {
      if (!onIssue[2] && method === 'GET') return reply(asIssue(issue));
      if (!onIssue[2] && method === 'PATCH') {
        if (body.state === 'closed') {
          issue.state = 'closed';
          issue.closedAt = new Date(now()).toISOString();
        }
        return reply(asIssue(issue));
      }
      if (onIssue[2] && method === 'POST') {
        issue.comments.push(String(body.body));
        return reply({ id: issue.comments.length }, 201);
      }
    }
    if ((match = /^\/actions\/workflows\/([a-z0-9.-]+)\/runs$/.exec(rest)) && method === 'GET') {
      const listed = fake.runs.get(match[1] as string);
      if (!listed) return reply({ message: 'Not Found' }, 404);
      return reply({ total_count: listed.length, workflow_runs: listed.slice(0, Number(target.searchParams.get('per_page') ?? 30)) });
    }

    const onPull = /^\/(pulls|issues)\/(\d+)(\/.*)?$/.exec(rest);
    const pull = onPull ? pulls.get(Number(onPull[2])) : undefined;
    if (onPull && !pull) return reply({ message: 'Not Found' }, 404);
    if (onPull && pull) {
      const sub = onPull[3] ?? '';
      if (onPull[1] === 'pulls' && sub === '' && method === 'GET') return reply(asPull(pull));
      if (onPull[1] === 'pulls' && sub === '' && method === 'PATCH') {
        if (body.state === 'closed') pull.state = 'closed';
        return reply(asPull(pull));
      }
      if (onPull[1] === 'pulls' && sub === '/files' && method === 'GET') {
        const page = Number(target.searchParams.get('page') ?? '1');
        return reply(page === 1 ? diff(pull).map((filename) => ({ filename })) : []);
      }
      if (onPull[1] === 'pulls' && sub === '/commits' && method === 'GET') {
        const out: { sha: string; commit: { message: string; author: { name: string; email: string } | null } }[] = [];
        const mainCommits = ancestors(pull.base);
        let at = refs.get(pull.branch);
        while (at && !mainCommits.has(at)) {
          const commit = commits.get(at) as Commit;
          out.unshift({ sha: at, commit: { message: commit.message, author: commit.author } });
          at = commit.parents[0];
        }
        return reply(out);
      }
      if (onPull[1] === 'pulls' && sub === '/update-branch' && method === 'PUT') {
        const head = refs.get(pull.branch) as string;
        if (body.expected_head_sha !== head) return reply({ message: 'expected head sha did not match' }, 422);
        const main = refs.get('main') as string;
        const tree = new Map(commits.get(main)?.tree);
        for (const path of diff(pull)) {
          const sha = commits.get(head)?.tree.get(path);
          if (sha) tree.set(path, sha);
          else tree.delete(path);
        }
        refs.set(pull.branch, putCommit({ tree, parents: [head, main], message: `Merge branch 'main' into ${pull.branch}`, author: null }));
        pull.base = main;
        return reply({ message: 'Updating pull request branch.' }, 202);
      }
      if (onPull[1] === 'pulls' && sub === '/merge' && method === 'PUT') {
        const head = refs.get(pull.branch) as string;
        if (pull.state !== 'open') return reply({ message: 'Pull Request is not mergeable' }, 405);
        if (body.sha !== head) return reply({ message: 'Head branch was modified. Review and try the merge again.' }, 409);
        if (behind(pull)) return reply({ message: 'Head branch is out of date. Review and try the merge again.' }, 405);
        if (!passing(head)) return reply({ message: 'Required status check "CI passed" is expected.' }, 405);
        if (body.merge_method !== 'squash') return reply({ message: 'Merge method not allowed' }, 405);
        const main = refs.get('main') as string;
        const tree = new Map(commits.get(main)?.tree);
        for (const path of diff(pull)) {
          const sha = commits.get(head)?.tree.get(path);
          if (sha) tree.set(path, sha);
          else tree.delete(path);
        }
        refs.set('main', putCommit({ tree, parents: [main], message: `${String(body.commit_title)}\n\n${String(body.commit_message)}`, author: null }));
        merges.push({ title: String(body.commit_title), message: String(body.commit_message), number: pull.number });
        pull.state = 'closed';
        pull.merged = true;
        return reply({ merged: true, message: 'Pull Request successfully merged' });
      }
      if (onPull[1] === 'issues' && sub === '/labels' && method === 'POST') {
        for (const label of body.labels as string[]) if (!pull.labels.includes(label)) pull.labels.push(label);
        return reply(pull.labels.map((name) => ({ name })));
      }
      if (onPull[1] === 'issues' && sub.startsWith('/labels/') && method === 'DELETE') {
        const label = decodeURIComponent(sub.slice('/labels/'.length));
        if (!pull.labels.includes(label)) return reply({ message: 'Label does not exist' }, 404);
        pull.labels = pull.labels.filter((name) => name !== label);
        return reply([]);
      }
      if (onPull[1] === 'issues' && sub === '/comments' && method === 'POST') {
        pull.comments.push({ body: String(body.body), app: true });
        return reply({ id: pull.comments.length }, 201);
      }
      if (onPull[1] === 'issues' && sub === '/comments' && method === 'GET') {
        // Oldest first, a page at a time, as GitHub lists them.
        const size = Number(target.searchParams.get('per_page') ?? '30');
        const page = Number(target.searchParams.get('page') ?? '1');
        return reply(pull.comments.slice((page - 1) * size, page * size).map((comment) => ({
          body: comment.body,
          performed_via_github_app: comment.app === true ? { id: Number(FAKE_APP_ID), slug: FAKE_APP_SLUG, client_id: FAKE_CLIENT_ID } : comment.app || null,
        })));
      }
    }
    if ((match = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest)) && method === 'GET') {
      return reply({ check_runs: fake.checksFor(match[1] as string) });
    }
    return reply({ message: `The fake does not answer ${method} ${rest}` }, 500);
  }) as typeof fetch;
  return fake;
}
