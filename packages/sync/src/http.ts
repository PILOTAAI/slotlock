// The sync's HTTP surface (RFC 0004 C1). Two kinds of caller:
//
// - The operator (whoever runs the sync for Slotlock's tenants), with a bearer token: keeps each
//   tenant's Slotlock key, makes connect links, connects iCalendar URLs, maps calendars, lists and
//   removes connections, and runs a pass on demand.
// - A tenant's person, with a connect link the operator made (signed, for one tenant and provider,
//   valid 30 minutes): sent to Google or Microsoft, back to /oauth/callback, then shown the account's
//   calendars to choose which feeds which resource. The choice form is signed for that connection.
//
// Pages carry no script or style, a strict Content-Security-Policy, and no referrer (the callback's
// URL holds the provider's code).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthProvider } from './oauth.js';
import type { ProviderCalendar } from './providers.js';
import { type SlotlockResourceSummary, withoutTrailingSlashes } from './slotlock-api.js';
import type { SyncStore } from './store.js';
import type { Syncer } from './syncer.js';

export interface SyncHttpOptions {
  syncer: Syncer;
  store: SyncStore;
  /** The operator's bearer token: at least 32 characters. */
  adminToken: string;
  /** Signs connect links and the calendar form: at least 32 bytes, random. */
  linkSecret: string;
  /** This server's public origin (https), as links and OAuth redirects name it. */
  publicUrl: string;
  now?: () => Date;
}

/** How long a connect link, and the calendar form after it, may be used. */
const LINK_TTL_MS = 30 * 60 * 1_000;
const TENANT_REF = /^[^\s\u0000-\u001f\u007f]{1,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] as string);

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

