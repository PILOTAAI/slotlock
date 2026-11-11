// @slotlock/payments-stripe end to end, against Stripe's test mode (RFC 0004 C3): real
// PaymentIntents on a Stripe test account, paid with Stripe's test cards, read back by the adapter
// and applied to holds on a real Slotlock (in process, on real Postgres), and refunds made on Stripe
// and read back from it. Stripe's own payment_intent.succeeded event for a payment, read from its
// Events API, is delivered to the webhook handler (signed here: Stripe cannot reach a test machine,
// and the signature scheme is checked against Stripe's library separately).
//
// Runs only with STRIPE_TEST_SECRET_KEY (an sk_test_ or rk_test_ key; a live key is refused, and
// the account must answer livemode: false) and DATABASE_URL. It moves no money. Behind an HTTPS
// proxy, Node's fetch needs NODE_USE_ENV_PROXY=1.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { STRIPE_API_VERSION, createPaymentsHttpHandler, createStripePayments } from './index.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const stripeKey = process.env.STRIPE_TEST_SECRET_KEY?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];
const WEBHOOK_SECRET = `whsec_${randomUUID().replace(/-/g, '')}`;

type Json = Record<string, unknown>;

describe.skipIf(!url || !stripeKey)('@slotlock/payments-stripe against Stripe test mode and a real Slotlock', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantA = `stripe-e2e-a-${randomUUID()}`;
  const tenantB = `stripe-e2e-b-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    'admin-a': { subject: 'api_key:stripe-e2e-a', tenantRef: tenantA, scopes: ['read', 'write', 'admin'] },
    'admin-b': { subject: 'api_key:stripe-e2e-b', tenantRef: tenantB, scopes: ['read', 'write', 'admin'] },
  };
  const startedAt = Math.floor(Date.now() / 1_000) - 60;
  // Slotlock answers in process; everything else is the real Stripe API.
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith(BASE)) return server.fetch(new Request(target, init));
    expect(target.startsWith('https://api.stripe.com/v1/')).toBe(true);
    return fetch(input, init);
  }) as typeof fetch;
  const payments = () =>
    createStripePayments({
      stripeSecretKey: stripeKey as string,
      slotlock: { baseUrl: BASE, apiKey: 'admin-a' },
      refundRefused: true,
      fetch: send,
    });

  /** The Stripe API, as the tenant's own key. */
  async function stripe(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<{ status: number; body: Json }> {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${stripeKey as string}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: (await response.json()) as Json };
  }

  /** A PaymentIntent for a hold, paid at once with a test card; a declined one answers its error. */
  async function pay(params: {
    holdId: string;
    amount: number;
    currency: string;
    card?: string;
    manualCapture?: boolean;
  }): Promise<Json> {
    const created = await stripe('POST', '/payment_intents', {
      amount: String(params.amount),
      currency: params.currency,
      'payment_method_types[]': 'card',
      payment_method: params.card ?? 'pm_card_visa',
      confirm: 'true',
      ...(params.manualCapture ? { capture_method: 'manual' } : {}),
      [`metadata[slotlock_hold_id]`]: params.holdId,
      description: 'Slotlock payments e2e test',
    });
    if (created.status === 200) return created.body;
    // A declined card still made the PaymentIntent; Stripe names it in the error.
    const intent = (created.body.error as Json | undefined)?.payment_intent as Json | undefined;
    if (intent) return intent;
    throw new Error(`Stripe answered ${created.status}: ${JSON.stringify(created.body)}`);
  }

  const refundsOf = async (paymentIntent: string) =>
    ((await stripe('GET', `/refunds?payment_intent=${paymentIntent}`)).body.data as Json[]).map((refund) => refund.status);

  /** Stripe's own payment_intent.succeeded event for a PaymentIntent, once its Events API has it. */
  async function eventFor(paymentIntent: string): Promise<Json> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await stripe('GET', `/events?type=payment_intent.succeeded&created[gte]=${startedAt}&limit=100`);
      const event = (listed.body.data as Json[]).find((each) => ((each.data as Json).object as Json).id === paymentIntent);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Stripe has no payment_intent.succeeded event for ${paymentIntent}`);
  }

  const call = async (key: string, method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Json };
  };

  const day = Date.UTC(new Date().getUTCFullYear() + 1, 2, 3);
  const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
  let roomA: string;
  let roomB: string;
  let nextHour = 0;
  /** A new hold of an hour that waits for a payment of GBP 45.00. */
  const hold = async (key = 'admin-a', room = roomA) => {
    nextHour += 2;
    const answer = await call(key, 'POST', '/v1/holds', {
      resource_id: room,
      start: at(nextHour),
      end: at(nextHour + 1),
      ttl_seconds: 900,
      payment_required: true,
      payment: { amount_minor: 4500, currency: 'GBP' },
    });
    expect(answer.status).toBe(200);
    return (answer.body.hold as { id: string }).id;
  };

  beforeAll(async () => {
    if (/^(sk|rk)_live_/.test(stripeKey as string)) throw new Error('STRIPE_TEST_SECRET_KEY is a live key: this test runs in test mode only');
    const balance = await stripe('GET', '/balance');
    expect(balance.status).toBe(200);
    expect(balance.body.livemode, 'the Stripe key must be a test-mode key').toBe(false);

    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { agentBackend }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
    roomA = ((await call('admin-a', 'POST', '/v1/resources', { external_ref: 'room-a', timezone: 'UTC' })).body.resource as { id: string }).id;
    roomB = ((await call('admin-b', 'POST', '/v1/resources', { external_ref: 'room-b', timezone: 'UTC' })).body.resource as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    for (const tenant of [tenantA, tenantB]) await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    await sql.end();
  });

  it('a card payment marks its hold paid, from the return page and from Stripe\'s own event, and the hold confirms', async () => {
    const held = await hold();
    const intent = await pay({ holdId: held, amount: 4500, currency: 'gbp' });
    expect(intent.status).toBe('succeeded');
    expect((await call('admin-a', 'POST', `/v1/holds/${held}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });

    // The customer comes back from paying: the PaymentIntent is read back from Stripe.
    expect(await payments().confirmPaymentIntent(intent.id as string)).toEqual({
      status: 'paid',
      holdId: held,
      paymentRef: intent.id,
      replayed: false,
    });
    expect((await call('admin-a', 'GET', `/v1/holds/${held}`)).body.hold).toMatchObject({
      payment_amount: { amount_minor: 4500, currency: 'GBP' },
      paid_amount: { amount_minor: 4500, currency: 'GBP' },
    });

    // Stripe's own event for it, delivered to the webhook endpoint: the same payment, once.
    const event = await eventFor(intent.id as string);
    expect(event.livemode).toBe(false);
    const http = createPaymentsHttpHandler({
      slotlockUrl: BASE,
      fetch: send,
      tenant: async (ref) =>
        ref === tenantA ? { stripeSecretKey: stripeKey as string, webhookSecret: WEBHOOK_SECRET, slotlockApiKey: 'admin-a' } : null,
    });
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1_000);
    const signature = `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;
    const deliver = (path: string, header: string) =>
      http(new Request(`https://payments.example${path}`, { method: 'POST', headers: { 'stripe-signature': header }, body: payload }));
    expect((await deliver(`/stripe/webhook/${encodeURIComponent(tenantA)}`, signature.replace(/v1=./, 'v1=0'))).status).toBe(400);
    const delivered = await deliver(`/stripe/webhook/${encodeURIComponent(tenantA)}`, signature);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ status: 'paid' });
    expect(await payments().confirmPaymentIntent(intent.id as string)).toMatchObject({ status: 'paid', replayed: true });

    expect((await call('admin-a', 'POST', `/v1/holds/${held}/confirm`, {})).status).toBe(200);
    // Told again once booked: the payment already recorded, and never refunded.
    expect(await payments().confirmPaymentIntent(intent.id as string)).toMatchObject({ status: 'paid', replayed: true });
    expect(await refundsOf(intent.id as string)).toEqual([]);
  }, 120_000);

  it('refuses a payment for less, or in another currency, and refunds it on Stripe once', async () => {
    const held = await hold();
    const short = await pay({ holdId: held, amount: 4000, currency: 'gbp' });
    const euros = await pay({ holdId: held, amount: 4500, currency: 'eur' });
    for (const intent of [short, euros]) {
      expect(intent.status).toBe('succeeded');
      expect(await payments().confirmPaymentIntent(intent.id as string)).toMatchObject({
        status: 'refused',
        code: 'payment_amount_mismatch',
        refunded: true,
      });
      // Told again: the refund is not made twice.
      await payments().confirmPaymentIntent(intent.id as string);
      expect(await refundsOf(intent.id as string)).toEqual(['succeeded']);
    }
    expect((await call('admin-a', 'POST', `/v1/holds/${held}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });
  }, 120_000);

  it('refuses and refunds a payment that came after its hold expired', async () => {
    const held = await hold();
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${held}`;
    const intent = await pay({ holdId: held, amount: 4500, currency: 'gbp' });
    expect(await payments().confirmPaymentIntent(intent.id as string)).toMatchObject({ status: 'refused', code: 'hold_expired', refunded: true });
    expect(await refundsOf(intent.id as string)).toEqual(['succeeded']);
  }, 120_000);

  it('refunds a second payment for a hold already paid, and keeps the first', async () => {
    const held = await hold();
    const first = await pay({ holdId: held, amount: 4500, currency: 'gbp' });
    const second = await pay({ holdId: held, amount: 4500, currency: 'gbp' });
    expect(await payments().confirmPaymentIntent(first.id as string)).toMatchObject({ status: 'paid', replayed: false });
    expect(await payments().confirmPaymentIntent(second.id as string)).toMatchObject({ status: 'refused', code: 'payment_conflict', refunded: true });
    expect(await refundsOf(first.id as string)).toEqual([]);
    expect(await refundsOf(second.id as string)).toEqual(['succeeded']);
    expect((await call('admin-a', 'GET', `/v1/holds/${held}`)).body.hold).toMatchObject({ payment_ref: first.id });
  }, 120_000);

  it('marks nothing for a declined card, a card that waits for authentication, or an uncaptured payment', async () => {
    const held = await hold();
    const declined = await pay({ holdId: held, amount: 4500, currency: 'gbp', card: 'pm_card_chargeDeclined' });
    const authenticating = await pay({ holdId: held, amount: 4500, currency: 'gbp', card: 'pm_card_authenticationRequired' });
    const uncaptured = await pay({ holdId: held, amount: 4500, currency: 'gbp', manualCapture: true });
    expect([declined.status, authenticating.status, uncaptured.status]).toEqual([
      'requires_payment_method',
      'requires_action',
      'requires_capture',
    ]);
    for (const intent of [declined, authenticating, uncaptured]) {
      expect(await payments().confirmPaymentIntent(intent.id as string)).toEqual({ status: 'not_paid', reason: 'not_succeeded' });
    }
    expect((await call('admin-a', 'POST', `/v1/holds/${held}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });

    // Captured for less than the hold asks: Stripe's amount_received is what counts.
    const captured = await stripe('POST', `/payment_intents/${uncaptured.id as string}/capture`, { amount_to_capture: '3000' });
    expect(captured.body).toMatchObject({ status: 'succeeded', amount_received: 3000 });
    expect(await payments().confirmPaymentIntent(uncaptured.id as string)).toMatchObject({
      status: 'refused',
      code: 'payment_amount_mismatch',
      refunded: true,
    });
  }, 120_000);

  it("leaves another tenant's hold alone, and does not refund a payment it cannot place", async () => {
    const theirs = await hold('admin-b', roomB);
    const intent = await pay({ holdId: theirs, amount: 4500, currency: 'gbp' });
    // Tenant A's adapter, with tenant A's Slotlock key, cannot reach tenant B's hold.
    expect(await payments().confirmPaymentIntent(intent.id as string)).toEqual({
      status: 'refused',
      holdId: theirs,
      paymentRef: intent.id,
      code: 'hold_not_found',
      refunded: false,
    });
    expect(await refundsOf(intent.id as string)).toEqual([]);
    expect((await call('admin-b', 'GET', `/v1/holds/${theirs}`)).body.hold).toMatchObject({ payment_ref: null });
    expect((await call('admin-b', 'POST', `/v1/holds/${theirs}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });
  }, 120_000);
});
