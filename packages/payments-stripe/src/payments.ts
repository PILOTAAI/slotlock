// @slotlock/payments-stripe (RFC 0004 C3): a hold that waits for payment is marked paid once a
// PaymentIntent on the tenant's own Stripe account is verified to have succeeded for it. Slotlock
// records payment state and never moves money; this adapter reads Stripe with the tenant's key and
// tells Slotlock `POST /v1/holds/{hold_id}/paid`. A payment for a hold that expired first is
// answered as such, and refunded when asked, since its time may be someone else's by then.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The Stripe API version requests pin (as Slotlock's billing does). */
export const STRIPE_API_VERSION = '2026-04-22.dahlia';

/** The PaymentIntent metadata key that names the hold it pays for. */
export const HOLD_METADATA_KEY = 'slotlock_hold_id';

/** Refusals that prove a payment was not applied to its hold: only these are refunded. */
const REFUNDABLE = new Set(['hold_expired', 'payment_conflict', 'payment_amount_mismatch']);

/** A URL without its trailing slashes, in one pass from the end (a `/\/+$/` replace backtracks). */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

const HOLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a Stripe webhook delivery was refused: not from Stripe, or not now. */
export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

/**
 * Check a Stripe webhook delivery's `Stripe-Signature` header against the endpoint's signing secret
 * (`whsec_...`): one of its v1 signatures must be the HMAC-SHA256 of `<t>.<payload>`, and `t`
 * within `toleranceSeconds` (default 300) of now. Pass the payload exactly as received.
 */
export function verifyStripeSignature(params: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): void {
  if (!params.header) throw new StripeSignatureError('The delivery has no Stripe-Signature header');
  const parts = params.header.split(',').map((part) => part.trim().split('=', 2) as [string, string | undefined]);
  const timestamp = Number(parts.find(([name]) => name === 't')?.[1]);
  const now = (params.now ?? new Date()).getTime() / 1_000;
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > (params.toleranceSeconds ?? 300)) {
    throw new StripeSignatureError('The delivery is too old or too new');
  }
  const expected = createHmac('sha256', params.secret).update(`${timestamp}.${params.payload}`, 'utf8').digest();
  const signed = parts.some(([name, value]) => {
    if (name !== 'v1' || !value || !/^[0-9a-f]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value, 'hex'), expected);
  });
  if (!signed) throw new StripeSignatureError('The delivery is not signed with this secret');
}

/** What became of a payment. */
export type PaymentOutcome =
  /** Recorded on the hold; `replayed` when it already was. */
  | { status: 'paid'; holdId: string; paymentRef: string; replayed: boolean }
  /** Stripe does not say it succeeded (yet), or it names no hold. */
  | { status: 'not_paid'; reason: 'not_succeeded' | 'no_hold' | 'not_found' }
  /** Slotlock refused it: the hold expired, was booked, was paid by another payment, or needs none. */
  | { status: 'refused'; holdId: string; paymentRef: string; code: string; refunded: boolean };

export interface StripePaymentsOptions {
  /** The tenant's own Stripe secret key (a restricted key that reads PaymentIntents, and refunds if asked). */
  stripeSecretKey: string;
  /** Slotlock's REST root (without /v1), and the tenant's admin key. */
  slotlock: { baseUrl: string; apiKey: string };
  /** Refund a succeeded payment whose hold Slotlock refused (expired, say). Default false. */
  refundRefused?: boolean;
  fetch?: typeof fetch;
}

