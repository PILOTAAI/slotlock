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
import { createSlotlockStore } from '../store.js';

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
});
