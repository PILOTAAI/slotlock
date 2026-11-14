// Approvals in the dashboard (RFC 0004 A4), as the LOGIN role grantApplicationRole grants: an agent's
// booking a policy holds is listed, approved (booked as the agent asked) or declined with a reason.
// GitHub is a fake `fetch`. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { SLOTLOCK_PLAN_QUOTAS } from '../plans.js';
import { createSlotlockQuotas, readSlotlockQuotaUse, slotlockQuotaPeriod } from '../quotas.js';
import { createSlotlockStore } from '../store.js';
import { runSlotlockDashboardRequest, setSlotlockDashboardRequestScope } from '../dashboard-scope.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';
const HOUR = 3_600_000;

describe.skipIf(!url)('dashboard approvals (real Postgres)', () => {
  const role = `slotlock_dapp_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const githubId = 800_000 + Math.floor(Math.random() * 99_999);
  const tenantRef = `github:${githubId}`;
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
    await admin`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await admin`SELECT * FROM slotlock.erase_tenant(${`${tenantRef}~test`}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('lists what waits, books it when approved, and frees it when declined', async () => {
    const store = createSlotlockStore(application);
    const agentBackend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 },
      ],
    });
    const dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liApprovals', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: [String(githubId)],
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store, { agentBackend }),
      state: createSlotlockDashboardState(application),
      fetch: async (input) =>
        String(input).endsWith('/access_token')
          ? Response.json({ access_token: 'gho_fake' })
          : Response.json({ id: githubId, login: 'fleet-manager' }),
    });
    const get = (path: string, cookie?: string) =>
      dashboard.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
    const post = async (path: string, fields: Record<string, string>, cookie: string) => {
      const sent = new URLSearchParams(fields);
      const page = await (await get('/dashboard/keys', cookie)).text();
      sent.set('csrf', /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string);
      sent.set('once', /name="once" value="([^"]+)"/.exec(page)?.[1] as string);
      return dashboard.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      );
    };
    const start = await get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(`/dashboard/callback?code=c&state=${state}`, pending);
    const session = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0] as string;
    const page = async (path: string) => (await get(path, session)).text();

    const van = await store.withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef: 'van-7', timezone: 'UTC' }),
    );
    await store.withTenant(tenantRef, (tenant) =>
      tenant.putApprovalPolicy({ tenantRef, ref: 'vans', name: 'Vans', outcome: 'require_approval' }),
    );
    const base = Date.UTC(new Date().getUTCFullYear() + 1, 1, 2);
    const ask = (hour: number) =>
      invokeSlotlockAgentOperation({
        operation: 'slotlock_create_event',
        input: {
          resource_id: van.id,
          starts_at: new Date(base + hour * HOUR).toISOString(),
          ends_at: new Date(base + (hour + 1) * HOUR).toISOString(),
          timezone: 'UTC',
          idempotency_key: `ask-${hour}`,
        },
        request: new Request(ORIGIN),
        options: {
          backend: agentBackend,
          authenticate: async () => ({ subject: 'courier-agent', tenantRef, scopes: ['read', 'write'] }),
          authorize: async () => true,
        },
      }) as Promise<{ ok: false; code: string; details?: Record<string, string> }>;
    const first = await ask(9);
    const second = await ask(12);
    expect([first.code, second.code]).toEqual(['approval_pending', 'approval_pending']);

    const listed = await page('/dashboard/approvals');
    expect(listed).toContain('href="/dashboard/approvals"');
    expect(listed).toContain('<span class="stat-label">Waiting for you</span><span class="stat-value">2</span>');
    expect(listed).toContain('van-7');
    expect(listed).toContain('courier-agent');

    const approved = await post('/dashboard/approvals/decide', { id: first.details?.approval_id as string, decision: 'grant' }, session);
    expect(approved.status).toBe(303);
    const granted = await store.withTenant(tenantRef, (tenant) =>
      tenant.getApproval({ tenantRef, id: first.details?.approval_id as string }),
    );
    expect(granted).toMatchObject({ status: 'granted', decidedBy: `github:${githubId}` });

    const declined = await post(
      '/dashboard/approvals/decide',
      { id: second.details?.approval_id as string, decision: 'decline', reason: 'Van booked for service' },
      session,
    );
    expect(declined.status).toBe(303);
    const after = await page('/dashboard/approvals');
    expect(after).toContain('<span class="stat-label">Waiting for you</span><span class="stat-value">0</span>');
    expect(after).toContain('Van booked for service');
    expect(after).toContain('>Approved</span>');
    // The agent's retry learns how each was decided.
    expect((await ask(9)) as unknown).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await ask(12)).toMatchObject({ code: 'approval_declined' });
    // Deciding again says it was decided.
    const again = await post('/dashboard/approvals/decide', { id: first.details?.approval_id as string, decision: 'grant' }, session);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('That approval was already decided.');
  });

  it("keeps a limited member's request to their resources and the approvals that ask only for them (RFC 0004 D1)", async () => {
    const store = createSlotlockStore(application);
    const agentBackend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 },
      ],
    });
    const resources = createSlotlockDashboardResources(store, { agentBackend });
    expect(resources.keepsToScope).toBe(true);
    const scopedRef = `${tenantRef}-scoped`;
    try {
      const [north, south] = await store.withTenant(scopedRef, async (tenant) => {
        await tenant.putLocation({ tenantRef: scopedRef, ref: 'north', name: 'North' });
        await tenant.putLocation({ tenantRef: scopedRef, ref: 'south', name: 'South' });
        await tenant.putApprovalPolicy({ tenantRef: scopedRef, ref: 'all', name: 'All', outcome: 'require_approval' });
        return [
          await tenant.createResource({ tenantRef: scopedRef, externalRef: 'van-north', timezone: 'UTC', location: 'north' }),
          await tenant.createResource({ tenantRef: scopedRef, externalRef: 'van-south', timezone: 'UTC', location: 'south' }),
        ];
      });
      const base = Date.UTC(new Date().getUTCFullYear() + 1, 3, 4);
      const ask = (resourceId: string, key: string) =>
        invokeSlotlockAgentOperation({
          operation: 'slotlock_create_event',
          input: {
            resource_id: resourceId,
            starts_at: new Date(base + 9 * HOUR).toISOString(),
            ends_at: new Date(base + 10 * HOUR).toISOString(),
            timezone: 'UTC',
            idempotency_key: key,
          },
          request: new Request(ORIGIN),
          options: {
            backend: agentBackend,
            authenticate: async () => ({ subject: 'courier-agent', tenantRef: scopedRef, scopes: ['read', 'write'] }),
            authorize: async () => true,
          },
        }) as Promise<{ ok: false; code: string; details?: Record<string, string> }>;
      const northAsk = await ask((north as { id: string }).id, 'scoped-north');
      const southAsk = await ask((south as { id: string }).id, 'scoped-south');
      expect([northAsk.code, southAsk.code]).toEqual(['approval_pending', 'approval_pending']);
      const approvals = resources.approvals as NonNullable<typeof resources.approvals>;

      // Unlimited: both resources and both approvals.
      await runSlotlockDashboardRequest(async () => {
        expect((await resources.list(scopedRef)).map((resource) => resource.externalRef).sort()).toEqual(['van-north', 'van-south']);
        expect(await approvals.list(scopedRef, 10)).toHaveLength(2);
      });
      // Limited to North: its resource, its approval; the South one is not found to decide.
      await runSlotlockDashboardRequest(async () => {
        setSlotlockDashboardRequestScope({ locations: ['north'], groups: [] });
        expect((await resources.list(scopedRef)).map((resource) => resource.externalRef)).toEqual(['van-north']);
        expect((await approvals.list(scopedRef, 10)).map((approval) => approval.id)).toEqual([northAsk.details?.approval_id]);
        expect(await approvals.decide(scopedRef, southAsk.details?.approval_id as string, 'decline', 'github:1')).toEqual({
          ok: false,
          code: 'approval_not_found',
        });
        expect(await approvals.decide(scopedRef, northAsk.details?.approval_id as string, 'decline', 'github:1', 'No')).toEqual({ ok: true });
      });
      // A request after it is limited by nothing it did not set.
      await runSlotlockDashboardRequest(async () => {
        expect(await resources.list(scopedRef)).toHaveLength(2);
      });
      const southLeft = await store.withTenant(scopedRef, (tenant) => tenant.getApproval({ tenantRef: scopedRef, id: southAsk.details?.approval_id as string }));
      expect(southLeft?.status).toBe('pending');
    } finally {
      await admin`SELECT * FROM slotlock.erase_tenant(${scopedRef}::text)`;
    }
  });

  it('refuses to approve past the month’s bookings, says why, and still declines', async () => {
    const memberId = githubId + 100_000;
    const quotedRef = `github:${memberId}`;
    const store = createSlotlockStore(application);
    const agentBackend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 },
      ],
    });
    // Free's quotas, over the database's count of the month.
    const quotas = createSlotlockQuotas({
      plan: async () => SLOTLOCK_PLAN_QUOTAS.free,
      used: (tenant, fromDay) => readSlotlockQuotaUse(application, tenant, fromDay),
    });
    const dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liQuotas', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: [String(memberId)],
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store, { agentBackend, quotas }),
      state: createSlotlockDashboardState(application),
      fetch: async (input) =>
        String(input).endsWith('/access_token')
          ? Response.json({ access_token: 'gho_fake' })
          : Response.json({ id: memberId, login: 'quota-manager' }),
    });
    const get = (path: string, cookie?: string) =>
      dashboard.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
    const post = async (path: string, fields: Record<string, string>, cookie: string) => {
      const sent = new URLSearchParams(fields);
      const page = await (await get('/dashboard/keys', cookie)).text();
      sent.set('csrf', /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string);
      sent.set('once', /name="once" value="([^"]+)"/.exec(page)?.[1] as string);
      return dashboard.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      );
    };
    try {
      const start = await get('/dashboard/sign-in');
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
      const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
      const callback = await get(`/dashboard/callback?code=c&state=${state}`, pending);
      const session = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith('__Host-slotlock-session='))
        ?.split('; ')[0] as string;
      const van = await store.withTenant(quotedRef, async (tenant) => {
        await tenant.putApprovalPolicy({ tenantRef: quotedRef, ref: 'vans', name: 'Vans', outcome: 'require_approval' });
        return tenant.createResource({ tenantRef: quotedRef, externalRef: 'van-9', timezone: 'UTC' });
      });
      const base = Date.UTC(new Date().getUTCFullYear() + 1, 4, 5);
      const ask = (hour: number) =>
        invokeSlotlockAgentOperation({
          operation: 'slotlock_create_event',
          input: {
            resource_id: van.id,
            starts_at: new Date(base + hour * HOUR).toISOString(),
            ends_at: new Date(base + (hour + 1) * HOUR).toISOString(),
            timezone: 'UTC',
            idempotency_key: `quota-ask-${hour}`,
          },
          request: new Request(ORIGIN),
          options: {
            backend: agentBackend,
            authenticate: async () => ({ subject: 'courier-agent', tenantRef: quotedRef, scopes: ['read', 'write'] }),
            authorize: async () => true,
          },
        }) as Promise<{ ok: false; code: string; details?: Record<string, string> }>;
      const first = await ask(9);
      const second = await ask(12);
      expect([first.code, second.code]).toEqual(['approval_pending', 'approval_pending']);
      // This month's bookings at Free's stop (1,000), as the roll-up would leave them.
      const month = slotlockQuotaPeriod(Date.now()).periodStart;
      await admin`INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
                  VALUES (${quotedRef}, ${new Date().toISOString().slice(0, 10)}::date, 'bookings', '', 'rest', 1000)`;

      const refused = await post('/dashboard/approvals/decide', { id: first.details?.approval_id as string, decision: 'grant' }, session);
      expect(refused.status).toBe(429);
      expect(await refused.text()).toContain(
        `This month&#39;s bookings are used up: Slotlock refuses new bookings, approvals included, with quota_exceeded until ${slotlockQuotaPeriod(Date.now()).resetsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Decline it to free its time.`,
      );
      const still = await store.withTenant(quotedRef, (tenant) =>
        tenant.getApproval({ tenantRef: quotedRef, id: first.details?.approval_id as string }),
      );
      expect(still?.status).toBe('pending');
      expect((await readSlotlockQuotaUse(admin, quotedRef, month)).bookings).toBe(1_000);
      const declined = await post('/dashboard/approvals/decide', { id: second.details?.approval_id as string, decision: 'decline' }, session);
      expect(declined.status).toBe(303);
    } finally {
      await admin`SELECT * FROM slotlock.erase_tenant(${quotedRef}::text)`;
    }
  });

  it('loads a sample into Test, moves its waiting forward and empties it, and never in Live (RFC 0004 A6)', async () => {
    const store = createSlotlockStore(application);
    const dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liSandbox', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: [String(githubId)],
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      fetch: async (input) =>
        String(input).endsWith('/access_token')
          ? Response.json({ access_token: 'gho_fake' })
          : Response.json({ id: githubId, login: 'fleet-manager' }),
    });
    const get = (path: string, cookie?: string) =>
      dashboard.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
    const post = async (path: string, fields: Record<string, string>, cookie: string) => {
      const sent = new URLSearchParams(fields);
      const page = await (await get('/dashboard/keys', cookie)).text();
      sent.set('csrf', /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string);
      sent.set('once', /name="once" value="([^"]+)"/.exec(page)?.[1] as string);
      return dashboard.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      );
    };
    const start = await get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(`/dashboard/callback?code=c&state=${state}`, pending);
    let session = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0] as string;
    // Live has no sandbox, and refuses its actions.
    expect(await (await get('/dashboard', session)).text()).not.toContain('id="sandbox"');
    expect((await post('/dashboard/sandbox/seed', { scenario: 'clinic' }, session)).status).toBe(400);
    const switched = await post('/dashboard/environment', { environment: 'test' }, session);
    session =
      switched.headers
        .getSetCookie()
        .find((value) => value.startsWith('__Host-slotlock-session='))
        ?.split('; ')[0] ?? session;
    expect(await (await get('/dashboard', session)).text()).toContain('id="sandbox"');
    const seeded = await post('/dashboard/sandbox/seed', { scenario: 'clinic' }, session);
    expect(seeded.status).toBe(200);
    expect(await seeded.text()).toContain('Loaded 4 resources and 3 bookings for tomorrow.');
    const test = `${tenantRef}~test`;
    expect(await store.withTenant(test, (tenant) => tenant.countResources({ tenantRef: test }))).toBe(4);
    expect(await store.withTenant(tenantRef, (tenant) => tenant.countResources({ tenantRef }))).toBe(1);
    const moved = await post('/dashboard/sandbox/fast-forward', { minutes: '60' }, session);
    expect(await moved.text()).toContain('0 holds and 0 approvals lapsed.');
    expect((await post('/dashboard/sandbox/reset', {}, session)).status).toBe(303);
    expect(await store.withTenant(test, (tenant) => tenant.countResources({ tenantRef: test }))).toBe(0);
  });
});