export function createStripePayments(options: StripePaymentsOptions) {
  const send = options.fetch ?? fetch;
  const stripe = async (path: string, post?: { form: Record<string, string>; idempotencyKey: string }) => {
    const response = await send(`https://api.stripe.com/v1${path}`, {
      method: post ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${options.stripeSecretKey}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(post ? { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': post.idempotencyKey } : {}),
      },
      ...(post ? { body: new URLSearchParams(post.form).toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };

  async function markPaid(
    holdId: string,
    paymentRef: string,
    received: { amount_minor: number; currency: string } | null,
  ): Promise<PaymentOutcome> {
    const response = await send(
      `${withoutTrailingSlashes(options.slotlock.baseUrl)}/v1/holds/${encodeURIComponent(holdId)}/paid`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${options.slotlock.apiKey}`, 'content-type': 'application/json' },
        // What Stripe says was received: Slotlock refuses less than the hold asks for.
        body: JSON.stringify({ payment_ref: paymentRef, ...(received ? { received } : {}) }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as { replayed?: boolean; error?: { code?: string } };
    if (response.ok) return { status: 'paid', holdId, paymentRef, replayed: body.replayed === true };
    const code = body.error?.code ?? `http_${response.status}`;
    // Slotlock is down, or the key refused: not an answer about the hold, so try again later.
    if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 429) {
      throw new Error(`Slotlock answered ${response.status} ${code}`);
    }
    // Refund only what Slotlock says it did not take: a hold that expired first, one paid by another
    // payment, or a payment short of the hold's. Anything else (a hold not found, say) may be a
    // payment already applied, and is left for a person.
    let refunded = false;
    if (options.refundRefused && REFUNDABLE.has(code)) {
      const refund = await stripe('/refunds', { form: { payment_intent: paymentRef }, idempotencyKey: `slotlock-refund-${paymentRef}` });
      refunded = refund.status < 300;
    }
    return { status: 'refused', holdId, paymentRef, code, refunded };
  }

  /** Read a PaymentIntent from Stripe and, if it succeeded for a hold, mark that hold paid. */
  async function confirmPaymentIntent(paymentIntentId: string): Promise<PaymentOutcome> {
    if (!/^pi_[A-Za-z0-9]{1,250}$/.test(paymentIntentId)) return { status: 'not_paid', reason: 'not_found' };
    const read = await stripe(`/payment_intents/${paymentIntentId}`);
    if (read.status === 404) return { status: 'not_paid', reason: 'not_found' };
    if (read.status >= 300) throw new Error(`Stripe answered ${read.status}`);
    return settle(read.body);
  }

  function settle(intent: Record<string, unknown>): Promise<PaymentOutcome> | PaymentOutcome {
    if (intent.object !== 'payment_intent' || typeof intent.id !== 'string') return { status: 'not_paid', reason: 'not_found' };
    const holdId = (intent.metadata as Record<string, unknown> | undefined)?.[HOLD_METADATA_KEY];
    if (typeof holdId !== 'string' || !HOLD_ID.test(holdId)) return { status: 'not_paid', reason: 'no_hold' };
    if (intent.status !== 'succeeded') return { status: 'not_paid', reason: 'not_succeeded' };
    const amount = intent.amount_received;
    const currency = typeof intent.currency === 'string' ? intent.currency.toUpperCase() : null;
    const received =
      Number.isSafeInteger(amount) && currency && /^[A-Z]{3}$/.test(currency)
        ? { amount_minor: amount as number, currency }
        : null;
    return markPaid(holdId, intent.id, received);
  }

  return {
    /** What to put on the PaymentIntent you create for a hold, so its payment finds it. */
    metadataFor(holdId: string): Record<string, string> {
      return { [HOLD_METADATA_KEY]: holdId };
    },

    confirmPaymentIntent,

    /**
     * A delivery to your Stripe webhook endpoint: its signature checked first, then a
     * `payment_intent.succeeded` read back from Stripe (never trusted from the payload alone) and
     * its hold marked paid. Other events are ignored.
     */
    async handleWebhook(params: { payload: string; signatureHeader: string | null; webhookSecret: string }): Promise<
      PaymentOutcome | { status: 'ignored' }
    > {
      verifyStripeSignature({ payload: params.payload, header: params.signatureHeader, secret: params.webhookSecret });
      const event = JSON.parse(params.payload) as { type?: string; data?: { object?: { id?: unknown } } };
      if (event.type !== 'payment_intent.succeeded' || typeof event.data?.object?.id !== 'string') return { status: 'ignored' };
      return confirmPaymentIntent(event.data.object.id);
    },
  };
}
