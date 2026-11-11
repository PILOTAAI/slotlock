// @slotlock/payments-stripe (RFC 0004 C3): a hold that waits for payment is marked paid once a
// PaymentIntent on the tenant's own Stripe account is verified to have succeeded for it. Slotlock
// records payment state and never moves money; this adapter reads Stripe with the tenant's key and
// tells Slotlock `POST /v1/holds/{hold_id}/paid`. A payment for a hold that expired first is
// answered as such, and refunded when asked, since its time may be someone else's by then.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** The Stripe API version requests pin (as Slotlock's billing does). */
export const STRIPE_API_VERSION = '2026-04-22.dahlia';

/** The PaymentIntent metadata key that names the hold it pays for. */
export const HOLD_METADATA_KEY = 'slotlock_hold_id';
/** The PaymentIntent metadata key that names its tenant (a digest), for a Stripe account several share. */
export const TENANT_METADATA_KEY = 'slotlock_tenant';

/**
 * Refusals that prove a payment was not applied to any booking: only these are refunded. A hold
 * not found is one only for a PaymentIntent that names this tenant (it may be another's), and
 * another payment recorded (`payment_conflict`) only when that one is another PaymentIntent.
 */
const REFUNDABLE = new Set(['hold_expired', 'hold_ended', 'payment_amount_mismatch']);

/** The digest a PaymentIntent carries for its tenant: the reference itself stays out of Stripe. */
export function tenantDigest(tenantRef: string): string {
  return createHash('sha256').update(tenantRef, 'utf8').digest('hex').slice(0, 32);
}

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
  /** Stripe does not say it succeeded (yet), it names no hold, or another tenant's. */
  | { status: 'not_paid'; reason: 'not_succeeded' | 'no_hold' | 'not_found' | 'other_tenant' }
  /** Slotlock refused it: the hold expired, was booked, was paid by another payment, or needs none. */
  | { status: 'refused'; holdId: string; paymentRef: string; code: string; refunded: boolean };

export interface StripePaymentsOptions {
  /**
   * The Slotlock tenant the key below belongs to. PaymentIntents name it (`metadataFor`), so where
   * several tenants share a Stripe account each acts only on its own payments.
   */
  tenantRef: string;
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

  const tenant = tenantDigest(options.tenantRef);

  async function markPaid(
    holdId: string,
    paymentRef: string,
    received: { amount_minor: number; currency: string } | null,
    ownTenant: boolean,
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
    const body = (await response.json().catch(() => ({}))) as {
      replayed?: boolean;
      error?: { code?: string };
      payment_ref?: unknown;
    };
    if (response.ok) return { status: 'paid', holdId, paymentRef, replayed: body.replayed === true };
    const code = body.error?.code ?? `http_${response.status}`;
    // Slotlock is down, or the key refused: not an answer about the hold, so try again later.
    if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 429) {
      throw new Error(`Slotlock answered ${response.status} ${code}`);
    }
    // Refund only what Slotlock says it did not take: a hold that expired first or ended unbooked,
    // a payment short of the hold's, another PaymentIntent for a hold already paid, or a hold this
    // tenant does not have (a payment it applied is always found, as its own). Anything else is
    // left for a person.
    const unapplied =
      REFUNDABLE.has(code) ||
      (code === 'hold_not_found' && ownTenant) ||
      (code === 'payment_conflict' &&
        typeof body.payment_ref === 'string' &&
        /^pi_/.test(body.payment_ref) &&
        body.payment_ref !== paymentRef);
    let refunded = false;
    if (options.refundRefused && unapplied) {
      const refund = await stripe('/refunds', { form: { payment_intent: paymentRef }, idempotencyKey: `slotlock-refund-${paymentRef}` });
      const already = (refund.body.error as { code?: unknown } | undefined)?.code === 'charge_already_refunded';
      // Not refunded yet (Stripe down, rate-limited, or a key that may not refund): thrown, so the
      // delivery fails and comes again, never acknowledged with the money kept.
      if (refund.status >= 300 && !already) throw new Error(`Stripe answered ${refund.status} to the refund`);
      refunded = true;
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
    const metadata = intent.metadata as Record<string, unknown> | undefined;
    const holdId = metadata?.[HOLD_METADATA_KEY];
    if (typeof holdId !== 'string' || !HOLD_ID.test(holdId)) return { status: 'not_paid', reason: 'no_hold' };
    // Another tenant's payment on a shared Stripe account: theirs to apply, never ours to refund.
    const named = metadata?.[TENANT_METADATA_KEY];
    if (named !== undefined && named !== tenant) return { status: 'not_paid', reason: 'other_tenant' };
    if (intent.status !== 'succeeded') return { status: 'not_paid', reason: 'not_succeeded' };
    const amount = intent.amount_received;
    const currency = typeof intent.currency === 'string' ? intent.currency.toUpperCase() : null;
    const received =
      Number.isSafeInteger(amount) && currency && /^[A-Z]{3}$/.test(currency)
        ? { amount_minor: amount as number, currency }
        : null;
    return markPaid(holdId, intent.id, received, named === tenant);
  }

