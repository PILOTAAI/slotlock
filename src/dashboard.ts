// The dashboard: people sign in with GitHub and manage the API keys and calendar resources of a
// personal tenant, `github:<user id>`. It is server-rendered HTML with no inline script or style,
// so its Content-Security-Policy allows nothing but this server's own stylesheet and script.
//
// Sign-in is GitHub's OAuth web flow with `state` and PKCE (S256) and no scope: the token is used
// once, to read who signed in, and dropped. A session is an HMAC-sealed cookie (`__Host-`,
// HttpOnly, Secure, SameSite=Lax) that lasts 12 hours and is checked against the allowlist on every
// request. Every form carries a CSRF token bound to the session, and every POST must come from this
// server's own origin.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SlotlockApiKey, SlotlockApiKeyScope, SlotlockApiKeyStore } from './api-keys.js';
import type { SlotlockStore } from './store.js';
import type { SlotlockResource, WeeklyAvailabilityRule } from './types.js';

/** Resources one dashboard tenant may hold. */
export const SLOTLOCK_DASHBOARD_MAX_RESOURCES = 100;
const SESSION_TTL_MS = 12 * 3_600_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_FORM_BYTES = 8_192;
const MAX_COOKIE_CHARACTERS = 4_096;
const GITHUB_TIMEOUT_MS = 10_000;
/** The REST API version GitHub documents for GET /user (docs.github.com, read 2026-10-10). */
const GITHUB_API_VERSION = '2026-03-10';
const USER_AGENT = 'slotlock-dashboard';
const SESSION_COOKIE = '__Host-slotlock-session';
const SIGN_IN_COOKIE = '__Host-slotlock-oauth';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const KEY_ACCESS: Readonly<Record<string, SlotlockApiKeyScope[]>> = Object.freeze({
  read: ['read'],
  read_write: ['read', 'write'],
});
const KEY_EXPIRY_DAYS: Readonly<Record<string, number | null>> = Object.freeze({
  never: null,
  '30': 30,
  '90': 90,
  '365': 365,
});
/**
 * `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` with every
 * form POST (Fetch, "append a request `Origin` header"), which the origin check must refuse. This
 * still sends no referrer to any other site, so the callback URL's code never leaves.
 */
const REFERRER_POLICY = 'same-origin';
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** A tenant's calendar resources, as the dashboard lists and adds them. */
export interface SlotlockDashboardResources {
  list(tenantRef: string): Promise<SlotlockResource[]>;
  /** Create the resource, or re-zone the tenant's resource with that reference. */
  add(tenantRef: string, externalRef: string, timezone: string): Promise<SlotlockResource>;
}

export interface SlotlockDashboardOptions {
  /** Where people reach the server; the dashboard lives at `<publicUrl>/dashboard`. */
  publicUrl: string;
  /**
   * A GitHub OAuth app whose callback URL is `<publicUrl>/dashboard/callback`. The endpoint URLs
   * default to GitHub's and exist for tests.
   */
  github: {
    clientId: string;
    clientSecret: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    userUrl?: string;
  };
  /** Seals sessions and sign-in state and derives CSRF tokens: 32+ random characters. */
  sessionSecret: string;
  /** GitHub user ids (numbers, as strings) that may sign in, or `'*'` for every GitHub account. */
  allowedUsers: '*' | readonly string[];
  keys: SlotlockApiKeyStore;
  resources: SlotlockDashboardResources;
  /** The server's bookable hours, shown read-only. */
  availability?: readonly WeeklyAvailabilityRule[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with whatever a request handler throws; the person sees a generic error page. */
  onError?: (error: unknown) => void;
}

export interface SlotlockDashboard {
  /** Whether a request is for the dashboard, so a server can route it here. */
  handles(request: Request): boolean;
  fetch(request: Request): Promise<Response>;
}

/** The dashboard's resources, in the store under each tenant's row-level security. */
export function createSlotlockDashboardResources(store: SlotlockStore): SlotlockDashboardResources {
  return {
    list: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.listResources({ tenantRef, limit: SLOTLOCK_DASHBOARD_MAX_RESOURCES + 1 }),
      ),
    add: (tenantRef, externalRef, timezone) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.createResource({ tenantRef, externalRef, timezone }),
      ),
  };
}

