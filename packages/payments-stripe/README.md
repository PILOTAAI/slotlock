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
else's by then. With `refundRefused: true` the adapter refunds a refused payment (idempotently, by
the PaymentIntent).

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

## Status

T2: an independent security review is needed before Cloud runs it.
