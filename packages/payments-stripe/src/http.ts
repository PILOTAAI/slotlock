// The adapter's HTTP surface: Stripe webhook deliveries, one URL per tenant
// (`/stripe/webhook/<tenant>`), each checked against that tenant's own Stripe signing secret. A
// delivery it could not finish (Stripe or Slotlock unreachable) answers 500, so Stripe delivers it
// again; marking a hold paid twice changes nothing.
import { type StripePaymentsOptions, StripeSignatureError, createStripePayments } from './payments.js';

export interface StripeTenant {
  stripeSecretKey: string;
  webhookSecret: string;
  slotlockApiKey: string;
  refundRefused?: boolean;
}

export interface PaymentsHttpOptions {
  /** Slotlock's REST root (without /v1). */
  slotlockUrl: string;
  /** The tenant's Stripe and Slotlock keys, or null for one this adapter does not serve. */
  tenant(tenantRef: string): Promise<StripeTenant | null>;
  fetch?: typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function createPaymentsHttpHandler(options: PaymentsHttpOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
    const match = /^\/stripe\/webhook\/([^/]{1,500})$/.exec(url.pathname);
    if (!match || request.method !== 'POST') return json({ error: { code: 'not_found' } }, 404);
    let tenantRef: string;
    try {
      tenantRef = decodeURIComponent(match[1] as string);
    } catch {
      return json({ error: { code: 'not_found' } }, 404);
    }
    const tenant = await options.tenant(tenantRef);
    // Unknown and unsigned look the same: nothing says which tenants are served.
    if (!tenant) return json({ error: { code: 'unauthorized' } }, 400);
    const config: StripePaymentsOptions = {
      stripeSecretKey: tenant.stripeSecretKey,
      slotlock: { baseUrl: options.slotlockUrl, apiKey: tenant.slotlockApiKey },
      refundRefused: tenant.refundRefused === true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    try {
      const outcome = await createStripePayments(config).handleWebhook({
        payload: await request.text(),
        signatureHeader: request.headers.get('stripe-signature'),
        webhookSecret: tenant.webhookSecret,
      });
      return json({ status: outcome.status });
    } catch (error) {
      if (error instanceof StripeSignatureError) return json({ error: { code: 'unauthorized' } }, 400);
      return json({ error: { code: 'try_again' } }, 500);
    }
  };
}
