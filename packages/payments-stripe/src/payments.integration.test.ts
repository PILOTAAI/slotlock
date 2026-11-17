// @slotlock/payments-stripe: Stripe's webhook signature, and against a real Slotlock (in process, on
// real Postgres) with a fake Stripe, a verified PaymentIntent marking its hold paid so it can be
// confirmed, once; one that has not succeeded marking nothing; and a payment for an expired hold
// refused and refunded. The signature tests run without DATABASE_URL.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { deliverSlotlockWebhooks } from '../../../src/webhooks.js';
import { createPaymentsHttpHandler, createStripePayments, tenantDigest, verifyStripeSignature } from './index.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];
const SECRET = 'whsec_test_secret';
const signed = (payload: string, at = Math.floor(Date.now() / 1_000), secret = SECRET) =>
  `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`;

describe("Stripe's webhook signature", () => {
  const payload = JSON.stringify({ type: 'payment_intent.succeeded' });
  it('takes a delivery Stripe signed, and refuses another secret, a changed body or an old one', () => {
    expect(() => verifyStripeSignature({ payload, header: signed(payload), secret: SECRET })).not.toThrow();
    expect(() => verifyStripeSignature({ payload, header: signed(payload, undefined, 'whsec_other'), secret: SECRET })).toThrow('not signed');
    expect(() => verifyStripeSignature({ payload: `${payload} `, header: signed(payload), secret: SECRET })).toThrow('not signed');
    expect(() => verifyStripeSignature({ payload, header: signed(payload, Math.floor(Date.now() / 1_000) - 3_600), secret: SECRET })).toThrow('too old');
    expect(() => verifyStripeSignature({ payload, header: null, secret: SECRET })).toThrow('no Stripe-Signature');
  });
});

