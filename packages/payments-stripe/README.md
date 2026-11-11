# @slotlock/payments-stripe

Payments for Slotlock holds (RFC 0004 C3), on the tenant's own Stripe account. Slotlock records
payment state and never moves money: this adapter reads Stripe with the tenant's key and, once a
PaymentIntent has succeeded for a hold, tells Slotlock `POST /v1/holds/{hold_id}/paid`.

## The flow

1. Hold the time with `payment_required: true` and what it costs, `payment: { amount_minor,
   currency }` (`POST /v1/holds`, or an agent's `slotlock_hold_slots`; at most 30 minutes). Slotlock
   refuses to confirm it (`409 payment_required`) until it is paid.
2. Create a PaymentIntent on the tenant's account with `metadata: payments.metadataFor(holdId)`:
   the hold and a digest of its tenant, so where several tenants share a Stripe account each acts
   only on its own payments.
3. When Stripe says it succeeded, `handleWebhook` (for a delivery to your webhook endpoint) or
   `confirmPaymentIntent` (after the customer returns) reads the PaymentIntent back from Stripe,
   never trusting a payload alone, and marks the hold paid with what Stripe says was received
   (`amount_received`, `currency`). Slotlock refuses less than the hold's payment, or another
   currency (`payment_amount_mismatch`). Doing so again answers `replayed: true`; another payment
   for the same hold is refused (`payment_conflict`).
4. Confirm the hold (`POST /v1/holds/{hold_id}/confirm`).

Every payment the adapter cannot apply is refunded (with `refundRefused: true`) or said to need a
person; none is kept quietly. It refunds, once and idempotently by the PaymentIntent, a payment
Slotlock says it did not take:

- the hold expired first (`hold_expired`), or is gone (`hold_not_found`, for a PaymentIntent that
  names this tenant: a payment it applied is always found);
- the hold was paid, then ended without a booking (`hold_ended`);
- less than the hold's payment, or another currency (`payment_amount_mismatch`);
- another PaymentIntent already paid the hold (`payment_conflict`).

A payment told again after its hold was booked (a reloaded return page, a redelivered webhook) is
the payment already recorded, and never refunded. A refund Stripe does not make fails the delivery
(500), so Stripe delivers it again. A payment recorded under a reference that is not a
PaymentIntent (a Checkout Session, say) may be this very payment: it is kept, and logged at level
error for a person, as is any other refusal.

A paid hold that ends without a booking (it expired before it was confirmed, or was let go) is on
Slotlock's feed as `hold.expired` or `hold.released` with `payment_unapplied`. Point a Slotlock
webhook endpoint for those two types at `/slotlock/webhook/<tenant>` and give the adapter its
secret (`slotlockWebhookSecret`): the payment is refunded as soon as Slotlock says so.

```ts
import { createStripePayments } from '@slotlock/payments-stripe';

const payments = createStripePayments({
  tenantRef: 'your-tenant', // the Slotlock tenant the keys belong to
  stripeSecretKey: process.env.TENANT_STRIPE_KEY!, // a restricted key: read PaymentIntents, write refunds
  slotlock: { baseUrl: 'https://slotlock.example.com', apiKey: process.env.TENANT_SLOTLOCK_KEY! },
  refundRefused: true,
});

// In your Stripe webhook endpoint, with the body exactly as received:
const outcome = await payments.handleWebhook({
  payload: await request.text(),
  signatureHeader: request.headers.get('stripe-signature'),
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});
```

## Run it

`slotlock-payments-stripe` serves `POST /stripe/webhook/<tenant>` for each tenant's own Stripe
account (point that account's webhook endpoint at it for `payment_intent.succeeded`) and
`POST /slotlock/webhook/<tenant>` for Slotlock's `hold.expired` and `hold.released`. Settings:
`SLOTLOCK_URL`, `PAYMENTS_TENANTS_FILE` (a JSON file, kept as a secret: per tenant
`stripeSecretKey`, a restricted key that reads PaymentIntents and writes refunds; `webhookSecret`;
`slotlockApiKey`; `refundRefused`; `slotlockWebhookSecret`), `HOST`, `PORT` (8092). It logs each
payment applied or refunded, and at level error each one it kept and each delivery that failed.

The Stripe-Signature check needs a `v1` HMAC-SHA256 over `<t>.<payload>` within five minutes.
Requests pin Stripe API version `2026-04-22.dahlia`, as Slotlock's billing does.

## Testing it end to end

`src/payments.stripe-e2e.test.ts` runs the adapter against Stripe's test mode and a real Slotlock (in
process, on PostgreSQL). It makes real PaymentIntents with Stripe's test cards and reads back Stripe's
own `payment_intent.succeeded` events and the refunds it made. It covers these cases:

- A paid hold confirms, from the return page and from the webhook.
- Paying less, in another currency, after the hold expired, or a second time is refused and refunded
  once.
- A declined card, one that waits for authentication, or an uncaptured payment marks nothing; a
  partial capture below the hold's price is refused.
- A paid hold let go before its booking is refunded (`hold_ended`).
- Another tenant's payment on a shared Stripe account is left alone; this tenant's payment naming a
  hold it does not have changes nothing there and is refunded.

```bash
STRIPE_TEST_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... npx vitest run packages/payments-stripe/src/payments.stripe-e2e.test.ts
```

It runs only with a test-mode key: a live key is refused, and the account must answer
`livemode: false`. It moves no money. Without `STRIPE_TEST_SECRET_KEY` it is skipped, as it is in
CI. Behind an HTTPS proxy, add `NODE_USE_ENV_PROXY=1`. Stripe cannot reach a test machine, so the
test signs Stripe's events itself.

## Status

T2: an independent security review is needed before Cloud runs it.
