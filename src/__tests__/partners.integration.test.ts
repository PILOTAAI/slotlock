// Partner accounts (RFC 0003 part 4, P1-P4), against real Postgres: the schema owner makes partners
// and their keys; a partner key, through the application backend as the serving role, makes its own
// accounts on its contract's plans, gives them keys, suspends and erases them, and reads their
// usage, and reaches no other partner's accounts and no tenant's data. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentPrincipal } from '../agent-server.js';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyAuthenticator, createSlotlockApiKeyStore } from '../api-keys.js';
import {
  createSlotlockPartnerKey,
  createSlotlockPartnerKeyAuthenticator,
  createSlotlockPartnerStore,
  parseSlotlockPartnerContract,
  putSlotlockPartner,
  setSlotlockPartnerBilling,
  setSlotlockPartnerStatus,
} from '../partners.js';
import { closeSlotlockPartnerMonth, slotlockPreviousMonth } from '../partner-billing.js';
import { readSlotlockTenantPlan, readSlotlockTenantQuotas } from '../plans.js';
import { signSlotlockWebhook } from '../webhooks.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

const CONTRACT = {
  plans: {
    partner_free: { resources: 5, api_keys: 2, webhook_endpoints: 1, operations: 10000, bookings: 500 },
    partner_pro: { resources: 50, api_keys: 20, webhook_endpoints: 5, operations: 200000, bookings: 10000, stop_percent: 110 },
  },
  key_scopes: ['read', 'write'],
  pricing: { currency: 'usd', active_account: 600, operations_over_quota_per_10k: 100, minimum: 10000 },
};