  return {
    /** What to put on the PaymentIntent you create for a hold, so its payment finds it. */
    metadataFor(holdId: string): Record<string, string> {
      return { [HOLD_METADATA_KEY]: holdId, [TENANT_METADATA_KEY]: tenant };
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

    /**
     * A delivery from Slotlock's own webhooks (its Standard Webhooks signature checked first): a
     * paid hold that ended without a booking (`hold.expired` or `hold.released` with
     * `payment_unapplied`) has its PaymentIntent read back and told to Slotlock again, which
     * answers `hold_ended`, and so refunded. Other changes are ignored.
     */
    async handleSlotlockWebhook(params: { payload: string; headers: Headers; webhookSecret: string }): Promise<
      PaymentOutcome | { status: 'ignored' }
    > {
      verifySlotlockWebhook({ body: params.payload, headers: params.headers, secret: params.webhookSecret });
      const change = JSON.parse(params.payload) as { type?: string; data?: { payment_unapplied?: { payment_ref?: unknown } } };
      const type = String(change.type ?? '').replace(/^io\.pylota\.slotlock\./, '');
      const paymentRef = change.data?.payment_unapplied?.payment_ref;
      if ((type !== 'hold.expired' && type !== 'hold.released') || typeof paymentRef !== 'string') return { status: 'ignored' };
      return confirmPaymentIntent(paymentRef);
    },
  };
}

/** Why a delivery from Slotlock was refused: not signed with the endpoint's secret, or not now. */
export class SlotlockSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotlockSignatureError';
  }
}

/**
 * Check a Slotlock webhook delivery (Standard Webhooks): one `v1,` signature in `webhook-signature`
 * must be the HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` keyed by the endpoint's
 * secret (`whsec_` and base64), and the timestamp within `toleranceSeconds` (default 300) of now.
 */
export function verifySlotlockWebhook(params: {
  body: string;
  headers: Headers;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): void {
  const id = params.headers.get('webhook-id');
  const timestamp = params.headers.get('webhook-timestamp');
  const signatures = params.headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) throw new SlotlockSignatureError('The delivery has no webhook signature headers');
  if (!params.secret.startsWith('whsec_')) throw new TypeError('A Slotlock webhook secret starts with whsec_');
  const seconds = Number(timestamp);
  const now = (params.now ?? new Date()).getTime() / 1_000;
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > (params.toleranceSeconds ?? 300)) {
    throw new SlotlockSignatureError('The delivery is too old or too new');
  }
  const expected = createHmac('sha256', Buffer.from(params.secret.slice('whsec_'.length), 'base64'))
    .update(`${id}.${timestamp}.${params.body}`, 'utf8')
    .digest();
  const signed = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!signed) throw new SlotlockSignatureError('The delivery is not signed with this secret');
}
