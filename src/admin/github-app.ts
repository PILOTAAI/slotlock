// The admin console's CMS on GitHub (RFC 0006, 4.5): the "Slotlock CMS" GitHub App, installed on the
// site's repository only, with contents and pull requests write. The console commits a post and its
// images to cms/<slug>, authored and signed off as the staff member (so the DCO check passes), opens
// a pull request the site's checks run on, and merges it when an Owner publishes it.
//
// Only WebCrypto and fetch, so it runs in a Worker. The App's private key may be GitHub's PKCS#1
// download ("BEGIN RSA PRIVATE KEY") or PKCS#8; the installation token is kept until a minute before
// it expires.

export interface SlotlockCmsGitHubOptions {
  appId: string;
  /** The App's private key, PEM. */
  privateKey: string;
  installationId: string;
  /** owner/name: the repository the App is installed on. */
  repository: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Who commits: a staff member, as GitHub names them. */
export interface SlotlockCmsAuthor {
  login: string;
  id: string;
}

export interface SlotlockCmsFile {
  path: string;
  /**
   * Text, or bytes for a picture, a video or a PDF; a blob already in the repository, by its sha (a
   * rename moves a file without reading it); null deletes the file.
   */
  content: string | Uint8Array | { blob: string } | null;
}

/** A file in a directory, as GitHub lists it. */
export interface SlotlockCmsEntry {
  name: string;
  /** Bytes. */
  size: number;
  /** Its blob's sha, which a commit can use again. */
  sha: string;
}

export interface SlotlockCmsPullRequest {
  number: number;
  title: string;
  branch: string;
  headSha: string;
  url: string;
  labels: string[];
  author: string | null;
}

export type SlotlockCmsChecks = 'passing' | 'failing' | 'pending' | 'none';

export interface SlotlockCmsSnapshot {
  /** Each file in the directory, with its text (null for a binary or very large file). */
  directory: { name: string; text: string | null }[];
  /** Each file asked for, or null when it is not there. */
  files: (string | null)[];
  /** How each commit asked for fares, from its checks and statuses. */
  checks: SlotlockCmsChecks[];
}

export interface SlotlockCmsGitHub {
  repository: string;
  /** A file's text and blob sha on a branch, or null when it is not there. */
  readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null>;
  /** A file's bytes on a branch (up to GitHub's 100 MB, read raw), or null when it is not there. */
  readBytes(path: string, ref: string): Promise<Uint8Array | null>;
  /** The names of the files in a directory on a branch (not recursive), or [] when it is not there. */
  listDirectory(path: string, ref: string): Promise<string[]>;
  /** The files in a directory on a branch, with their sizes and blobs, or [] when it is not there. */
  listFiles(path: string, ref: string): Promise<SlotlockCmsEntry[]>;
  /** A directory's files with their texts, single files and commits' checks, in one GraphQL query. */
  snapshot(input: { directory: { ref: string; path: string }; files?: { ref: string; path: string }[]; commits?: string[] }): Promise<SlotlockCmsSnapshot>;
  /** The commit a branch points at, or null when it is not there. */
  branchHead(branch: string): Promise<string | null>;
  /**
   * Commit files to a cms/ branch (made from `base` if new), as the author, with a DCO sign-off. With
   * `expectHead`, only when the branch still points there, so two people saving at once cannot
   * overwrite each other.
   */
  commit(input: { branch: string; base: string; files: SlotlockCmsFile[]; message: string; author: SlotlockCmsAuthor; expectHead?: string | null }): Promise<string>;
  /** Open pull requests from cms/ branches. */
  pullRequests(): Promise<SlotlockCmsPullRequest[]>;
  /** The open pull request from a branch, or null. */
  pullRequestFor(branch: string): Promise<SlotlockCmsPullRequest | null>;
  /** Open a pull request from a branch into main, labelled cms. */
  openPullRequest(input: { branch: string; title: string; body: string }): Promise<SlotlockCmsPullRequest>;
  /**
   * Whether a pull request can merge as it is: clean, behind main (main's ruleset wants it up to
   * date), dirty (a conflict), blocked (a required check), or unknown while GitHub works it out.
   */
  pullState(number: number): Promise<{ headSha: string; mergeable: string; open: boolean }>;
  /** Merge main into the pull request's branch, if its head is still this commit. */
  updateBranch(number: number, expectedHead: string): Promise<boolean>;
  /**
   * What merging exactly this commit into main brings (compare main...sha): each file with its
   * status, its old path for a rename, and its diff. Null when there are too many to list.
   */
  commitFiles(sha: string): Promise<SlotlockCmsChange[] | null>;
  /**
   * The Signed-off-by lines of a pull request's commits, each once: only a commit's own author's
   * (its email), so a line written into a message for someone else is not carried into main.
   */
  signOffs(number: number): Promise<string[]>;
  /** How a commit fares: every check passed, one failed, some running, or none at all. */
  checks(sha: string): Promise<SlotlockCmsChecks>;
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  /** The bodies of the comments this App made on a pull request, oldest first, from every page. */
  appComments(number: number): Promise<string[]>;
  /** Close a pull request and delete its branch. */
  close(number: number, branch: string): Promise<void>;
  /** Delete a cms/ branch, as after its pull request merged; nothing when it is gone already. */
  deleteBranch(branch: string): Promise<void>;
  /** Squash-merge, only at this head commit. */
  merge(input: { number: number; sha: string; title: string; message: string }): Promise<{ merged: boolean; message: string }>;
  /**
   * The status page's incidents (docs/hosted/status.md): issues labelled `status`, open or recently
   * closed, newest first (RFC 0006, M10).
   */
  statusIssues(state: 'open' | 'closed'): Promise<SlotlockStatusIssue[]>;
  /** Open an incident: an issue labelled `status`. */
  openStatusIssue(input: { title: string; body: string }): Promise<SlotlockStatusIssue>;
  /**
   * Add an update to an incident, and close it with that update when `close`. Only an open issue
   * labelled `status`: false, and nothing posted, for any other.
   */
  updateStatusIssue(input: { number: number; body: string; close: boolean }): Promise<boolean>;
  /** The last runs of one of the repository's workflows on main (deploys and the site's checks). */
  workflowRuns(workflow: string, limit?: number): Promise<SlotlockWorkflowRun[]>;
}

/** A file a commit changes against main, as GitHub's compare API lists it. */
export interface SlotlockCmsChange {
  path: string;
  /** For a rename, where it was. */
  previous: string | null;
  /** added, removed, modified, renamed … */
  status: string;
  /** The unified diff, which the redirects' check reads; null when GitHub gave none. */
  patch: string | null;
}

/** An incident on the status page. */
export interface SlotlockStatusIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
  comments: number;
}