describe.skipIf(!url)('@slotlock/payments-stripe with Slotlock (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `payments-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'api_key:payments', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  // The fake Stripe: PaymentIntents by id, and the refunds asked for.
  const intents = new Map<string, Record<string, unknown>>();
  const refunds: string[] = [];
  /** What the fake Stripe answers a refund, when it does not make it. */
  let refundFails: number | null = null;
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith(BASE)) return server.fetch(new Request(target, init));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_tenant');
    const intent = /\/v1\/payment_intents\/(pi_\w+)$/.exec(target);
    if (intent) return intents.has(intent[1] as string) ? json(intents.get(intent[1] as string)) : json({ error: {} }, 404);
    if (target === 'https://api.stripe.com/v1/refunds') {
      if (refundFails !== null) return json({ error: { type: 'api_error' } }, refundFails);
      refunds.push(new URLSearchParams(String(init.body)).get('payment_intent') as string);
      return json({ id: 're_1', status: 'succeeded' });
    }
    return json({ error: {} }, 500);
  }) as typeof fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('marks a hold paid from a verified PaymentIntent, once, and refunds one for an expired hold', async () => {
    const payments = createStripePayments({
      tenantRef,
      stripeSecretKey: 'sk_test_tenant',
      slotlock: { baseUrl: BASE, apiKey: 'admin' },
      refundRefused: true,
      fetch: send,
    });
    const day = Date.UTC(new Date().getUTCFullYear() + 1, 5, 6);
    const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
    const room = ((await call('POST', '/v1/resources', { external_ref: 'room-pay', timezone: 'UTC' })).body.resource as { id: string }).id;
    const hold = (start: number) =>
      call('POST', '/v1/holds', {
        resource_id: room,
        start: at(start),
        end: at(start + 1),
        ttl_seconds: 900,
        payment_required: true,
        payment: { amount_minor: 4500, currency: 'GBP' },
      }).then(
        (answer) => (answer.body.hold as { id: string }).id,
      );

    const held = await hold(9);
    const paying = { object: 'payment_intent', amount_received: 4500, currency: 'gbp', metadata: payments.metadataFor(held) };
    intents.set('pi_ok', { ...paying, id: 'pi_ok', status: 'processing' });
    expect(await payments.confirmPaymentIntent('pi_ok')).toEqual({ status: 'not_paid', reason: 'not_succeeded' });
    expect((await call('POST', `/v1/holds/${held}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });

    // Less than the hold asks for, or in another currency: refused, and refunded.
    intents.set('pi_cheap', { ...paying, id: 'pi_cheap', status: 'succeeded', amount_received: 100 });
    expect(await payments.confirmPaymentIntent('pi_cheap')).toMatchObject({ status: 'refused', code: 'payment_amount_mismatch', refunded: true });
    intents.set('pi_euro', { ...paying, id: 'pi_euro', status: 'succeeded', currency: 'eur' });
    expect(await payments.confirmPaymentIntent('pi_euro')).toMatchObject({ status: 'refused', code: 'payment_amount_mismatch' });

    // Stripe counts ISK (and UGX) in hundredths ISO 4217 does not have: 100 to Stripe is 1 ISK, less
    // than a 50 ISK hold, and 5000 is the whole 50.
    const krona = await call('POST', '/v1/holds', {
      resource_id: room, start: at(20), end: at(21), ttl_seconds: 900, payment_required: true,
      payment: { amount_minor: 50, currency: 'ISK' },
    }).then((answer) => (answer.body.hold as { id: string }).id);
    const iceland = { object: 'payment_intent', status: 'succeeded', currency: 'isk', metadata: payments.metadataFor(krona) };
    intents.set('pi_iskshort', { ...iceland, id: 'pi_iskshort', amount_received: 100 });
    expect(await payments.confirmPaymentIntent('pi_iskshort')).toMatchObject({ status: 'refused', code: 'payment_amount_mismatch' });
    intents.set('pi_iskodd', { ...iceland, id: 'pi_iskodd', amount_received: 5050 });
    expect(await payments.confirmPaymentIntent('pi_iskodd')).toMatchObject({ status: 'refused', code: 'payment_amount_mismatch' });
    intents.set('pi_isk', { ...iceland, id: 'pi_isk', amount_received: 5000 });
    expect(await payments.confirmPaymentIntent('pi_isk')).toMatchObject({ status: 'paid', holdId: krona });
    expect((await call('GET', `/v1/holds/${krona}`)).body.hold).toMatchObject({ paid_amount: { amount_minor: 50, currency: 'ISK' } });

    // Stripe says it succeeded: the webhook is read back from Stripe, and the hold marked paid.
    intents.set('pi_ok', { ...intents.get('pi_ok'), status: 'succeeded' });
    const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_ok', status: 'succeeded' } } });
    expect(await payments.handleWebhook({ payload, signatureHeader: signed(payload), webhookSecret: SECRET })).toEqual({
      status: 'paid',
      holdId: held,
      paymentRef: 'pi_ok',
      replayed: false,
    });
    expect(await payments.confirmPaymentIntent('pi_ok')).toMatchObject({ status: 'paid', replayed: true });
    expect((await call('GET', `/v1/holds/${held}`)).body.hold).toMatchObject({
      payment_amount: { amount_minor: 4500, currency: 'GBP' },
      paid_amount: { amount_minor: 4500, currency: 'GBP' },
    });
    expect((await call('POST', `/v1/holds/${held}/confirm`, {})).status).toBe(200);
    // Told again once booked (a reloaded return page, a redelivered webhook): the payment already
    // recorded, never a refund.
    expect(await payments.confirmPaymentIntent('pi_ok')).toMatchObject({ status: 'paid', replayed: true });
    expect(await payments.handleWebhook({ payload, signatureHeader: signed(payload), webhookSecret: SECRET })).toMatchObject({
      status: 'paid',
      replayed: true,
    });
    expect(refunds).toEqual(['pi_cheap', 'pi_euro', 'pi_iskshort', 'pi_iskodd']);
    await expect(payments.handleWebhook({ payload, signatureHeader: signed(payload, undefined, 'whsec_x'), webhookSecret: SECRET })).rejects.toThrow();
    expect(
      await payments.handleWebhook({ payload: JSON.stringify({ type: 'charge.refunded' }), signatureHeader: signed(JSON.stringify({ type: 'charge.refunded' })), webhookSecret: SECRET }),
    ).toEqual({ status: 'ignored' });

    // Paid after the hold lapsed: refused, and refunded.
    const lapsed = await hold(13);
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${lapsed}`;
    intents.set('pi_late', { ...paying, id: 'pi_late', status: 'succeeded', metadata: payments.metadataFor(lapsed) });
    expect(await payments.confirmPaymentIntent('pi_late')).toEqual({
      status: 'refused',
      holdId: lapsed,
      paymentRef: 'pi_late',
      code: 'hold_expired',
      refunded: true,
    });
    expect(refunds).toEqual(['pi_cheap', 'pi_euro', 'pi_iskshort', 'pi_iskodd', 'pi_late']);

    // Through its HTTP surface: one URL per tenant, each checked with that tenant's secret.
    const http = createPaymentsHttpHandler({
      slotlockUrl: BASE,
      fetch: send,
      tenant: async (ref) => (ref === tenantRef ? { stripeSecretKey: 'sk_test_tenant', webhookSecret: SECRET, slotlockApiKey: 'admin' } : null),
    });
    const viaHttp = await hold(15);
    intents.set('pi_http', { ...paying, id: 'pi_http', status: 'succeeded', metadata: payments.metadataFor(viaHttp) });
    const delivery = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_http' } } });
    const post = (path: string, signature: string) =>
      http(new Request(`https://payments.example${path}`, { method: 'POST', headers: { 'stripe-signature': signature }, body: delivery }));
    expect((await post(`/stripe/webhook/${encodeURIComponent(tenantRef)}`, signed(delivery, undefined, 'whsec_other'))).status).toBe(400);
    expect((await post('/stripe/webhook/someone-else', signed(delivery))).status).toBe(400);
    const accepted = await post(`/stripe/webhook/${encodeURIComponent(tenantRef)}`, signed(delivery));
    expect(await accepted.json()).toEqual({ status: 'paid' });
    expect((await call('POST', `/v1/holds/${viaHttp}/confirm`, {})).status).toBe(200);

    // A PaymentIntent for no hold, or none at all.
    intents.set('pi_other', { object: 'payment_intent', id: 'pi_other', status: 'succeeded', metadata: {} });
    expect(await payments.confirmPaymentIntent('pi_other')).toEqual({ status: 'not_paid', reason: 'no_hold' });
    expect(await payments.confirmPaymentIntent('pi_missing')).toEqual({ status: 'not_paid', reason: 'not_found' });
  });
  it('refunds every payment it could not apply, says what it keeps, and retries a refund not made', async () => {
    const logged: { level: string; message: string; fields: Record<string, unknown> }[] = [];
    const http = createPaymentsHttpHandler({
      slotlockUrl: BASE,
      fetch: send,
      log: (level, message, fields) => logged.push({ level, message, fields }),
      tenant: async (ref) =>
        ref === tenantRef
          ? { stripeSecretKey: 'sk_test_tenant', webhookSecret: SECRET, slotlockApiKey: 'admin', refundRefused: true, slotlockWebhookSecret: hookSecret }
          : null,
    });
    const created = await store.createWebhookEndpoint({
      tenantRef,
      url: `https://payments.example/slotlock/webhook/${encodeURIComponent(tenantRef)}`,
      eventTypes: ['hold.expired', 'hold.released'],
    });
    if (!created.ok) throw new Error(created.code);
    const hookSecret = created.secret;
    const payments = createStripePayments({ tenantRef, stripeSecretKey: 'sk_test_tenant', slotlock: { baseUrl: BASE, apiKey: 'admin' }, refundRefused: true, fetch: send });
    const day = Date.UTC(new Date().getUTCFullYear() + 1, 7, 8);
    const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
    const room = ((await call('POST', '/v1/resources', { external_ref: 'room-refunds', timezone: 'UTC' })).body.resource as { id: string }).id;
    const hold = async (start: number) =>
      ((await call('POST', '/v1/holds', {
        resource_id: room, start: at(start), end: at(start + 1), ttl_seconds: 900,
        payment_required: true, payment: { amount_minor: 4500, currency: 'GBP' },
      })).body.hold as { id: string }).id;
    const paying = (id: string, holdId: string) =>
      intents.set(id, { object: 'payment_intent', id, status: 'succeeded', amount_received: 4500, currency: 'gbp', metadata: payments.metadataFor(holdId) });
    const stripeDelivery = (id: string) => {
      const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id } } });
      return http(new Request(`https://payments.example/stripe/webhook/${encodeURIComponent(tenantRef)}`, {
        method: 'POST', headers: { 'stripe-signature': signed(payload) }, body: payload,
      }));
    };
    refunds.length = 0;

    // Paid after its hold expired and was taken away (another booking over its time): not found
    // here, so refunded, since a payment this tenant applied is always found.
    const reaped = await hold(9);
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${reaped}`;
    expect((await call('POST', '/v1/holds', { resource_id: room, start: at(9), end: at(10), ttl_seconds: 60 })).status).toBe(200);
    paying('pi_reaped', reaped);
    expect(await (await stripeDelivery('pi_reaped')).json()).toEqual({ status: 'refused', code: 'hold_not_found', refunded: true });

    // Another tenant's on a shared Stripe account: theirs, never refunded here.
    intents.set('pi_theirs', { object: 'payment_intent', id: 'pi_theirs', status: 'succeeded', amount_received: 4500, currency: 'gbp',
      metadata: { slotlock_hold_id: reaped, slotlock_tenant: tenantDigest('someone-else') } });
    expect(await payments.confirmPaymentIntent('pi_theirs')).toEqual({ status: 'not_paid', reason: 'other_tenant' });

    // A refund Stripe does not make fails the delivery, so it comes again, and is made then.
    const late = await hold(11);
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${late}`;
    paying('pi_late2', late);
    refundFails = 500;
    expect((await stripeDelivery('pi_late2')).status).toBe(500);
    refundFails = null;
    expect(await (await stripeDelivery('pi_late2')).json()).toEqual({ status: 'refused', code: 'hold_expired', refunded: true });

    // Paid, then let expire without a booking: Slotlock's webhook says so, and the payment is
    // refunded; told again, Slotlock answers hold_ended.
    const unbooked = await hold(13);
    paying('pi_unbooked', unbooked);
    expect(await payments.confirmPaymentIntent('pi_unbooked')).toMatchObject({ status: 'paid', replayed: false });
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${unbooked}`;
    await sql`DELETE FROM slotlock.reservations WHERE id = ${unbooked}`;
    // Paid, then let go by the application: the same.
    const released = await hold(15);
    paying('pi_released', released);
    expect(await payments.confirmPaymentIntent('pi_released')).toMatchObject({ status: 'paid' });
    expect((await call('DELETE', `/v1/holds/${released}`)).body).toEqual({ released: true });
    // Paid and confirmed: applied, never refunded.
    const booked = await hold(17);
    paying('pi_booked', booked);
    expect(await payments.confirmPaymentIntent('pi_booked')).toMatchObject({ status: 'paid' });
    expect((await call('POST', `/v1/holds/${booked}/confirm`, {})).status).toBe(200);
    const passed = await deliverSlotlockWebhooks({
      feed: store,
      tenantRef,
      send: async (request) => {
        const answered = await http(new Request(request.url, { method: 'POST', headers: request.headers, body: request.body }));
        return { status: answered.status };
      },
    });
    expect(passed.failed).toBe(0);
    expect(refunds).toEqual(['pi_reaped', 'pi_late2', 'pi_unbooked', 'pi_released']);
    expect(await payments.confirmPaymentIntent('pi_unbooked')).toMatchObject({ status: 'refused', code: 'hold_ended', refunded: true });
    expect(await payments.confirmPaymentIntent('pi_booked')).toMatchObject({ status: 'paid', replayed: true });

    // Recorded under another reference than a PaymentIntent (a Checkout Session, say): the
    // PaymentIntent that arrives may be that very payment, so it is left for a person, and said.
    const session = await hold(19);
    expect((await call('POST', `/v1/holds/${session}/paid`, { payment_ref: 'cs_test_abc', received: { amount_minor: 4500, currency: 'GBP' } })).status).toBe(200);
    paying('pi_session', session);
    expect(await (await stripeDelivery('pi_session')).json()).toEqual({ status: 'refused', code: 'payment_conflict', refunded: false });
    expect(refunds).not.toContain('pi_session');
    expect(logged.filter((entry) => entry.level === 'error').map((entry) => [entry.message, entry.fields.code])).toEqual([
      ['delivery failed; it comes again', undefined],
      ['payment refused and kept: a person must look at it', 'payment_conflict'],
    ]);
  });
});
