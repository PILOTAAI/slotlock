// The adapter's HTTP surface, one URL per tenant: Stripe webhook deliveries
// (`/stripe/webhook/<tenant>`, checked against the tenant's own Stripe signing secret), and
// Slotlock's own (`/slotlock/webhook/<tenant>`, checked against the tenant's Slotlock webhook
// secret) for paid holds that ended without a booking. A delivery it could not finish (Stripe or
// Slotlock unreachable, or a refund not made) answers 500, so it comes again; marking a hold paid
// twice changes nothing, and a refund is made once.
import {
  type PaymentOutcome,
  SlotlockSignatureError,
  type StripePaymentsOptions,
  StripeSignatureError,
  createStripePayments,
} from './payments.js';

export interface StripeTenant {
  stripeSecretKey: string;
  webhookSecret: string;
  slotlockApiKey: string;
  refundRefused?: boolean;
  /**
   * The secret of a Slotlock webhook endpoint pointed at `/slotlock/webhook/<tenant>` for
   * `hold.expired` and `hold.released`: with it, a payment for a hold that ended unbooked is
   * refunded (with refundRefused) as soon as Slotlock says so.
   */
  slotlockWebhookSecret?: string;
}

export interface PaymentsHttpOptions {
  /** Slotlock's REST root (without /v1). */
  slotlockUrl: string;
  /** The tenant's Stripe and Slotlock keys, or null for one this adapter does not serve. */
  tenant(tenantRef: string): Promise<StripeTenant | null>;
  /**
   * What became of each payment, and each failure: a payment refused and not refunded is one a
   * person must look at, so it is said at level error.
   */
  log?: (level: 'info' | 'error', message: string, fields: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function createPaymentsHttpHandler(options: PaymentsHttpOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
    const match = /^\/(stripe|slotlock)\/webhook\/([^/]{1,500})$/.exec(url.pathname);
    if (!match || request.method !== 'POST') return json({ error: { code: 'not_found' } }, 404);
    const from = match[1] as 'stripe' | 'slotlock';
    let tenantRef: string;
    try {
      tenantRef = decodeURIComponent(match[2] as string);
    } catch {
      return json({ error: { code: 'not_found' } }, 404);
    }
    const tenant = await options.tenant(tenantRef);
    const secret = from === 'stripe' ? tenant?.webhookSecret : tenant?.slotlockWebhookSecret;
    // Unknown and unsigned look the same: nothing says which tenants are served.
    if (!tenant || !secret) return json({ error: { code: 'unauthorized' } }, 400);
    const config: StripePaymentsOptions = {
      tenantRef,
      stripeSecretKey: tenant.stripeSecretKey,
      slotlock: { baseUrl: options.slotlockUrl, apiKey: tenant.slotlockApiKey },
      refundRefused: tenant.refundRefused === true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    const payments = createStripePayments(config);
    try {
      const payload = await request.text();
      const outcome: PaymentOutcome | { status: 'ignored' } =
        from === 'stripe'
          ? await payments.handleWebhook({ payload, signatureHeader: request.headers.get('stripe-signature'), webhookSecret: secret })
          : await payments.handleSlotlockWebhook({ payload, headers: request.headers, webhookSecret: secret });
      if (outcome.status === 'refused') {
        options.log?.(outcome.refunded ? 'info' : 'error', outcome.refunded ? 'payment refused and refunded' : 'payment refused and kept: a person must look at it', {
          tenant: tenantRef,
          hold_id: outcome.holdId,
          payment_ref: outcome.paymentRef,
          code: outcome.code,
        });
        return json({ status: outcome.status, code: outcome.code, refunded: outcome.refunded });
      }
      if (outcome.status === 'paid') {
        options.log?.('info', 'payment applied', { tenant: tenantRef, hold_id: outcome.holdId, payment_ref: outcome.paymentRef, replayed: outcome.replayed });
      }
      return json({ status: outcome.status });
    } catch (error) {
      if (error instanceof StripeSignatureError || error instanceof SlotlockSignatureError) {
        return json({ error: { code: 'unauthorized' } }, 400);
      }
      options.log?.('error', 'delivery failed; it comes again', { tenant: tenantRef, from, error: String(error) });
      return json({ error: { code: 'try_again' } }, 500);
    }
  };
}