/** A workflow run on main, as the System page lists deploys. */
export interface SlotlockWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  sha: string;
  url: string;
  createdAt: string;
}

/** A workflow file the console may read the runs of. */
export const SLOTLOCK_WORKFLOW_FILE = /^[a-z0-9][a-z0-9-]{0,60}\.ya?ml$/;

export class SlotlockCmsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const API = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** The only branches the console writes: cms/<slug>. */
export const SLOTLOCK_CMS_BRANCH = /^cms\/[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;
const SHA = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();

/** A staff member's commit identity: their login and GitHub's no-reply address for their id. */
export function slotlockCmsIdentity(author: SlotlockCmsAuthor): { name: string; email: string } {
  return { name: author.login, email: `${author.id}+${author.login}@users.noreply.github.com` };
}

/** The DCO's Signed-off-by line for an author (scripts/check-dco.sh). */
export function slotlockSignOff(author: SlotlockCmsAuthor): string {
  const { name, email } = slotlockCmsIdentity(author);
  return `Signed-off-by: ${name} <${email}>`;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
const base64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** PKCS#1 (RSAPrivateKey) wrapped as PKCS#8 (PrivateKeyInfo), which WebCrypto imports. */
export function slotlockPkcs8FromPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...derLength(pkcs1.length)];
  const head = [0x30, ...derLength(inner.length + pkcs1.length), ...inner];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

function pemBytes(pem: string): { der: Uint8Array<ArrayBuffer>; pkcs1: boolean } {
  // A key pasted into a secret store sometimes arrives with literal \n for its line ends.
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!match || Boolean(match[1]) !== Boolean(match[3])) throw new SlotlockCmsError('The CMS App key is not a PEM private key', 500);
  const bytes = fromBase64(match[2] as string);
  const der = new Uint8Array(bytes.length);
  der.set(bytes);
  return { der, pkcs1: Boolean(match[1]) };
}