interface Session {
  /** GitHub user id. */
  uid: string;
  login: string;
  /** Random per session; the CSRF token is derived from it. */
  sid: string;
  exp: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Tagged template that escapes every interpolated value unless it is already `Html`. */
class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}
function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      out += part instanceof Html ? part.value : escapeHtml(String(part ?? ''));
    }
    out += strings[index + 1] ?? '';
  });
  return new Html(out);
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a === b;
}

function readCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name === SESSION_COOKIE || name === SIGN_IN_COOKIE) {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * A stylesheet or script. Pages link each with `?v=<hash of its content>`, so a versioned URL may be
 * cached for good and a new release is fetched at once; any other URL is revalidated.
 */
function asset(body: string, type: string, url: URL, version: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Cache-Control':
        url.searchParams.get('v') === version ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function formatDate(date: Date | null): string {
  if (!date) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const WEEKDAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
});

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `09:00–17:00`, or `from 22:00 for 10 h` when the window runs past midnight. */
function hoursOf(startMinutes: number, durationMinutes: number): string {
  const end = startMinutes + durationMinutes;
  return end <= 1_440
    ? `${formatMinutes(startMinutes)}–${formatMinutes(end)}`
    : `from ${formatMinutes(startMinutes)} for ${String(durationMinutes / 60)} h`;
}

export function createSlotlockDashboard(options: SlotlockDashboardOptions): SlotlockDashboard {
  const publicUrl = new URL(options.publicUrl);
  const origin = publicUrl.origin;
  const base = publicUrl.pathname.replace(/\/$/, '');
  const root = `${base}/dashboard`;
  const callbackUrl = `${origin}${root}/callback`;
  const mcpUrl = `${origin}${base}/mcp`;
  const a2aUrl = `${origin}${base}/a2a`;
  const authorizeUrl = options.github.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = options.github.tokenUrl ?? 'https://github.com/login/oauth/access_token';
  const userUrl = options.github.userUrl ?? 'https://api.github.com/user';
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  if (Buffer.byteLength(options.sessionSecret, 'utf8') < 32) {
    throw new Error('Slotlock dashboard sessionSecret must be at least 32 bytes');
  }
  const secret = Buffer.from(options.sessionSecret, 'utf8');
  const allowed = (uid: string) =>
    options.allowedUsers === '*' || options.allowedUsers.includes(uid);

  function seal(context: string, payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const mac = createHmac('sha256', secret).update(`${context}.${body}`).digest('base64url');
    return `${body}.${mac}`;
  }

  function unseal(context: string, value: string | undefined): Record<string, unknown> | null {
    if (value === undefined || value.length > MAX_COOKIE_CHARACTERS) return null;
    const [body, mac, ...rest] = value.split('.');
    if (!body || !mac || rest.length > 0 || !BASE64URL.test(body) || !BASE64URL.test(mac)) {
      return null;
    }
    const expected = createHmac('sha256', secret).update(`${context}.${body}`).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!isRecord(payload) || typeof payload.exp !== 'number' || payload.exp <= now()) return null;
    return payload;
  }

  function readSession(request: Request): Session | null {
    const payload = unseal('slotlock-dashboard-session-v1', readCookies(request).get(SESSION_COOKIE));
    if (
      !payload ||
      typeof payload.uid !== 'string' ||
      typeof payload.login !== 'string' ||
      typeof payload.sid !== 'string' ||
      !allowed(payload.uid)
    ) {
      return null;
    }
    return payload as unknown as Session;
  }

  const csrfToken = (session: Session) =>
    createHmac('sha256', secret).update(`slotlock-dashboard-csrf-v1.${session.sid}`).digest('base64url');
  const tenantOf = (session: Session) => `github:${session.uid}`;

  function respond(
    status: number,
    body: string | Html,
    headers: Record<string, string> = {},
    cookies: string[] = [],
  ): Response {
    const response = new Response(String(body), {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': REFERRER_POLICY,
        'Cross-Origin-Opener-Policy': 'same-origin',
        ...headers,
      },
    });
    for (const value of cookies) response.headers.append('Set-Cookie', value);
    return response;
  }

  const redirect = (status: number, location: string, cookies: string[] = []) =>
    respond(status, '', { Location: location }, cookies);

  function layout(title: string, content: Html, session: Session | null): Html {
    const account = session
      ? html`<div class="account"><span class="login">@${session.login}</span>
          <form method="post" action="${root}/sign-out"><input type="hidden" name="csrf" value="${csrfToken(session)}"><button class="link" type="submit">Sign out</button></form></div>`
      : html``;
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${REFERRER_POLICY}">
<title>${title} · Slotlock</title>
<link rel="stylesheet" href="${root}/style.css?v=${ASSET_VERSIONS.css}">
<script src="${root}/app.js?v=${ASSET_VERSIONS.js}" defer></script>
</head>
<body>
<header class="bar"><a class="brand" href="${root}"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M8 46 L26 14 L56 44"></path></svg><span class="name">Slotlock</span> <span class="by">by Pylota</span></a>${account}</header>
<main>${content}</main>
</body>
</html>`;
  }

  function signedOutPage(status: number, notice?: string, cookies: string[] = []): Response {
    const content = html`<section class="hero">
<h1>Your agents' calendar keys</h1>
<p>Sign in with GitHub to create API keys for the Slotlock tools, add the resources your agents book, and connect an MCP or A2A client.</p>
${notice ? html`<p class="notice" role="alert">${notice}</p>` : html``}
<a class="button primary" href="${root}/sign-in">Sign in with GitHub</a>
<p class="fine">Slotlock reads only your public GitHub profile, to know who you are, and keeps nothing from GitHub but your user id and login.</p>
</section>`;
    return respond(status, layout('Sign in', content, null), {}, cookies);
  }

  function keyRows(keys: SlotlockApiKey[], token: string): Html[] {
    return keys.map((key) => {
      const expired = key.expiresAt !== null && key.expiresAt.getTime() <= now();
      const status = key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
      const actions =
        status === 'Active'
          ? html`<details class="act"><summary>Rotate</summary><p>A new secret replaces this one at once. The key keeps its name, access and bookings.</p>
<form method="post" action="${root}/keys/rotate"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="id" value="${key.id}"><button type="submit">Rotate key</button></form></details>
<details class="act danger"><summary>Revoke</summary><p>Requests with this key fail at once. What it booked stays on the calendar.</p>
<form method="post" action="${root}/keys/revoke"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="id" value="${key.id}"><button class="danger" type="submit">Revoke key</button></form></details>`
          : html``;
      return html`<tr>
<td data-label="Name">${key.name}</td>
<td data-label="Key"><code>${key.prefix}…</code></td>
<td data-label="Access">${key.scopes.includes('write') ? 'Read and write' : 'Read only'}</td>
<td data-label="Created">${formatDate(key.createdAt)}</td>
<td data-label="Last used">${key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</td>
<td data-label="Expires">${key.expiresAt ? formatDate(key.expiresAt) : 'Never'}</td>
<td data-label="Status"><span class="status ${status.toLowerCase()}">${status}</span></td>
<td class="actions">${actions}</td>
</tr>`;
    });
  }

  async function dashboardPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const tenantRef = tenantOf(session);
    const [keys, resources] = await Promise.all([
      options.keys.list({ tenantRef }),
      options.resources.list(tenantRef),
    ]);
    const token = csrfToken(session);
    const rules = options.availability ?? [];
    const days = (rrule: string) =>
      (/BYDAY=([A-Z,]+)/.exec(rrule)?.[1] ?? '')
        .split(',')
        .map((day) => WEEKDAY_NAMES[day] ?? day)
        .join(', ');
    const content = html`${notice ? html`<p class="notice" role="alert">${notice}</p>` : html``}
<section class="card">
<h2>Connect an agent</h2>
<p>Agents call Slotlock over MCP or A2A with one of your keys: <code>Authorization: Bearer slk_…</code>.</p>
<dl class="endpoints"><dt>MCP</dt><dd><code>${mcpUrl}</code></dd><dt>A2A</dt><dd><code>${a2aUrl}</code></dd></dl>
</section>
<section>
<div class="head"><div><h2>API keys</h2><p>Each key acts in your calendar only. Give every agent its own, with the least access it needs.</p></div></div>
<form class="create" method="post" action="${root}/keys">
<input type="hidden" name="csrf" value="${token}">
<label>Name<input name="name" required maxlength="100" placeholder="Booking agent"></label>
<label>Access<select name="access"><option value="read_write">Read and write</option><option value="read">Read only</option></select></label>
<label>Expires<select name="expires"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="never">Never</option></select></label>
<button class="primary" type="submit">Create key</button>
</form>
${
  keys.length === 0
    ? html`<p class="empty">No keys yet. Create one to connect an agent.</p>`
    : html`<div class="table"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${keyRows(keys, token)}</tbody></table></div>`
}
</section>
<section>
<div class="head"><div><h2>Resources</h2><p>What your agents book: a car, a room, a person, a machine. Up to ${SLOTLOCK_DASHBOARD_MAX_RESOURCES}.</p></div></div>
<form class="create" method="post" action="${root}/resources">
<input type="hidden" name="csrf" value="${token}">
<label>Reference<input name="reference" required maxlength="200" placeholder="vehicle-42"></label>
<label>Time zone<input name="timezone" required maxlength="64" value="UTC" placeholder="Europe/London"></label>
<button type="submit">Add resource</button>
</form>
${
  resources.length === 0
    ? html`<p class="empty">No resources yet. Agents can only book what is listed here.</p>`
    : html`<div class="table"><table><thead><tr><th>Reference</th><th>Time zone</th><th>Resource id</th></tr></thead><tbody>${resources.map(
        (resource) =>
          html`<tr><td data-label="Reference">${resource.externalRef ?? ''}</td><td data-label="Time zone">${resource.timezone}</td><td data-label="Resource id"><code>${resource.id}</code></td></tr>`,
      )}</tbody></table></div>`
}
</section>
<section>
<h2>Bookable hours</h2>
${
  rules.length === 0
    ? html`<p class="empty">This server offers no bookable hours, so agents will find no free slot.</p>`
    : html`<ul class="hours">${rules.map(
        (rule) =>
          html`<li>${days(rule.rrule)}: ${hoursOf(rule.startMinutes, rule.durationMinutes)}</li>`,
      )}</ul>`
}
<p class="fine">Set by the server for every resource, in each resource's own time zone.</p>
</section>`;
    return respond(status, layout('Dashboard', content, session));
  }

  function shownOncePage(session: Session, key: string, apiKey: SlotlockApiKey, rotated: boolean): Response {
    const content = html`<section class="card once">
<h1>${rotated ? 'Key rotated' : 'Key created'}: ${apiKey.name}</h1>
<p class="notice warn" role="alert">Copy this key now. Slotlock keeps only its fingerprint, so it will not be shown again.${rotated ? ' The old key no longer works.' : ''}</p>
<div class="copy"><input id="key" readonly value="${key}" aria-label="API key"><button type="button" data-copy="key">Copy</button></div>
<h2>Add it to an MCP client</h2>
<pre><code id="command">claude mcp add --transport http slotlock ${mcpUrl} \\
  --header "Authorization: Bearer ${key}"</code></pre>
<p>Keep the key in a secret manager. Rotate it if it leaks; revoke it when the agent is retired.</p>
<a class="button primary" href="${root}">Done</a>
</section>`;
    return respond(200, layout('Your new key', content, session));
  }

  async function startSignIn(): Promise<Response> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const target = new URL(authorizeUrl);
    target.search = new URLSearchParams({
      client_id: options.github.clientId,
      redirect_uri: callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const sealed = seal('slotlock-dashboard-sign-in-v1', {
      state,
      verifier,
      exp: now() + SIGN_IN_TTL_MS,
    });
    return redirect(302, target.href, [setCookie(SIGN_IN_COOKIE, sealed, SIGN_IN_TTL_MS / 1000)]);
  }

  async function exchangeCode(code: string, verifier: string): Promise<string | null> {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: options.github.clientId,
        client_secret: options.github.clientSecret,
        code,
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    const token = isRecord(body) ? body.access_token : undefined;
    return typeof token === 'string' && token.length > 0 && token.length <= 1_000 ? token : null;
  }

  async function readGitHubUser(token: string): Promise<{ uid: string; login: string } | null> {
    const response = await fetchImpl(userUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    if (
      !isRecord(body) ||
      !Number.isSafeInteger(body.id) ||
      (body.id as number) <= 0 ||
      typeof body.login !== 'string' ||
      !GITHUB_LOGIN.test(body.login)
    ) {
      return null;
    }
    return { uid: String(body.id), login: body.login };
  }

  async function finishSignIn(request: Request, url: URL): Promise<Response> {
    const clearSignIn = setCookie(SIGN_IN_COOKIE, '', 0);
    const pending = unseal('slotlock-dashboard-sign-in-v1', readCookies(request).get(SIGN_IN_COOKIE));
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (
      url.searchParams.has('error') ||
      !pending ||
      typeof pending.state !== 'string' ||
      typeof pending.verifier !== 'string' ||
      code === null ||
      code.length === 0 ||
      code.length > 512 ||
      state === null ||
      !safeEqual(state, pending.state)
    ) {
      return signedOutPage(400, 'That sign-in did not finish here, or took too long. Sign in again.', [
        clearSignIn,
      ]);
    }
    const token = await exchangeCode(code, pending.verifier).catch(() => null);
    const user = token === null ? null : await readGitHubUser(token).catch(() => null);
    if (!user) {
      return signedOutPage(502, 'GitHub did not complete the sign-in. Try again.', [clearSignIn]);
    }
    if (!allowed(user.uid)) {
      return signedOutPage(403, `This Slotlock server does not let @${user.login} sign in.`, [
        clearSignIn,
      ]);
    }
    const session = seal('slotlock-dashboard-session-v1', {
      uid: user.uid,
      login: user.login,
      sid: randomBytes(24).toString('base64url'),
      exp: now() + SESSION_TTL_MS,
    });
    return redirect(303, root, [clearSignIn, setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000)]);
  }

  async function readForm(request: Request): Promise<URLSearchParams | null> {
    const type = request.headers.get('content-type')?.split(';')[0]?.trim();
    if (type !== 'application/x-www-form-urlencoded') return null;
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_FORM_BYTES) return null;
    return new URLSearchParams(text);
  }

  async function createKey(session: Session, form: URLSearchParams): Promise<Response> {
    const scopes = KEY_ACCESS[form.get('access') ?? ''];
    const expiry = form.get('expires') ?? '';
    if (!scopes || !Object.hasOwn(KEY_EXPIRY_DAYS, expiry)) {
      return dashboardPage(session, 400, 'Choose an access level and an expiry from the lists.');
    }
    const days = KEY_EXPIRY_DAYS[expiry];
    try {
      const created = await options.keys.create({
        tenantRef: tenantOf(session),
        name: form.get('name') ?? '',
        scopes,
        createdBy: tenantOf(session),
        ...(typeof days === 'number' ? { expiresAt: new Date(now() + days * DAY_MS) } : {}),
      });
      return shownOncePage(session, created.key, created.apiKey, false);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_api_key_name') {
        return dashboardPage(session, 400, 'Give the key a name of 1 to 100 characters.');
      }
      if (code === 'api_key_limit_reached') {
        return dashboardPage(session, 409, 'You have as many keys as Slotlock allows. Revoke one first.');
      }
      throw error;
    }
  }

  async function changeKey(session: Session, form: URLSearchParams, change: 'rotate' | 'revoke') {
    const id = form.get('id') ?? '';
    if (!UUID_PATTERN.test(id)) return dashboardPage(session, 404, 'That key is not one of yours.');
    if (change === 'rotate') {
      const rotated = await options.keys.rotate({ tenantRef: tenantOf(session), id });
      if (!rotated) return dashboardPage(session, 404, 'That key is not an active key of yours.');
      return shownOncePage(session, rotated.key, rotated.apiKey, true);
    }
    const revoked = await options.keys.revoke({ tenantRef: tenantOf(session), id });
    if (!revoked) return dashboardPage(session, 404, 'That key is not one of yours.');
    return redirect(303, root);
  }

  async function addResource(session: Session, form: URLSearchParams): Promise<Response> {
    const reference = (form.get('reference') ?? '').trim();
    const timezone = (form.get('timezone') ?? '').trim();
    if (reference.length === 0 || reference.length > 200) {
      return dashboardPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
    }
    const tenantRef = tenantOf(session);
    const existing = await options.resources.list(tenantRef);
    if (
      existing.length >= SLOTLOCK_DASHBOARD_MAX_RESOURCES &&
      !existing.some((resource) => resource.externalRef === reference)
    ) {
      return dashboardPage(
        session,
        409,
        `You have ${SLOTLOCK_DASHBOARD_MAX_RESOURCES} resources, as many as the dashboard allows.`,
      );
    }
    try {
      await options.resources.add(tenantRef, reference, timezone);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_timezone') {
        return dashboardPage(session, 400, `${timezone} is not a time zone Slotlock knows, such as Europe/London.`);
      }
      if (code === 'invalid_external_ref') {
        return dashboardPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
      }
      throw error;
    }
    return redirect(303, root);
  }

  async function handlePost(request: Request, route: string): Promise<Response> {
    // A browser sends Origin with every form POST; anything else did not come from these pages.
    if (request.headers.get('origin') !== origin) {
      return respond(403, layout('Refused', html`<p class="notice">That request did not come from this dashboard.</p>`, null));
    }
    const session = readSession(request);
    if (!session) return redirect(303, root);
    const form = await readForm(request);
    if (!form) return respond(400, layout('Refused', html`<p class="notice">That form could not be read.</p>`, session));
    const presented = form.get('csrf') ?? '';
    if (!safeEqual(presented, csrfToken(session))) {
      return respond(403, layout('Refused', html`<p class="notice">That form has expired. Go back and try again.</p>`, session));
    }
    switch (route) {
      case '/sign-out':
        return redirect(303, root, [setCookie(SESSION_COOKIE, '', 0)]);
      case '/keys':
        return createKey(session, form);
      case '/keys/rotate':
        return changeKey(session, form, 'rotate');
      case '/keys/revoke':
        return changeKey(session, form, 'revoke');
      case '/resources':
        return addResource(session, form);
      default:
        return respond(404, layout('Not found', html`<p class="notice">Nothing is here.</p>`, session));
    }
  }

  return {
    handles(request) {
      const { pathname } = new URL(request.url);
      return pathname === root || pathname.startsWith(`${root}/`);
    },

    async fetch(request) {
      const url = new URL(request.url);
      const route = url.pathname.slice(root.length).replace(/\/$/, '') || '/';
      try {
        if (request.method === 'GET') {
          switch (route) {
            case '/': {
              const session = readSession(request);
              return session ? await dashboardPage(session) : signedOutPage(200);
            }
            case '/style.css':
              return asset(DASHBOARD_CSS, 'text/css; charset=utf-8', url, ASSET_VERSIONS.css);
            case '/app.js':
              return asset(DASHBOARD_JS, 'text/javascript; charset=utf-8', url, ASSET_VERSIONS.js);
            case '/sign-in':
              return await startSignIn();
            case '/callback':
              return await finishSignIn(request, url);
            default:
              return respond(404, layout('Not found', html`<p class="notice">Nothing is here.</p>`, null));
          }
        }
        if (request.method === 'POST') return await handlePost(request, route);
        return respond(405, layout('Not allowed', html`<p class="notice">Use the dashboard's pages and forms.</p>`, null), {
          Allow: 'GET, POST',
        });
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // A failing reporter must not change the response.
        }
        return respond(500, layout('Error', html`<p class="notice">Something went wrong. Try again in a moment.</p>`, null));
      }
    },
  };
}