const refusal = (code: string, status: number) => json({ error: { code } }, status);

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSyncHttpHandler(options: SyncHttpOptions): (request: Request) => Promise<Response> {
  if (options.adminToken.length < 32) throw new TypeError('The sync admin token must be at least 32 characters');
  if (Buffer.byteLength(options.linkSecret) < 32) throw new TypeError('The sync link secret must be at least 32 bytes');
  const publicUrl = withoutTrailingSlashes(options.publicUrl);
  if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl)) {
    throw new TypeError('The sync public URL must be https (or http on localhost)');
  }
  const now = options.now ?? (() => new Date());
  const sign = (purpose: string, payload: string) =>
    createHmac('sha256', options.linkSecret).update(`${purpose}\n${payload}`).digest('base64url');

  /** A connect link: the tenant, provider and write-back, until when, signed. */
  function connectLink(tenantRef: string, provider: OAuthProvider, writeBack: boolean): { url: string; expiresAt: Date } {
    const expiresAt = new Date(now().getTime() + LINK_TTL_MS);
    // Its own id: a link is followed once (claimLink), so one forwarded or found later is refused.
    const payload = Buffer.from(
      JSON.stringify({ t: tenantRef, p: provider, w: writeBack, e: expiresAt.getTime(), n: randomBytes(18).toString('base64url') }),
    ).toString('base64url');
    return { url: `${publicUrl}/connect?link=${payload}.${sign('connect', payload)}`, expiresAt };
  }

  function readLink(
    link: string | null,
  ): { tenantRef: string; provider: OAuthProvider; writeBack: boolean; linkId: string; expiresAt: Date } | null {
    const [payload, signature, ...rest] = (link ?? '').split('.');
    if (!payload || !signature || rest.length > 0 || !sameSecret(signature, sign('connect', payload))) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        t?: unknown;
        p?: unknown;
        w?: unknown;
        e?: unknown;
        n?: unknown;
      };
      if (typeof value.t !== 'string' || (value.p !== 'google' && value.p !== 'microsoft') || typeof value.w !== 'boolean') return null;
      if (typeof value.e !== 'number' || value.e < now().getTime()) return null;
      if (typeof value.n !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.n)) return null;
      return { tenantRef: value.t, provider: value.p, writeBack: value.w, linkId: value.n, expiresAt: new Date(value.e) };
    } catch {
      return null;
    }
  }

  /** The cookie that ties a flow to the browser that began it: sent back only to the callback. */
  const FLOW_COOKIE = 'slotlock_sync_flow';
  const secureCookie = publicUrl.startsWith('https://') ? '; Secure' : '';
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const flowCookie = (request: Request): string | null => {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === FLOW_COOKIE && value.length > 0) return value.join('=');
    }
    return null;
  };

  const formToken = (connectionId: string, expires: number) => sign('choose', `${connectionId}\n${expires}`);

  function choosePage(connectionId: string, account: string, calendars: ProviderCalendar[], resources: SlotlockResourceSummary[]): Response {
    if (resources.length === 0) return page('No resources yet', '<p>The tenant has no resources to put this calendar\'s time on.</p>');
    const expires = now().getTime() + LINK_TTL_MS;
    const options = (selected: string) =>
      [`<option value="">Not used</option>`]
        .concat(
          resources.map(
            (resource) =>
              `<option value="${escapeHtml(resource.id)}"${resource.id === selected ? ' selected' : ''}>${escapeHtml(resource.name ?? resource.externalRef)}</option>`,
          ),
        )
        .join('');
    const rows = calendars
      .slice(0, 100)
      .map(
        (calendar, index) =>
          `<p><label>${escapeHtml(calendar.name)}${calendar.primary ? ' (main calendar)' : ''}<br>` +
          `<input type="hidden" name="calendar_${index}" value="${escapeHtml(calendar.id)}">` +
          `<select name="resource_${index}">${options('')}</select></label></p>`,
      )
      .join('');
    return page(
      'Choose calendars',
      `<p>Connected: ${escapeHtml(account)}. Choose the resource whose time each calendar's busy time blocks.</p>` +
        `<form method="post" action="${escapeHtml(`${publicUrl}/connections/${connectionId}/choose`)}">` +
        `<input type="hidden" name="expires" value="${expires}"><input type="hidden" name="token" value="${formToken(connectionId, expires)}">` +
        `${rows}<p><button type="submit">Save</button></p></form>`,
    );
  }

  async function operator(request: Request, url: URL): Promise<Response> {
    const auth = request.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), options.adminToken)) return refusal('unauthorized', 401);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const body = async () => {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
      try {
        return (await request.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    // /v1/tenants/{tenant}[/...]
    if (parts[1] === 'tenants' && parts[2] !== undefined && TENANT_REF.test(parts[2])) {
      const tenantRef = parts[2];
      if (parts.length === 3 && request.method === 'PUT') {
        const input = await body();
        if (typeof input?.api_key !== 'string' || input.api_key.length < 16 || input.api_key.length > 500) return refusal('invalid_arguments', 400);
        await options.syncer.putTenant({ tenantRef, apiKey: input.api_key });
        return json({ tenant_ref: tenantRef });
      }
      if (!(await options.store.getTenant(tenantRef))) return refusal('tenant_not_found', 404);
      if (parts[3] === 'connect-links' && parts.length === 4 && request.method === 'POST') {
        const input = await body();
        if ((input?.provider !== 'google' && input?.provider !== 'microsoft') || typeof input.write_back !== 'boolean') {
          return refusal('invalid_arguments', 400);
        }
        const link = connectLink(tenantRef, input.provider, input.write_back);
        return json({ url: link.url, expires_at: link.expiresAt.toISOString() });
      }
      if (parts[3] === 'ics' && parts.length === 4 && request.method === 'POST') {
        const input = await body();
        if (typeof input?.url !== 'string' || input.url.length > 2048) return refusal('invalid_arguments', 400);
        try {
          const connection = await options.syncer.connectIcs({ tenantRef, url: input.url });
          return json({ connection: { id: connection.id, provider: connection.provider, account: connection.account } }, 201);
        } catch {
          return refusal('invalid_url', 400);
        }
      }
      if (parts[3] === 'connections' && parts.length === 4 && request.method === 'GET') {
        const connections = [];
        for (const connection of await options.store.listConnections(tenantRef)) {
          const mappings = await options.store.listMappings({ connectionId: connection.id });
          connections.push({
            id: connection.id,
            provider: connection.provider,
            account: connection.account,
            write_back: connection.writeBack,
            mappings: mappings.map((mapping) => ({
              id: mapping.id,
              calendar_id: mapping.calendarId,
              resource_id: mapping.resourceId,
              source: mapping.source,
              last_synced_at: mapping.lastSyncedAt?.toISOString() ?? null,
              last_error: mapping.lastError,
              retry_at: mapping.retryAt?.toISOString() ?? null,
            })),
          });
        }
        return json({ connections });
      }
      return refusal('not_found', 404);
    }
    // /v1/connections/{id}[/mappings]
    if (parts[1] === 'connections' && parts[2] !== undefined && UUID.test(parts[2])) {
      const connection = await options.store.getConnection(parts[2]);
      if (!connection) return refusal('connection_not_found', 404);
      if (parts.length === 3 && request.method === 'DELETE') {
        const result = await options.syncer.disconnect(connection.id);
        return json(result);
      }
      if (parts[3] === 'mappings' && parts.length === 4 && request.method === 'POST') {
        const input = await body();
        if (typeof input?.calendar_id !== 'string' || typeof input.resource_id !== 'string' || !UUID.test(input.resource_id)) {
          return refusal('invalid_arguments', 400);
        }
        const mapping = await options.syncer.mapCalendar({
          connectionId: connection.id,
          calendarId: input.calendar_id,
          resourceId: input.resource_id,
        });
        return json({ mapping: { id: mapping.id, calendar_id: mapping.calendarId, resource_id: mapping.resourceId, source: mapping.source } }, 201);
      }
      return refusal('not_found', 404);
    }
    if (url.pathname === '/v1/run' && request.method === 'POST') {
      const synced = await options.syncer.syncAll();
      const written = await options.syncer.writeBackChanges();
      return json({
        synced: synced.filter((result) => result.ok).length,
        unsynced: synced.filter((result) => !result.ok).length,
        written: written.written,
        failed_tenants: written.failed,
        reconciled_tenants: written.reconciled,
      });
    }
    return refusal('not_found', 404);
  }

  return async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
      if (url.pathname.startsWith('/v1/')) return await operator(request, url);
      if (url.pathname === '/connect' && request.method === 'GET') {
        const link = readLink(url.searchParams.get('link'));
        if (!link) return page('This link has expired', '<p>Ask for a new link to connect your calendar.</p>', 400);
        // Followed once: whoever opens it again, or after it was forwarded, is asked for a new one.
        if (!(await options.store.claimLink(link.linkId, link.expiresAt))) {
          return page('This link was used', '<p>Each link connects a calendar once. Ask for a new link.</p>', 400);
        }
        // Finished only in this browser, so the provider's page cannot be handed to someone else.
        const browser = randomBytes(32).toString('base64url');
        const { url: to } = await options.syncer.beginConnection({
          tenantRef: link.tenantRef,
          provider: link.provider,
          writeBack: link.writeBack,
          browserHash: digest(browser),
        });
        return new Response(null, {
          status: 302,
          headers: {
            location: to,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'set-cookie': `${FLOW_COOKIE}=${browser}; Path=/oauth/callback; Max-Age=600; HttpOnly; SameSite=Lax${secureCookie}`,
          },
        });
      }
      if (url.pathname === '/oauth/callback' && request.method === 'GET') {
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !state || !code) {
          return page('Not connected', '<p>The calendar was not connected. You can close this page and try the link again.</p>', 400);
        }
        const browser = flowCookie(request);
        if (!browser) {
          return page('Open the link in this browser', '<p>Connect from the browser you opened the link in, or ask for a new link.</p>', 400);
        }
        let finished: Awaited<ReturnType<Syncer['finishConnection']>>;
        try {
          finished = await options.syncer.finishConnection({ state, code, browserHash: digest(browser) });
        } catch {
          return page('This link has expired', '<p>Ask for a new link to connect your calendar.</p>', 400);
        }
        const resources = await options.syncer.listResources(finished.connection.tenantRef);
        const chosen = choosePage(finished.connection.id, finished.connection.account, finished.calendars, resources);
        chosen.headers.append('set-cookie', `${FLOW_COOKIE}=; Path=/oauth/callback; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie}`);
        return chosen;
      }
      const choose = /^\/connections\/([0-9a-f-]{36})\/choose$/.exec(url.pathname);
      if (choose && request.method === 'POST') {
        const connection = UUID.test(choose[1] as string) ? await options.store.getConnection(choose[1] as string) : null;
        const form = new URLSearchParams(await request.text());
        const expires = Number(form.get('expires'));
        const token = form.get('token') ?? '';
        if (!connection || !Number.isSafeInteger(expires) || expires < now().getTime() || !sameSecret(token, formToken(connection.id, expires))) {
          return page('This page has expired', '<p>Ask for a new link to connect your calendar.</p>', 400);
        }
        // Only the connection's own calendars, and the tenant's own resources.
        const calendars = new Map((await options.syncer.listCalendars(connection.id)).map((calendar) => [calendar.id, calendar]));
        const resources = new Map((await options.syncer.listResources(connection.tenantRef)).map((resource) => [resource.id, resource]));
        const saved: string[] = [];
        for (let index = 0; index < 100; index++) {
          const calendarId = form.get(`calendar_${index}`);
          const resourceId = form.get(`resource_${index}`);
          if (calendarId === null) break;
          if (!resourceId) continue;
          const calendar = calendars.get(calendarId);
          const resource = resources.get(resourceId);
          if (!calendar || !resource) continue;
          await options.syncer.mapCalendar({ connectionId: connection.id, calendarId, resourceId });
          saved.push(`<li>${escapeHtml(calendar.name)} → ${escapeHtml(resource.name ?? resource.externalRef)}</li>`);
        }
        return page('Calendars saved', saved.length ? `<ul>${saved.join('')}</ul><p>You can close this page.</p>` : '<p>No calendar was chosen.</p>');
      }
      return refusal('not_found', 404);
    } catch {
      return refusal('internal_error', 500);
    }
  };
}