/** Pages of a pull request's comments read at most, a hundred each. */
const COMMENT_PAGES = 30;

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'slotlock-admin-cms',
};

const CHECK_STATES: Readonly<Record<string, SlotlockCmsChecks>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

export function createSlotlockCmsGitHub(options: SlotlockCmsGitHubOptions): SlotlockCmsGitHub {
  if (!REPOSITORY.test(options.repository)) throw new SlotlockCmsError('The CMS repository is owner/name', 500);
  if (!/^[1-9][0-9]{0,15}$/.test(options.appId) || !/^[1-9][0-9]{0,15}$/.test(options.installationId)) {
    throw new SlotlockCmsError('The CMS App id and installation id are numbers', 500);
  }
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const [owner, name] = options.repository.split('/') as [string, string];
  const repo = `/repos/${options.repository}`;
  let signingKey: Promise<CryptoKey> | null = null;
  let token: { value: string; until: number } | null = null;

  function key(): Promise<CryptoKey> {
    if (!signingKey) {
      const made = (async () => {
        const { der, pkcs1 } = pemBytes(options.privateKey);
        return globalThis.crypto.subtle.importKey('pkcs8', pkcs1 ? slotlockPkcs8FromPkcs1(der) : der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      })();
      // A key that would not import is tried again next time, not remembered as broken.
      made.catch(() => {
        if (signingKey === made) signingKey = null;
      });
      signingKey = made;
    }
    return signingKey;
  }

  /** A JWT for the App itself, good for nine minutes (GitHub allows ten), dated a minute back for clock skew. */
  async function appJwt(): Promise<string> {
    const seconds = Math.floor(now() / 1000);
    const part = (value: object) => base64url(encoder.encode(JSON.stringify(value)));
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: options.appId })}`;
    const signature = new Uint8Array(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', await key(), encoder.encode(unsigned)));
    return `${unsigned}.${base64url(signature)}`;
  }

  async function installationToken(): Promise<string> {
    if (token && token.until > now()) return token.value;
    const response = await fetcher(`${API}/app/installations/${options.installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${await appJwt()}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SlotlockCmsError(`GitHub refused the CMS App's token (${response.status})`, 502);
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string') throw new SlotlockCmsError('GitHub gave the CMS App no token', 502);
    const expires = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
    token = { value: body.token, until: (Number.isFinite(expires) ? expires : now() + 3_000_000) - 60_000 };
    return token.value;
  }

  /** A request as the App: a body is JSON, or bytes that are already JSON (a blob's, written without a copy as a string). */
  async function send(method: string, path: string, body: unknown, accept?: string): Promise<Response> {
    return fetcher(`${API}${path}`, {
      method,
      headers: {
        ...HEADERS,
        ...(accept ? { Accept: accept } : {}),
        Authorization: `Bearer ${await installationToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
      redirect: 'manual',
      // A video's blob takes longer to send than a post.
      signal: AbortSignal.timeout(body instanceof Uint8Array ? 120_000 : 15_000),
    });
  }

  async function call<T>(method: string, path: string, body?: unknown, allow: readonly number[] = []): Promise<{ status: number; body: T }> {
    const response = await send(method, path, body);
    if (!response.ok && !allow.includes(response.status)) {
      const text = await response.text().catch(() => '');
      let message = '';
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? '').slice(0, 200);
      } catch {
        message = '';
      }
      const where = path.startsWith(repo) ? path.slice(repo.length) : path;
      throw new SlotlockCmsError(`GitHub answered ${response.status} to ${method} ${where.split('?')[0]}${message ? `: ${message}` : ''}`, response.status >= 500 ? 502 : response.status);
    }
    const text = response.status === 204 ? '' : await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed as T };
  }

  async function graphql<T>(query: string, variables: Record<string, string>): Promise<T> {
    const { body } = await call<{ data?: T; errors?: { message?: string }[] }>('POST', '/graphql', { query, variables });
    if (!body?.data || (body.errors && body.errors.length > 0)) {
      throw new SlotlockCmsError(`GitHub's GraphQL API refused the query: ${String(body?.errors?.[0]?.message ?? 'no data').slice(0, 200)}`, 502);
    }
    return body.data;
  }

  /**
   * A blob's JSON body, {"content":"<base64>","encoding":"base64"}, as bytes: base64 in chunks, so a
   * video is held once as bytes and once as its encoding, never as strings besides.
   */
  function blobBody(bytes: Uint8Array): Uint8Array {
    const head = encoder.encode('{"content":"');
    const tail = encoder.encode('","encoding":"base64"}');
    const out = new Uint8Array(head.length + Math.ceil(bytes.length / 3) * 4 + tail.length);
    out.set(head);
    let at = head.length;
    const chunk = 3 * 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      const encoded = encoder.encode(base64(bytes.subarray(index, index + chunk)));
      out.set(encoded, at);
      at += encoded.length;
    }
    out.set(tail, at);
    return out;
  }

  const contentsPath = (path: string, ref: string) =>
    `${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;

  async function listFiles(path: string, ref: string): Promise<SlotlockCmsEntry[]> {
    const { status, body } = await call<{ name?: unknown; type?: unknown; size?: unknown; sha?: unknown }[] | null>('GET', contentsPath(path, ref), undefined, [404]);
    if (status === 404 || !Array.isArray(body)) return [];
    return body
      .filter((entry) => entry.type === 'file' && typeof entry.name === 'string')
      .map((entry) => ({ name: entry.name as string, size: Number(entry.size ?? 0), sha: String(entry.sha ?? '') }));
  }

  const branchHead = async (branch: string) =>
    (await call<{ object?: { sha?: string } } | null>('GET', `${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, [404])).body?.object?.sha ?? null;

  async function deleteBranch(branch: string): Promise<void> {
    if (!SLOTLOCK_CMS_BRANCH.test(branch)) throw new SlotlockCmsError('The console deletes only cms/<slug> branches', 400);
    await call('DELETE', `${repo}/git/refs/heads/${branch}`, undefined, [404, 422]);
  }

  const asStatusIssue = (raw: Record<string, unknown>): SlotlockStatusIssue => ({
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    url: String(raw.html_url ?? ''),
    createdAt: String(raw.created_at ?? ''),
    closedAt: typeof raw.closed_at === 'string' ? raw.closed_at : null,
    comments: Number(raw.comments ?? 0),
  });

  const asPullRequest = (raw: Record<string, unknown>): SlotlockCmsPullRequest => {
    const head = (raw.head ?? {}) as { ref?: unknown; sha?: unknown };
    const user = raw.user as { login?: unknown } | null | undefined;
    return {
      number: Number(raw.number),
      title: String(raw.title ?? ''),
      branch: String(head.ref ?? ''),
      headSha: String(head.sha ?? ''),
      url: String(raw.html_url ?? ''),
      labels: ((raw.labels ?? []) as { name?: unknown }[]).map((label) => String(label.name ?? '')),
      author: typeof user?.login === 'string' ? user.login : null,
    };
  };

  return {
    repository: options.repository,

    async readFile(path, ref) {
      const { status, body } = await call<{ content?: unknown; sha?: unknown } | null>('GET', contentsPath(path, ref), undefined, [404]);
      if (status === 404 || !body || typeof body.content !== 'string' || typeof body.sha !== 'string') return null;
      return { text: new TextDecoder().decode(fromBase64(body.content)), sha: body.sha };
    },

    async readBytes(path, ref) {
      // Raw, not JSON: the contents API gives a file over 1 MB only so (up to 100 MB).
      const response = await send('GET', contentsPath(path, ref), undefined, 'application/vnd.github.raw+json');
      if (response.status === 404) return null;
      if (!response.ok) throw new SlotlockCmsError(`GitHub answered ${response.status} to GET /contents/${path}`, response.status >= 500 ? 502 : response.status);
      return new Uint8Array(await response.arrayBuffer());
    },

    async listDirectory(path, ref) {
      return (await listFiles(path, ref)).map((entry) => entry.name);
    },

    listFiles,

    async snapshot({ directory, files = [], commits = [] }) {
      if (files.length > 50 || commits.length > 50) throw new SlotlockCmsError('A snapshot reads at most 50 files and 50 commits', 500);
      const variables: Record<string, string> = { owner, name, d: `${directory.ref}:${directory.path}` };
      const declared = ['$owner: String!', '$name: String!', '$d: String!'];
      const parts = ['d: object(expression: $d) { ... on Tree { entries { name type object { ... on Blob { text } } } } }'];
      files.forEach((file, index) => {
        variables[`f${index}`] = `${file.ref}:${file.path}`;
        declared.push(`$f${index}: String!`);
        parts.push(`f${index}: object(expression: $f${index}) { ... on Blob { text } }`);
      });
      commits.forEach((sha, index) => {
        variables[`c${index}`] = sha;
        declared.push(`$c${index}: String!`);
        parts.push(`c${index}: object(expression: $c${index}) { ... on Commit { statusCheckRollup { state } } }`);
      });
      const data = await graphql<{ repository: Record<string, unknown> | null }>(
        `query(${declared.join(', ')}) { repository(owner: $owner, name: $name) { ${parts.join(' ')} } }`,
        variables,
      );
      const found = data.repository ?? {};
      const tree = found.d as { entries?: { name?: unknown; type?: unknown; object?: { text?: unknown } | null }[] } | null | undefined;
      return {
        directory: (tree?.entries ?? [])
          .filter((entry) => entry.type === 'blob' && typeof entry.name === 'string')
          .map((entry) => ({ name: entry.name as string, text: typeof entry.object?.text === 'string' ? entry.object.text : null })),
        files: files.map((_, index) => {
          const blob = found[`f${index}`] as { text?: unknown } | null | undefined;
          return typeof blob?.text === 'string' ? blob.text : null;
        }),
        checks: commits.map((_, index) => {
          const commit = found[`c${index}`] as { statusCheckRollup?: { state?: unknown } | null } | null | undefined;
          return CHECK_STATES[String(commit?.statusCheckRollup?.state ?? '')] ?? 'none';
        }),
      };
    },

    branchHead,

    async commit({ branch, base, files, message, author, expectHead }) {
      if (!SLOTLOCK_CMS_BRANCH.test(branch)) throw new SlotlockCmsError('The console writes only to cms/<slug> branches', 400);
      const existing = await branchHead(branch);
      if (expectHead !== undefined && existing !== expectHead) {
        throw new SlotlockCmsError('The post changed on GitHub since you opened it', 409);
      }
      const parent = existing ?? (await branchHead(base));
      if (!parent) throw new SlotlockCmsError(`The branch ${base} is not there`, 502);
      const { body: parentCommit } = await call<{ tree?: { sha?: string } }>('GET', `${repo}/git/commits/${parent}`);
      const entries: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
      for (const file of files) {
        if (file.content === null) {
          entries.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        if (!(file.content instanceof Uint8Array) && typeof file.content === 'object') {
          if (!SHA.test(file.content.blob)) throw new SlotlockCmsError('A blob is 40 hex characters', 400);
          entries.push({ path: file.path, mode: '100644', type: 'blob', sha: file.content.blob });
          continue;
        }
        const bytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
        const { body: blob } = await call<{ sha?: string }>('POST', `${repo}/git/blobs`, blobBody(bytes));
        entries.push({ path: file.path, mode: '100644', type: 'blob', sha: String(blob?.sha ?? '') });
      }
      const { body: tree } = await call<{ sha?: string }>('POST', `${repo}/git/trees`, { base_tree: parentCommit?.tree?.sha, tree: entries });
      const identity = { ...slotlockCmsIdentity(author), date: new Date(now()).toISOString() };
      const { body: made } = await call<{ sha?: string }>('POST', `${repo}/git/commits`, {
        message: `${message.trim()}\n\n${slotlockSignOff(author)}`,
        tree: tree?.sha,
        parents: [parent],
        author: identity,
      });
      const sha = String(made?.sha ?? '');
      if (!SHA.test(sha)) throw new SlotlockCmsError('GitHub made no commit', 502);
      if (existing) {
        await call('PATCH', `${repo}/git/refs/heads/${branch}`, { sha, force: false });
      } else {
        await call('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      }
      return sha;
    },

    async pullRequests() {
      const { body } = await call<Record<string, unknown>[]>('GET', `${repo}/pulls?state=open&base=main&per_page=100`);
      // Only this repository's own cms/ branches: a fork's branch of the same name is not the console's.
      return (body ?? [])
        .filter((raw) => (raw.head as { repo?: { full_name?: unknown } | null } | undefined)?.repo?.full_name === options.repository)
        .map(asPullRequest)
        .filter((pull) => SLOTLOCK_CMS_BRANCH.test(pull.branch));
    },

    async pullRequestFor(branch) {
      const { body } = await call<Record<string, unknown>[]>('GET', `${repo}/pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      return (body ?? []).map(asPullRequest).find((pull) => pull.branch === branch) ?? null;
    },

    async openPullRequest({ branch, title, body }) {
      if (!SLOTLOCK_CMS_BRANCH.test(branch)) throw new SlotlockCmsError('The console opens pull requests only from cms/<slug> branches', 400);
      const { body: made } = await call<Record<string, unknown>>('POST', `${repo}/pulls`, { title, body, head: branch, base: 'main' });
      const pull = asPullRequest(made ?? {});
      await call('POST', `${repo}/issues/${pull.number}/labels`, { labels: ['cms'] });
      return { ...pull, labels: [...pull.labels, 'cms'] };
    },

    async pullState(number) {
      const { body } = await call<{ head?: { sha?: unknown }; mergeable_state?: unknown; state?: unknown }>('GET', `${repo}/pulls/${number}`);
      return {
        headSha: String(body?.head?.sha ?? ''),
        mergeable: String(body?.mergeable_state ?? 'unknown'),
        open: body?.state === 'open',
      };
    },

    async updateBranch(number, expectedHead) {
      const { status } = await call('PUT', `${repo}/pulls/${number}/update-branch`, { expected_head_sha: expectedHead }, [422]);
      return status === 202;
    },

    async commitFiles(sha) {
      if (!SHA.test(sha)) throw new SlotlockCmsError('A commit is 40 hex characters', 400);
      const { body } = await call<{ files?: { filename?: unknown; previous_filename?: unknown; status?: unknown; patch?: unknown }[] }>(
        'GET', `${repo}/compare/main...${sha}`,
      );
      const files = body?.files ?? [];
      // GitHub lists at most 300 files of a comparison: more cannot be checked, so none is merged.
      if (files.length >= 300) return null;
      return files.flatMap((file) => (typeof file.filename === 'string'
        ? [{
            path: file.filename,
            previous: typeof file.previous_filename === 'string' ? file.previous_filename : null,
            status: typeof file.status === 'string' ? file.status : 'modified',
            patch: typeof file.patch === 'string' ? file.patch : null,
          }]
        : []));
    },

    async signOffs(number) {
      const { body } = await call<{ commit?: { message?: unknown; author?: { email?: unknown } | null } }[]>('GET', `${repo}/pulls/${number}/commits?per_page=100`);
      const lines = new Set<string>();
      for (const item of body ?? []) {
        const email = String(item.commit?.author?.email ?? '').toLowerCase();
        for (const line of String(item.commit?.message ?? '').split('\n')) {
          const found = /^Signed-off-by: [^<>\n]{1,100} <([^<>\s]{3,200})>$/.exec(line.trim());
          if (found && email !== '' && (found[1] as string).toLowerCase() === email) lines.add(line.trim());
        }
      }
      return [...lines];
    },

    async checks(sha) {
      if (!SHA.test(sha)) return 'none';
      const { body } = await call<{ check_runs?: { status?: string; conclusion?: string | null }[] }>('GET', `${repo}/commits/${sha}/check-runs?per_page=100`);
      const runs = body?.check_runs ?? [];
      if (runs.length === 0) return 'none';
      if (runs.some((run) => run.status === 'completed' && !['success', 'skipped', 'neutral'].includes(run.conclusion ?? ''))) return 'failing';
      if (runs.some((run) => run.status !== 'completed')) return 'pending';
      return 'passing';
    },

    async addLabel(number, label) {
      await call('POST', `${repo}/issues/${number}/labels`, { labels: [label] });
    },

    async removeLabel(number, label) {
      await call('DELETE', `${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, undefined, [404]);
    },

    async comment(number, body) {
      await call('POST', `${repo}/issues/${number}/comments`, { body });
    },

    async appComments(number) {
      // Every page, oldest first, so the App's latest comment is read however many others came before.
      const bodies: string[] = [];
      for (let page = 1; page <= COMMENT_PAGES; page += 1) {
        const { body } = await call<{ body?: unknown; performed_via_github_app?: { id?: unknown } | null }[]>(
          'GET', `${repo}/issues/${number}/comments?per_page=100&page=${page}`,
        );
        for (const item of body ?? []) {
          if (String(item.performed_via_github_app?.id ?? '') === options.appId && typeof item.body === 'string') bodies.push(item.body);
        }
        if ((body ?? []).length < 100) return bodies;
      }
      // Past the cap, the latest comments are unread: no schedule is trusted from what was.
      throw new SlotlockCmsError(`The pull request has more than ${COMMENT_PAGES * 100} comments`, 502);
    },

    async close(number, branch) {
      if (!SLOTLOCK_CMS_BRANCH.test(branch)) throw new SlotlockCmsError('The console closes only cms/<slug> branches', 400);
      await call('PATCH', `${repo}/pulls/${number}`, { state: 'closed' });
      await deleteBranch(branch);
    },

    deleteBranch,

    async statusIssues(state) {
      const { body } = await call<Record<string, unknown>[]>(
        'GET', `${repo}/issues?labels=status&state=${state}&sort=created&direction=desc&per_page=${state === 'open' ? 50 : 10}`,
      );
      // The issues API lists pull requests too; an incident is an issue.
      return (body ?? []).filter((item) => !item.pull_request).map(asStatusIssue);
    },

    async openStatusIssue({ title, body }) {
      const { body: made } = await call<Record<string, unknown>>('POST', `${repo}/issues`, { title, body, labels: ['status'] });
      return asStatusIssue(made ?? {});
    },

    async updateStatusIssue({ number, body, close }) {
      const { status, body: issue } = await call<{ state?: unknown; labels?: { name?: unknown }[]; pull_request?: unknown } | null>(
        'GET', `${repo}/issues/${number}`, undefined, [404, 410],
      );
      const isIncident =
        status === 200 && issue && !issue.pull_request && issue.state === 'open' &&
        (issue.labels ?? []).some((label) => label.name === 'status');
      if (!isIncident) return false;
      await call('POST', `${repo}/issues/${number}/comments`, { body });
      if (close) await call('PATCH', `${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
      return true;
    },

    async workflowRuns(workflow, limit = 5) {
      if (!SLOTLOCK_WORKFLOW_FILE.test(workflow)) throw new SlotlockCmsError('A workflow is a .yml file name', 400);
      const { body } = await call<{ workflow_runs?: Record<string, unknown>[] } | null>(
        'GET', `${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=${Math.min(Math.max(limit, 1), 20)}`, undefined, [404],
      );
      return (body?.workflow_runs ?? []).map((run) => ({
        id: Number(run.id),
        name: String(run.name ?? workflow),
        status: String(run.status ?? ''),
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        event: String(run.event ?? ''),
        sha: String(run.head_sha ?? ''),
        url: String(run.html_url ?? ''),
        createdAt: String(run.created_at ?? ''),
      }));
    },

    async merge({ number, sha, title, message }) {
      const { status, body } = await call<{ merged?: boolean; message?: string }>(
        'PUT', `${repo}/pulls/${number}/merge`,
        { merge_method: 'squash', sha, commit_title: `${title} (#${number})`, commit_message: message },
        [405, 409, 422],
      );
      return { merged: status === 200 && body?.merged === true, message: String(body?.message ?? '').slice(0, 200) };
    },
  };
}
