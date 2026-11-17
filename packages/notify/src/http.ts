// The notifier's HTTP surface: Slotlock's webhook deliveries, one URL per tenant
// (`/webhooks/<tenant>`), each verified with that tenant's webhook secret before its body is read
// as a change. A delivery the notifier could not finish (Slotlock unreachable) answers 503, so
// Slotlock delivers it again; what was already sent is not sent twice.
import type { Notifier } from './notifier.js';
import { WebhookVerificationError, verifySlotlockWebhook } from './webhook.js';

export interface NotifyHttpOptions {
  notifier: Notifier;
  /** The tenant's webhook secret (`whsec_…`), or null for a tenant this notifier does not serve. */
  webhookSecret(tenantRef: string): Promise<string | null>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function createNotifyHttpHandler(options: NotifyHttpOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
    const match = /^\/webhooks\/([^/]{1,500})$/.exec(url.pathname);
    if (!match || request.method !== 'POST') return json({ error: { code: 'not_found' } }, 404);
    let tenantRef: string;
    try {
      tenantRef = decodeURIComponent(match[1] as string);
    } catch {
      return json({ error: { code: 'not_found' } }, 404);
    }
    const secret = await options.webhookSecret(tenantRef);
    // Unknown and unsigned look the same: nothing says which tenants are served.
    if (!secret) return json({ error: { code: 'unauthorized' } }, 401);
    const body = await request.text();
    let change: ReturnType<typeof verifySlotlockWebhook>;
    try {
      change = verifySlotlockWebhook({ secret, headers: request.headers, body });
    } catch (error) {
      if (error instanceof WebhookVerificationError) return json({ error: { code: 'unauthorized' } }, 401);
      return json({ error: { code: 'invalid_body' } }, 400);
    }
    try {
      const result = await options.notifier.handle(tenantRef, change);
      return json(result);
    } catch {
      return json({ error: { code: 'try_again' } }, 503);
    }
  };
}
