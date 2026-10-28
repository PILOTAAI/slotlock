// The assistant's records against real Postgres, as a LOGIN role without BYPASSRLS that
// grantApplicationRole granted: both tables are under forced row-level security, a tenant reads and
// writes only its own settings and conversations, an approval is claimed once however many race,
// a conversation lapses and maintenance deletes it, a long conversation in any script stays under
// the tables' CHECKs, and erase_tenant deletes both. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { openSlotlockAssistantKey, sealSlotlockAssistantKey } from '../assistant.js';
import {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { maintainSlotlockTenant } from '../maintenance.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { startFakeModel } from './helpers/fake-model.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const SECRET = randomBytes(32).toString('hex');

describe.skipIf(!url)('assistant records (real Postgres)', () => {
  const role = `slotlock_asst_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenant = `github-org:${900_000 + Math.floor(Math.random() * 99_999)}`;
  const other = `github-org:${800_000 + Math.floor(Math.random() * 99_999)}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(
      Object.assign(new URL(url as string), { username: role, password }).href,
      { max: 4, onnotice: () => {} },
    );
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of [tenant, other]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps both tables under forced row-level security', async () => {
    const rows = await admin<{ relname: string; enabled: boolean; forced: boolean }[]>`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'slotlock' AND c.relname IN ('assistant_settings', 'assistant_conversations')
       ORDER BY c.relname`;
    expect(rows).toEqual([
      { relname: 'assistant_conversations', enabled: true, forced: true },
      { relname: 'assistant_settings', enabled: true, forced: true },
    ]);
    const contracts = await admin<{ table_name: string }[]>`
      SELECT table_name FROM slotlock.rls_policy_contracts
       WHERE table_name IN ('assistant_settings', 'assistant_conversations') ORDER BY table_name`;
    expect(contracts.map(({ table_name }) => table_name)).toEqual([
      'assistant_conversations',
      'assistant_settings',
    ]);
  });

  it("shows a tenant only its own settings and conversations, and refuses writing another's", async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const sealed = await sealSlotlockAssistantKey(SECRET, tenant, 'sk-integration-key-1234');
    await adapter.putSettings(
      tenant,
      { provider: 'anthropic', baseUrl: 'https://api.example.com', model: 'your-model', key: { sealed, hint: '1234' } },
      'github:1',
    );
    await adapter.putConversation(tenant, 'github:1', { messages: [{ role: 'user', text: 'secret plans' }], added: {}, keep: [] }, 60_000);

    const mine = await adapter.getSettings(tenant);
    expect(mine).toMatchObject({ provider: 'anthropic', model: 'your-model', keyHint: '1234', updatedBy: 'github:1' });
    await expect(openSlotlockAssistantKey(SECRET, tenant, mine?.sealedKey as string)).resolves.toBe('sk-integration-key-1234');
    expect(await adapter.getSettings(other)).toBeNull();
    expect(await adapter.getConversation(other, 'github:1')).toBeNull();

    // Inside the other tenant's transaction, naming this tenant reads and writes nothing.
    await expect(
      store.withTenant(other, (scoped) => scoped.getAssistantSettings({ tenantRef: tenant })),
    ).resolves.toBeNull();
    await expect(
      store.withTenant(other, (scoped) =>
        scoped.getAssistantConversation({ tenantRef: tenant, memberRef: 'github:1' }),
      ),
    ).resolves.toBeNull();
    await expect(
      store.withTenant(other, (scoped) =>
        scoped.putAssistantSettings({ tenantRef: tenant, provider: 'openai', baseUrl: 'https://evil.example.com', model: 'm', key: null }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      store.withTenant(other, (scoped) => scoped.deleteAssistantSettings({ tenantRef: tenant })),
    ).resolves.toBe(false);
    // Outside any tenant, the serving role sees no row at all.
    const [bare] = await application<{ count: string }[]>`
      SELECT (SELECT count(*) FROM slotlock.assistant_settings)
           + (SELECT count(*) FROM slotlock.assistant_conversations) AS count`;
    expect(Number(bare?.count)).toBe(0);
    expect((await adapter.getSettings(tenant))?.baseUrl).toBe('https://api.example.com');

    // Saved without a new key for the same provider and URL, the key stays.
    await adapter.putSettings(tenant, { provider: 'anthropic', baseUrl: 'https://api.example.com', model: 'other', key: 'keep' });
    expect(await adapter.getSettings(tenant)).toMatchObject({ model: 'other', keyHint: '1234', sealedKey: sealed });
  });

  it('lets one of many racing approvals claim an action, and lapses a conversation', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const action = { operation: 'slotlock_delete_event', input: { event_id: 'agent:x' }, status: 'pending' };
    await adapter.putConversation(tenant, 'github:2', { messages: [], added: { a1: action }, keep: ['a1'] }, 60_000);
    // Stored again with the action pending: the stored state wins over the copy sent.
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => adapter.settleAction(tenant, 'github:2', 'a1', 'pending', { status: 'approved' })),
    );
    expect(claims.filter((claim) => claim !== null)).toEqual([{ ...action, status: 'approved' }]);
    await adapter.putConversation(tenant, 'github:2', { messages: [{ role: 'note', text: 'n' }], added: { a1: action }, keep: ['a1'] }, 60_000);
    expect((await adapter.getConversation(tenant, 'github:2'))?.actions.a1?.status).toBe('approved');
    expect(await adapter.settleAction(other, 'github:2', 'a1', 'approved', { status: 'done' })).toBeNull();

    await adapter.putConversation(tenant, 'github:3', { messages: [], added: {}, keep: [] }, 1_000);
    expect(await adapter.getConversation(tenant, 'github:3')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await adapter.getConversation(tenant, 'github:3')).toBeNull();
  });

  it('L3: deletes expired conversations in the maintenance pass', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putConversation(tenant, 'github:7', { messages: [], added: {}, keep: [] }, 1_000);
    await adapter.putConversation(tenant, 'github:8', { messages: [], added: {}, keep: [] }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const count = async () =>
      Number(
        (
          await admin<{ count: string }[]>`
          SELECT count(*) FROM slotlock.assistant_conversations
           WHERE tenant_ref = ${tenant} AND member_ref IN ('github:7', 'github:8')`
        )[0]?.count,
      );
    expect(await count()).toBe(2);
    const pass = await maintainSlotlockTenant(store, tenant);
    expect(pass.pruned).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(1);
    expect(await adapter.getConversation(tenant, 'github:8')).not.toBeNull();
  });

  it('L2: answers a long CJK conversation to the end, under the CHECK on messages and actions', async () => {
    const model = await startFakeModel('openai');
    const org = 700_000 + Math.floor(Math.random() * 99_999);
    const orgTenant = `github-org:${org}`;
    const cjk = '明日の午前中に空いている車を探して予約してください。'.repeat(160);
    try {
      const dashboard = createSlotlockDashboard({
        publicUrl: 'https://slotlock.example.com',
        github: { clientId: 'Ov23liL2', clientSecret: randomBytes(20).toString('hex') },
        sessionSecret: randomBytes(32).toString('hex'),
        allowedUsers: '*',
        organizations: [String(org)],
        keys: createSlotlockApiKeyStore(application),
        resources: createSlotlockDashboardResources(store),
        state: createSlotlockDashboardState(application),
        fetch: async (input) => {
          const target = String(input);
          if (target.endsWith('/access_token')) return Response.json({ access_token: 'gho_x' });
          if (target === 'https://api.github.com/user') return Response.json({ id: 31, login: 'cjk-owner' });
          return Response.json([{ state: 'active', role: 'admin', organization: { id: org, login: 'cjk-fleet' } }]);
        },
        assistant: {
          secret: SECRET,
          privateUrls: true,
          rate: { perSecond: 100, burst: 100 },
          backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
        },
      });
      const origin = 'https://slotlock.example.com';
      const start = await dashboard.fetch(new Request(`${origin}/dashboard/sign-in`));
      const state = new URL(start.headers.get('location') as string).searchParams.get('state');
      const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
      const callback = await dashboard.fetch(
        new Request(`${origin}/dashboard/callback?code=c&state=${state}`, { headers: { cookie: pending } }),
      );
      const cookie = callback.headers.getSetCookie().find((value) => value.startsWith('__Host-slotlock-session='))?.split('; ')[0] as string;
      const post = async (path: string, fields: Record<string, string>) => {
        const form = await (await dashboard.fetch(new Request(`${origin}/dashboard/keys`, { headers: { cookie } }))).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1] as string;
        const once = /name="once" value="([^"]+)"/.exec(form)?.[1] as string;
        return dashboard.fetch(
          new Request(`${origin}${path}`, {
            method: 'POST',
            headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf, once, ...fields }).toString(),
          }),
        );
      };
      expect((await post('/dashboard/settings/assistant', { provider: 'openai', base_url: model.baseUrl, model: 'your-model' })).status).toBe(303);
      // Each turn: a read whose result is long, then a long answer, every one in CJK.
      model.script((request) =>
        ((request.body.messages as Array<{ role: string }>).at(-1)?.role === 'tool'
          ? { text: cjk.slice(0, 8_000) }
          : { text: cjk.slice(0, 3_000), calls: [{ name: 'slotlock_list_resources', input: {} }] }),
      );
      for (let turn = 0; turn < 20; turn += 1) {
        expect((await post('/dashboard/assistant', { message: cjk.slice(0, 2_000) })).status, `turn ${turn}`).toBe(303);
      }
      const [row] = await admin<{ messages: number; actions: number }[]>`
        SELECT octet_length(messages::text) AS messages, octet_length(actions::text) AS actions
          FROM slotlock.assistant_conversations WHERE tenant_ref = ${orgTenant} AND member_ref = 'github:31'`;
      expect(row?.messages).toBeGreaterThan(100_000);
      expect(row?.messages).toBeLessThanOrEqual(262_144);
    } finally {
      await model.close();
      await admin`SELECT * FROM slotlock.erase_tenant(${orgTenant}::text)`;
    }
  });

  it('sweeps every tenant’s expired conversations, a tenant no key ever served included', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const chatOnly = `github-org:${600_000 + Math.floor(Math.random() * 99_999)}`;
    try {
      await adapter.putConversation(chatOnly, 'github:41', { messages: [], added: {}, keep: [] }, 1_000);
      await adapter.putConversation(other, 'github:42', { messages: [], added: {}, keep: [] }, 1_000);
      await adapter.putConversation(other, 'github:43', { messages: [], added: {}, keep: [] }, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const rows = async () =>
        (
          await admin<{ tenant_ref: string; member_ref: string }[]>`
          SELECT tenant_ref, member_ref FROM slotlock.assistant_conversations
           WHERE member_ref IN ('github:41', 'github:42', 'github:43') ORDER BY member_ref`
        ).map(({ member_ref }) => member_ref);
      expect(await rows()).toEqual(['github:41', 'github:42', 'github:43']);
      // As the serving role, outside any tenant: one statement for every tenant.
      expect(await store.sweepAssistantConversations()).toBeGreaterThanOrEqual(2);
      expect(await rows()).toEqual(['github:43']);
      const listed = await admin<{ tenant_ref: string; next_expiry: Date }[]>`
        SELECT tenant_ref, next_expiry FROM slotlock.assistant_tenants
         WHERE tenant_ref IN (${chatOnly}, ${other})`;
      expect(listed.map(({ tenant_ref }) => tenant_ref)).toEqual([other]);
      expect(listed[0]?.next_expiry.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await admin`SELECT * FROM slotlock.erase_tenant(${chatOnly}::text)`;
    }
  });

  it("deletes a tenant's expired conversations when one of its conversations is read", async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putConversation(other, 'github:51', { messages: [], added: {}, keep: [] }, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await adapter.getConversation(other, 'github:52');
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*) FROM slotlock.assistant_conversations WHERE tenant_ref = ${other} AND member_ref = 'github:51'`;
    expect(Number(row?.count)).toBe(0);
  });

  it('puts no action back into a conversation that no longer has it, and keeps a settled one settled', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const pending = { operation: 'slotlock_delete_event', input: { event_id: 'agent:y' }, status: 'pending' };
    await adapter.putConversation(other, 'github:61', { messages: [], added: { x1: pending }, keep: [] }, 60_000);
    await adapter.settleAction(other, 'github:61', 'x1', 'pending', { status: 'done', input: {} });
    // A stale turn carries x1 as it stood: the row's state stands.
    await adapter.putConversation(other, 'github:61', { messages: [], added: { x1: pending }, keep: ['x1'] }, 60_000);
    expect((await adapter.getConversation(other, 'github:61'))?.actions.x1).toMatchObject({ status: 'done', input: {} });
    // Reset while the turn ran: the row is gone, and only new actions go in.
    await adapter.deleteConversation(other, 'github:61');
    await adapter.putConversation(other, 'github:61', { messages: [], added: { x2: pending }, keep: ['x1'] }, 60_000);
    expect(Object.keys((await adapter.getConversation(other, 'github:61'))?.actions ?? {})).toEqual(['x2']);
  });

  it('keeps the key only for the provider and base URL it was entered for, in the write itself', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const shared = `github-org:${500_000 + Math.floor(Math.random() * 99_999)}`;
    try {
      const base = { provider: 'openai' as const, baseUrl: 'https://gateway.example.com/team-a/v1', model: 'your-model' };
      await adapter.putSettings(shared, { ...base, key: { sealed: 'v1.a.b', hint: 'abcd' } });
      for (const changed of [
        { ...base, baseUrl: 'https://gateway.example.com/team-b/v1' },
        { ...base, provider: 'anthropic' as const },
      ]) {
        expect(await adapter.putSettings(shared, { ...changed, key: 'keep' })).toEqual({ saved: false });
        expect(await adapter.getSettings(shared)).toMatchObject({ ...base, sealedKey: 'v1.a.b' });
      }
      // Racing saves to another URL: none carries the key there.
      const raced = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          adapter.putSettings(shared, { ...base, baseUrl: `https://elsewhere-${index}.example.com/v1`, key: 'keep' }),
        ),
      );
      expect(raced.every(({ saved }) => !saved)).toBe(true);
      expect((await adapter.getSettings(shared))?.baseUrl).toBe(base.baseUrl);
      expect(await adapter.putSettings(shared, { ...base, model: 'other-model', key: 'keep' })).toEqual({ saved: true });
      expect(await adapter.putSettings(shared, { ...base, baseUrl: 'https://other.example.com/v1', key: null })).toEqual({ saved: true });
    } finally {
      await admin`SELECT * FROM slotlock.erase_tenant(${shared}::text)`;
    }
  });

  it("erases a tenant's settings and conversations, and no other tenant's", async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putSettings(other, { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', key: null });
    await adapter.putConversation(other, 'github:9', { messages: [], added: {}, keep: [] }, 60_000);
    const erased = await store.eraseTenant({ tenantRef: tenant });
    expect(erased.rows.assistant_settings).toBe(1);
    expect(erased.rows.assistant_conversations).toBeGreaterThanOrEqual(2);
    expect(await adapter.getSettings(tenant)).toBeNull();
    expect(await adapter.getConversation(tenant, 'github:1')).toBeNull();
    expect(await adapter.getSettings(other)).not.toBeNull();
    expect(await adapter.getConversation(other, 'github:9')).not.toBeNull();
    const again = await store.eraseTenant({ tenantRef: tenant });
    expect(again.rows.assistant_settings).toBe(0);
    expect(again.rows.assistant_conversations).toBe(0);
  });
});