// Copies the value of the element a button names. Loaded as a file, so the policy needs no inline code.
const DASHBOARD_JS = `document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
  if (!button) return;
  const field = document.getElementById(button.getAttribute('data-copy'));
  if (!field) return;
  const selectIt = () => {
    if (typeof field.select === 'function') field.select();
    button.textContent = 'Selected: press Ctrl+C or Cmd+C';
  };
  if (!navigator.clipboard) return selectIt();
  navigator.clipboard.writeText(field.value ?? field.textContent ?? '').then(() => {
    button.textContent = 'Copied';
  }, selectIt);
});
`;

const DASHBOARD_CSS = `:root {
  --ink: #0b0d12; --ink-2: #3a3f4b; --ink-3: #6b7180; --line: #e6e8ee; --paper: #ffffff; --wash: #f6f7f9;
  --accent: #2655ff; --accent-ink: #ffffff; --danger: #c62828; --warn: #8a5a00; --warn-wash: #fff6e0;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #eef0f5; --ink-2: #c3c7d1; --ink-3: #8b91a0; --line: #2a2e38; --paper: #0e1016; --wash: #161922;
    --accent: #6f8cff; --accent-ink: #0b0d12; --danger: #ff6b6b; --warn: #ffcf70; --warn-wash: #2b2410; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, input[readonly] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); text-decoration: none; }
.mark { width: 20px; height: 20px; fill: none; stroke: var(--accent); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
.name { font-weight: 650; font-size: 16px; }
.by { color: var(--ink-3); font-size: 12px; }
.account { display: flex; align-items: center; gap: 12px; color: var(--ink-2); }
.account form { margin: 0; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; display: grid; gap: 40px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0 0 6px; }
p { margin: 0 0 12px; color: var(--ink-2); }
.fine { font-size: 13px; color: var(--ink-3); }
.hero { max-width: 560px; margin: 48px auto; text-align: center; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 20px; background: var(--wash); }
.head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 12px; }
.endpoints { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 12px 0 0; }
.endpoints dt { color: var(--ink-3); }
.endpoints dd { margin: 0; overflow-wrap: anywhere; }
.create { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 0 0 16px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--ink-2); }
input, select { font: inherit; height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); min-width: 0; }
button, .button { font: inherit; font-weight: 600; height: 38px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.danger { border-color: var(--danger); color: var(--danger); }
button.link { border: 0; background: none; padding: 0; height: auto; color: var(--ink-2); font-weight: 500; text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--ink-3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--wash); }
tr:last-child td { border-bottom: 0; }
.status { justify-self: start; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--wash); }
.status.active { color: var(--accent); }
.status.revoked, .status.expired { color: var(--ink-3); }
.actions { white-space: nowrap; }
.act { display: inline-block; margin-right: 8px; }
.act summary { cursor: pointer; color: var(--ink-2); }
.act.danger summary { color: var(--danger); }
.act[open] { display: block; max-width: 280px; white-space: normal; }
.act p { font-size: 13px; margin: 8px 0; }
.notice { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--wash); color: var(--ink); }
.notice.warn { background: var(--warn-wash); color: var(--warn); border-color: transparent; }
.empty { color: var(--ink-3); }
.once { max-width: 720px; }
.copy { display: flex; gap: 8px; margin: 12px 0 20px; }
.copy input { flex: 1; }
pre { background: var(--wash); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.hours { margin: 0 0 8px; padding-left: 20px; color: var(--ink-2); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 720px) {
  .bar { padding: 12px 16px; }
  main { padding: 24px 16px 48px; }
  thead { display: none; }
  table, tbody, tr, td { display: block; }
  tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
  td { border: 0; padding: 3px 12px; }
  td[data-label] { display: grid; grid-template-columns: 88px 1fr; gap: 8px; }
  td[data-label]::before { content: attr(data-label); font-size: 12px; color: var(--ink-3); padding-top: 2px; }
}
`;

const ASSET_VERSIONS = Object.freeze({
  css: createHash('sha256').update(DASHBOARD_CSS).digest('base64url').slice(0, 12),
  js: createHash('sha256').update(DASHBOARD_JS).digest('base64url').slice(0, 12),
});
