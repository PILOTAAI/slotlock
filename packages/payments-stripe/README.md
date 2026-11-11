# @slotlock/payments-stripe

Payments for Slotlock holds (RFC 0004 C3), on the tenant's own Stripe account. Slotlock records
payment state and never moves money: this adapter reads Stripe with the tenant's key and, once a
PaymentIntent has succeeded for a hold, tells Slotlock `POST /v1/holds/{hold_id}/paid`.

## The flow

1. Hold the time with `payment_required: true` and what it costs, `payment: { amount_minor,
   currency }` (`POST /v1/holds`, or an agent's `slotlock_hold_slots`; at most 30 minutes). Slotlock
   refuses to confirm it (`409 payment_required`) until it is paid.
2. Create a PaymentIntent on the tenant's account with `metadata: payments.metadataFor(holdId)`.
3. When Stripe says it succeeded, `handleWebhook` (for a delivery to your webhook endpoint) or
   `confirmPaymentIntent` (after the customer returns) reads the PaymentIntent back from Stripe,
   never trusting a payload alone, and marks the hold paid with what Stripe says was received
   (`amount_received`, `currency`). Slotlock refuses less than the hold's payment, or another
   currency (`payment_amount_mismatch`). Doing so again answers `replayed: true`; another payment
   for the same hold is refused (`payment_conflict`).
4. Confirm the hold (`POST /v1/holds/{hold_id}/confirm`).

A payment that arrives after its hold expired is refused (`hold_expired`): its time may be someone
else's by then. With `refundRefused: true` the adapter refunds, idempotently by the PaymentIntent,
only a payment Slotlock says it did not take: `hold_expired`, `payment_conflict` or
`payment_amount_mismatch`. A payment told again after its hold was booked (a reloaded return page,
a redelivered webhook) is answered as the payment already recorded, since Slotlock keeps each
hold's payment apart from the hold, and is never refunded. Any other refusal (`hold_not_found`) is
left for a person to look at.

```ts
import { createStripePayments } from '@slotlock/payments-stripe';

const payments = createStripePayments({
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
account: point that account's webhook endpoint at it for `payment_intent.succeeded`. Settings:
`SLOTLOCK_URL`, `PAYMENTS_TENANTS_FILE` (a JSON file, kept as a secret: per tenant
`stripeSecretKey`, a restricted key that reads PaymentIntents and writes refunds; `webhookSecret`;
`slotlockApiKey`; `refundRefused`), `HOST`, `PORT` (8092).

The Stripe-Signature check needs a `v1` HMAC-SHA256 over `<t>.<payload>` within five minutes.
Requests pin Stripe API version `2026-04-22.dahlia`, as Slotlock's billing does.

## Testing it end to end

`src/payments.stripe-e2e.test.ts` runs the adapter against Stripe's test mode and a real Slotlock (in
process, on PostgreSQL). It makes real PaymentIntents with Stripe's test cards and reads back Stripe's
own `payment_intent.succeeded` events and the refunds it made. It covers six cases:

- A paid hold confirms, from the return page and from the webhook.
- Paying less, in another currency, after the hold expired, or a second time is refused and refunded
  once.
- A declined card, one that waits for authentication, or an uncaptured payment marks nothing; a
  partial capture below the hold's price is refused.
- A payment naming another tenant's hold changes nothing there and is not refunded.

```bash
STRIPE_TEST_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... npx vitest run packages/payments-stripe/src/payments.stripe-e2e.test.ts
```

It runs only with a test-mode key: a live key is refused, and the account must answer
`livemode: false`. It moves no money. Without `STRIPE_TEST_SECRET_KEY` it is skipped, as it is in
CI. Behind an HTTPS proxy, add `NODE_USE_ENV_PROXY=1`. Stripe cannot reach a test machine, so the
test signs Stripe's events itself.

## Status

T2: an independent security review is needed before Cloud runs it.