describe.skipIf(!url)('partner accounts (real Postgres)', () => {
  const role = `slotlock_partner_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const password = randomBytes(24).toString('hex');
  const suffix = randomUUID().slice(0, 8);
  const stackapi = `stackapi-${suffix}`;
  const rival = `rival-${suffix}`;
  const billed = `billed-${suffix}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    for (const partner of [stackapi, rival, billed]) {
      await admin`DELETE FROM slotlock.partner_invoices WHERE partner_id = ${partner}`;
      for (const { tenant_ref } of await admin<{ tenant_ref: string }[]>`
        SELECT tenant_ref FROM slotlock.partner_accounts WHERE partner_id = ${partner}`) {
        await admin`SELECT * FROM slotlock.erase_tenant(${tenant_ref}::text)`;
      }
      await admin`DELETE FROM slotlock.partners WHERE id = ${partner}`;
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('reads a contract the database will take, and refuses one it would not', () => {
    expect(parseSlotlockPartnerContract(CONTRACT).plans.partner_free).toEqual({
      resources: 5,
      apiKeys: 2,
      webhookEndpoints: 1,
      operations: 10000,
      bookings: 500,
      stopPercent: 100,
    });
    for (const bad of [
      {},
      { plans: {} },
      { plans: { 'Bad Name': CONTRACT.plans.partner_free } },
      { plans: { partner_free: { ...CONTRACT.plans.partner_free, api_keys: 1000 } } },
      { plans: CONTRACT.plans, key_scopes: ['partner'] },
      { plans: CONTRACT.plans, pricing: { currency: 'USD' } },
    ]) {
      expect(() => parseSlotlockPartnerContract(bad), JSON.stringify(bad)).toThrow(/partner contract/);
    }
  });

  it('runs its own accounts through the partner API, and no other partner reaches them', async () => {
    await putSlotlockPartner(admin, { id: stackapi, name: 'stackapi.app', contract: CONTRACT });
    await putSlotlockPartner(admin, { id: rival, name: 'Rival', contract: CONTRACT });
    const { key: partnerKey } = await createSlotlockPartnerKey(admin, stackapi, 'Main');
    const authenticatePartner = createSlotlockPartnerKeyAuthenticator(application);
    const bearer = (key: string) => new Request('https://example.com', { headers: { authorization: `Bearer ${key}` } });
    const partner = (await authenticatePartner(bearer(partnerKey))) as SlotlockAgentPrincipal;
    expect(partner).toMatchObject({ tenantRef: `partner:${stackapi}`, scopes: ['partner'], partnerId: stackapi });
    // A tenant's key is not a partner key, and a made-up one is nothing.
    expect(await authenticatePartner(bearer(`slk_partner_${'a'.repeat(46)}`))).toBeNull();

    const store = createSlotlockStore(application);
    const keys = createSlotlockApiKeyStore(application);
    const backend = createSlotlockStoreApplicationBackend(store, {
      partners: createSlotlockPartnerStore(application, {
        keys,
        eraseTenant: (tenantRef) => store.eraseTenant({ tenantRef }),
      }),
    });
    const as = (principal: SlotlockAgentPrincipal, operation: string) => ({
      principal,
      operation: operation as never,
      signal: new AbortController().signal,
    });
    const call = (name: keyof typeof backend, input: Record<string, unknown>, principal = partner) =>
      backend[name](as(principal, name), input);

    // An account on a contract plan: its limits and quotas are the plan's.
    const made = (await call('partnerPutAccount', { account: 'user-1', plan: 'partner_free' })) as {
      account: { account: string; plan: string; status: string };
      created: boolean;
    };
    expect(made).toMatchObject({ created: true, account: { account: 'user-1', plan: 'partner_free', status: 'active', resources: 0, api_keys: 0 } });
    const tenantRef = `partner:${stackapi}:user-1`;
    expect(await readSlotlockTenantPlan(application, tenantRef)).toMatchObject({
      plan: 'partner_free',
      limits: { resources: 5, apiKeys: 2, webhookEndpoints: 1 },
    });
    expect(await readSlotlockTenantQuotas(application, tenantRef)).toEqual({ operations: 10000, bookings: 500, stopPercent: 100 });
    expect(await call('partnerPutAccount', { account: 'user-1', plan: 'partner_free' })).toMatchObject({ created: false });
    await expect(call('partnerPutAccount', { account: 'user-1', plan: 'enterprise' })).rejects.toMatchObject({
      code: 'invalid_partner_plan',
    });
    expect(await call('partnerListAccounts', {})).toMatchObject({ accounts: [{ account: 'user-1', plan: 'partner_free' }] });

    // Its keys: the contract's scopes, as many as its plan allows, each an ordinary key of its tenant.
    await expect(call('partnerCreateKey', { account: 'user-1', name: 'Admin', scopes: ['admin'] })).rejects.toMatchObject({
      code: 'scope_not_in_contract',
    });
    const first = (await call('partnerCreateKey', { account: 'user-1', name: 'Agent' })) as {
      key: string;
      api_key: { id: string; scopes: string[] };
    };
    expect(first.api_key.scopes).toEqual(['read', 'write']);
    const authenticateKey = createSlotlockApiKeyAuthenticator(keys);
    expect(await authenticateKey(bearer(first.key))).toMatchObject({ tenantRef, scopes: ['read', 'write'] });
    await call('partnerCreateKey', { account: 'user-1', name: 'Second' });
    await expect(call('partnerCreateKey', { account: 'user-1', name: 'Third' })).rejects.toMatchObject({
      code: 'api_key_limit_reached',
    });
    expect(((await call('partnerListKeys', { account: 'user-1' })) as { keys: unknown[] }).keys).toHaveLength(2);
    const rotated = (await call('partnerRotateKey', { account: 'user-1', key_id: first.api_key.id })) as { key: string };
    expect(await authenticateKey(bearer(first.key))).toBeNull();
    expect(await authenticateKey(bearer(rotated.key))).toMatchObject({ tenantRef });

    // Another partner, a tenant's admin key, or a key-less caller: none reaches the account.
    const other = { subject: 'partner_key:x', tenantRef: `partner:${rival}`, scopes: ['partner'], partnerId: rival };
    await expect(call('partnerGetAccount', { account: 'user-1' }, other)).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(call('partnerCreateKey', { account: 'user-1', name: 'Theirs' }, other)).rejects.toMatchObject({
      code: 'account_not_found',
    });
    expect(await call('partnerListAccounts', {}, other)).toEqual({ accounts: [] });
    const adminKey = { subject: 'api_key:a', tenantRef, scopes: ['read', 'write', 'admin'] };
    await expect(call('partnerListAccounts', {}, adminKey)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call('partnerListAccounts', {}, { ...adminKey, partnerId: stackapi })).rejects.toMatchObject({
      code: 'forbidden',
    });

    // Suspended by its partner: reads only; lifted by it. One Pylota made, it cannot lift.
    expect(await call('partnerSuspendAccount', { account: 'user-1', reason: 'unpaid' })).toEqual({ suspended: true });
    expect(await store.isTenantSuspended({ tenantRef })).toBe(true);
    expect(await call('partnerUnsuspendAccount', { account: 'user-1' })).toEqual({ unsuspended: true });
    await createSlotlockStore(admin).suspendTenant({ tenantRef, reason: 'abuse' });
    expect(await call('partnerUnsuspendAccount', { account: 'user-1' })).toEqual({ unsuspended: false });
    expect(await store.isTenantSuspended({ tenantRef })).toBe(true);
    await createSlotlockStore(admin).unsuspendTenant({ tenantRef });

    // Its usage, the counts Pylota invoices from; another partner's is not there.
    await admin`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
      VALUES (${tenantRef}, current_date, 'operations', '', 'rest', 7),
             (${tenantRef}, current_date, 'operations', '', 'mcp', 5)`;
    const today = new Date().toISOString().slice(0, 10);
    expect(await call('partnerGetUsage', { from: today, to: today })).toMatchObject({
      usage: [{ account: 'user-1', day: today, metric: 'operations', count: 12 }],
    });
    expect(await call('partnerGetUsage', { from: today, to: today }, other)).toMatchObject({ usage: [] });

    // A suspended partner: its accounts' keys and its own stop, and the accounts are suspended.
    await setSlotlockPartnerStatus(admin, stackapi, 'suspended');
    expect(await authenticateKey(bearer(rotated.key))).toBeNull();
    expect(await authenticatePartner(bearer(partnerKey))).toBeNull();
    expect(await store.isTenantSuspended({ tenantRef })).toBe(true);
    await setSlotlockPartnerStatus(admin, stackapi, 'active');
    expect(await authenticateKey(bearer(rotated.key))).toMatchObject({ tenantRef });

    // Erased: the tenant, its keys and the partner's record of it.
    await expect(call('partnerEraseAccount', { account: 'user-1', confirm: 'user-2' })).rejects.toMatchObject({
      code: 'confirmation_mismatch',
    });
    expect(await call('partnerEraseAccount', { account: 'user-1', confirm: 'user-1' })).toMatchObject({ erased: true });
    expect(await authenticateKey(bearer(rotated.key))).toBeNull();
    expect(await call('partnerListAccounts', {})).toEqual({ accounts: [] });
    expect(await readSlotlockTenantPlan(application, tenantRef)).toBeNull();
  });

  it('closes a month once: priced lines recorded, usage.period_closed signed, Stripe items made once', async () => {
    await putSlotlockPartner(admin, { id: billed, name: 'Billed', contract: CONTRACT });
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    await setSlotlockPartnerBilling(admin, billed, {
      stripeCustomer: 'cus_Billed123',
      webhookUrl: 'https://partner.example.com/slotlock',
      webhookSecret: secret,
    });
    const partners = createSlotlockPartnerStore(admin, {
      keys: createSlotlockApiKeyStore(admin),
      eraseTenant: async () => ({ erased: true, total: 0 }) as never,
    });
    for (const account of ['busy', 'quiet', 'idle']) await partners.putAccount(billed, account, 'partner_free');
    const month = slotlockPreviousMonth(Date.now());
    const day = (n: number) => `${month}-0${n}`;
    // busy: 25,000 operations against a 10,000 quota; quiet: one; idle: a resource and nothing run.
    await admin`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count) VALUES
        (${`partner:${billed}:busy`}, ${day(1)}::date, 'operations', '', 'rest', 20000),
        (${`partner:${billed}:busy`}, ${day(2)}::date, 'operations', '', 'mcp', 5000),
        (${`partner:${billed}:busy`}, ${day(1)}::date, 'resources', '', 'store', 3),
        (${`partner:${billed}:busy`}, ${day(2)}::date, 'resources', '', 'store', 4),
        (${`partner:${billed}:quiet`}, ${day(3)}::date, 'operations', '', 'rest', 1),
        (${`partner:${billed}:idle`}, ${day(3)}::date, 'resources', '', 'store', 1),
        (${`partner:${billed}:busy`}, current_date, 'operations', '', 'rest', 999999)`;

    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const items: URLSearchParams[] = [];
    let failNext = 'minimum';
    const stripe = {
      secretKey: 'sk_test_partner',
      fetch: (async (_url: string, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));
        if (form.get('metadata[slotlock_line]') === failNext) {
          failNext = '';
          return new Response('{"error":{}}', { status: 500 });
        }
        items.push(form);
        return Response.json({ id: `ii_${form.get('metadata[slotlock_line]')?.replaceAll('_', '')}` });
      }) as typeof fetch,
    };
    const first = await closeSlotlockPartnerMonth(admin, {
      partnerId: billed,
      month,
      stripe,
      send: async (request) => {
        sent.push(request);
        return { status: 204 };
      },
    });
    expect(first.accounts).toEqual(
      expect.arrayContaining([
        { account: 'busy', plan: 'partner_free', totals: { operations: 25000, resources: 4 } },
        { account: 'quiet', plan: 'partner_free', totals: { operations: 1 } },
        { account: 'idle', plan: 'partner_free', totals: { resources: 1 } },
      ]),
    );
    expect(first.lines.map(({ line, quantity, amount }) => ({ line, quantity, amount }))).toEqual([
      { line: 'active_accounts', quantity: 2, amount: 1200 },
      { line: 'minimum', quantity: 1, amount: 10000 - 1400 },
      { line: 'operations_over_quota', quantity: 2, amount: 200 },
    ]);
    expect(first).toMatchObject({ webhook: 204, invoiced: 2, pending: 1 });

    // The webhook: signed as any Slotlock webhook, with the numbers and their checksum.
    const [hook] = sent;
    expect(hook?.url).toBe('https://partner.example.com/slotlock');
    const id = hook?.headers['webhook-id'] as string;
    const timestamp = Number(hook?.headers['webhook-timestamp']);
    expect(hook?.headers['webhook-signature']).toBe(signSlotlockWebhook({ secret, id, timestamp, body: hook?.body as string }));
    expect(JSON.parse(hook?.body as string)).toMatchObject({
      type: 'usage.period_closed',
      partner: billed,
      month,
      checksum: first.checksum,
      lines: expect.arrayContaining([expect.objectContaining({ line: 'minimum', amount: 8600 })]),
    });
    expect(items.map((form) => [form.get('customer'), form.get('amount'), form.get('currency')])).toEqual([
      ['cus_Billed123', '1200', 'usd'],
      ['cus_Billed123', '200', 'usd'],
    ]);

    // Run again, after more use arrived and the contract's prices changed: the lines stand, and only
    // the one Stripe did not take is sent, with the same webhook id.
    await putSlotlockPartner(admin, {
      id: billed,
      name: 'Billed',
      contract: { ...CONTRACT, pricing: { ...CONTRACT.pricing, active_account: 99999 } },
    });
    const again = await closeSlotlockPartnerMonth(admin, { partnerId: billed, month, stripe, send: async (request) => {
      sent.push(request);
      return { status: 200 };
    } });
    expect(again.lines.map((line) => line.amount)).toEqual([1200, 8600, 200]);
    expect(again).toMatchObject({ invoiced: 1, pending: 0 });
    expect(items).toHaveLength(3);
    expect(sent[1]?.headers['webhook-id']).toBe(id);
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.partner_invoices WHERE partner_id = ${billed} AND stripe_item IS NOT NULL`)[0],
    ).toEqual({ n: 3 });

    // This month has not ended; a partner with no webhook or Stripe key records and waits.
    const now = new Date().toISOString().slice(0, 7);
    await expect(closeSlotlockPartnerMonth(admin, { partnerId: billed, month: now })).rejects.toMatchObject({
      code: 'month_not_ended',
    });
    await expect(closeSlotlockPartnerMonth(admin, { partnerId: 'nobody-here', month })).rejects.toMatchObject({
      code: 'partner_not_found',
    });
  });
});
