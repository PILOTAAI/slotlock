// The assistant's records under forced RLS, as the LOGIN role grantApplicationRole grants. Skipped
// without DATABASE_URL.
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

/** The conversation these tests keep, by the id a chat is named with. */
const CHAT = 'chat-0123456789a';

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

  it('keeps a member\u2019s chats until deleted, most recent first, at most 100, and only for that member', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const id = (n: number) => `history-${String(n).padStart(8, '0')}`;
    for (let n = 0; n < 101; n += 1) {
      await adapter.putChat(tenant, 'github:70', id(n), { title: `Chat ${String(n)}`, messages: [], added: {}, keep: [] }, null);
    }
    const listed = await adapter.listChats(tenant, 'github:70');
    expect(listed).toHaveLength(100);
    // The least recently used went: the first one.
    expect(listed[0]?.id).toBe(id(100));
    expect(listed.map((chat) => chat.id)).not.toContain(id(0));
    expect(await adapter.getChat(tenant, 'github:70', id(0))).toBeNull();
    const kept = await adapter.getChat(tenant, 'github:70', id(50));
    expect(kept).toMatchObject({ id: id(50), title: 'Chat 50', expiresAt: null });
    // Used again, it is the most recent; its title stays as given first.
    await adapter.putChat(tenant, 'github:70', id(50), { title: 'Another', messages: [{ role: 'user', text: 'x' }], added: {}, keep: [] }, null);
    expect((await adapter.listChats(tenant, 'github:70', 1))[0]).toMatchObject({ id: id(50), title: 'Chat 50' });
    expect(await adapter.renameChat(tenant, 'github:70', id(50), '  Van plans  ')).toBe(true);
    expect((await adapter.getChat(tenant, 'github:70', id(50)))?.title).toBe('Van plans');
    await expect(adapter.renameChat(tenant, 'github:70', id(50), 'x'.repeat(121))).rejects.toMatchObject({ code: 'invalid_identity' });
    // Another member, or another tenant, sees, renames and deletes none of them.
    expect(await adapter.listChats(tenant, 'github:71')).toEqual([]);
    expect(await adapter.getChat(tenant, 'github:71', id(50))).toBeNull();
    expect(await adapter.renameChat(tenant, 'github:71', id(50), 'Mine now')).toBe(false);
    expect(await adapter.deleteChat(other, 'github:70', id(50))).toBe(false);
    expect(await adapter.getChat(other, 'github:70', id(50))).toBeNull();
    expect(await adapter.deleteChat(tenant, 'github:70', id(50))).toBe(true);
    expect(await adapter.getChat(tenant, 'github:70', id(50))).toBeNull();
    expect(await adapter.listChats(tenant, 'github:70')).toHaveLength(99);
    await expect(
      adapter.putChat(tenant, 'github:70', 'not an id', { title: 'x', messages: [], added: {}, keep: [] }, null),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
  });

  it('keeps at most 100 chats when many are started at once', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const id = (n: number) => `racing-${String(n).padStart(9, '0')}`;
    for (let n = 0; n < 95; n += 1) {
      await adapter.putChat(tenant, 'github:72', id(n), { title: 'Old', messages: [], added: {}, keep: [] }, null);
    }
    // Each new chat inserts, then trims: without one member's writes in turn, each trim misses the
    // others' inserts and more than 100 stay.
    await Promise.all(
      Array.from({ length: 24 }, (_, k) =>
        adapter.putChat(tenant, 'github:72', id(1_000 + k), { title: 'New', messages: [], added: {}, keep: [] }, null),
      ),
    );
    const [stored] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.assistant_chats
       WHERE tenant_ref = ${tenant} AND member_ref = 'github:72'`;
    expect(stored?.count).toBe(100);
  });

  it('keeps a chat deleted while its turn ran deleted, and continues one still there', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const chat = 'deleted-0000000a';
    const turn = { title: 'Van', messages: [{ role: 'user', text: 'Is the van free?' }], added: {}, keep: [] };
    expect(await adapter.putChat(tenant, 'github:73', chat, turn, null)).toBe(true);
    // The turn ends with an update of the chat it began in.
    expect(await adapter.putChat(tenant, 'github:73', chat, { ...turn, create: false }, null)).toBe(true);
    expect(await adapter.deleteChat(tenant, 'github:73', chat)).toBe(true);
    expect(await adapter.putChat(tenant, 'github:73', chat, { ...turn, create: false }, null)).toBe(false);
    expect(await adapter.getChat(tenant, 'github:73', chat)).toBeNull();
    expect(await adapter.listChats(tenant, 'github:73')).toEqual([]);
  });

  it('moves the one conversation a member had before chats into their first chat, once', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const owner = createSlotlockStore(admin);
    // As 0.8 kept it: one row a member, expiring.
    await admin`
      INSERT INTO slotlock.assistant_conversations (tenant_ref, member_ref, messages, actions, expires_at)
      VALUES (${tenant}, 'github:80',
              ${admin.json([{ role: 'user', text: 'When   is the  Mercedes free tomorrow morning, and the van?' }, { role: 'assistant', text: 'At 9.', calls: [] }] as never)},
              '{}'::jsonb, now() + interval '1 hour'),
             (${tenant}, 'github:81', '[]'::jsonb, '{}'::jsonb, now() - interval '1 minute')`;
    // A release with this table runs the whole migration once.
    await admin`UPDATE slotlock.schema_version SET ddl_sha256 = NULL WHERE singleton`;
    await owner.applySchema();
    await owner.applyTenantRls();
    const [moved] = await adapter.listChats(tenant, 'github:80');
    expect(moved?.title).toBe('When is the Mercedes free tomorrow morning, and the van?');
    expect(moved?.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const chat = await adapter.getChat(tenant, 'github:80', moved?.id as string);
    expect(chat?.messages).toHaveLength(2);
    expect(chat?.expiresAt).toBeNull();
    // An expired one is not moved; neither row stays behind to be moved again.
    expect(await adapter.listChats(tenant, 'github:81')).toEqual([]);
    const [left] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.assistant_conversations
       WHERE tenant_ref = ${tenant} AND member_ref = 'github:80'`;
    expect(left?.count).toBe(0);
    // A 0.8 server still running writes the old table again: the next migration moves that as a
    // chat of its own, and leaves the one moved before as it was.
    await admin`
      INSERT INTO slotlock.assistant_conversations (tenant_ref, member_ref, messages, actions, expires_at, updated_at)
      VALUES (${tenant}, 'github:80', ${admin.json([{ role: 'user', text: 'And on Friday?' }] as never)},
              '{}'::jsonb, now() + interval '1 hour', now() + interval '1 second')`;
    await admin`UPDATE slotlock.schema_version SET ddl_sha256 = NULL WHERE singleton`;
    await owner.applySchema();
    const both = await adapter.listChats(tenant, 'github:80');
    expect(both.map((one) => one.title).sort()).toEqual(['And on Friday?', 'When is the Mercedes free tomorrow morning, and the van?']);
    expect((await adapter.getChat(tenant, 'github:80', moved?.id as string))?.messages).toHaveLength(2);
    for (const one of both) await adapter.deleteChat(tenant, 'github:80', one.id);
    await admin`UPDATE slotlock.schema_version SET ddl_sha256 = NULL WHERE singleton`;
    await owner.applySchema();
    expect(await adapter.listChats(tenant, 'github:80')).toEqual([]);
  });

  it('keeps every assistant table under forced row-level security', async () => {
    const rows = await admin<{ relname: string; enabled: boolean; forced: boolean }[]>`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'slotlock' AND c.relname IN ('assistant_settings', 'assistant_conversations', 'assistant_chats')
       ORDER BY c.relname`;
    expect(rows).toEqual([
      { relname: 'assistant_chats', enabled: true, forced: true },
      { relname: 'assistant_conversations', enabled: true, forced: true },
      { relname: 'assistant_settings', enabled: true, forced: true },
    ]);
    const contracts = await admin<{ table_name: string }[]>`
      SELECT table_name FROM slotlock.rls_policy_contracts
       WHERE table_name IN ('assistant_settings', 'assistant_conversations', 'assistant_chats') ORDER BY table_name`;
    expect(contracts.map(({ table_name }) => table_name)).toEqual([
      'assistant_chats',
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
    await adapter.putChat(tenant, 'github:1', CHAT, { title: 'Chat', messages: [{ role: 'user', text: 'secret plans' }], added: {}, keep: [] }, 60_000);

    const mine = await adapter.getSettings(tenant);
    expect(mine).toMatchObject({ provider: 'anthropic', model: 'your-model', keyHint: '1234', updatedBy: 'github:1' });
    await expect(openSlotlockAssistantKey(SECRET, tenant, mine?.sealedKey as string)).resolves.toBe('sk-integration-key-1234');
    expect(await adapter.getSettings(other)).toBeNull();
    expect(await adapter.getChat(other, 'github:1', CHAT)).toBeNull();

    // Inside the other tenant's transaction, naming this tenant reads and writes nothing.
    await expect(
      store.withTenant(other, (scoped) => scoped.getAssistantSettings({ tenantRef: tenant })),
    ).resolves.toBeNull();
    await expect(
      store.withTenant(other, (scoped) =>
        scoped.getAssistantChat({ tenantRef: tenant, memberRef: 'github:1', chatId: CHAT }),
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
           + (SELECT count(*) FROM slotlock.assistant_conversations)
           + (SELECT count(*) FROM slotlock.assistant_chats) AS count`;
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
    await adapter.putChat(tenant, 'github:2', CHAT, { title: 'Chat', messages: [], added: { a1: action }, keep: ['a1'] }, 60_000);
    // Stored again with the action pending: the stored state wins over the copy sent.
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => adapter.settleAction(tenant, 'github:2', CHAT, 'a1', 'pending', { status: 'approved' })),
    );
    expect(claims.filter((claim) => claim !== null)).toEqual([{ ...action, status: 'approved' }]);
    await adapter.putChat(tenant, 'github:2', CHAT, { title: 'Chat', messages: [{ role: 'note', text: 'n' }], added: { a1: action }, keep: ['a1'] }, 60_000);
    expect((await adapter.getChat(tenant, 'github:2', CHAT))?.actions.a1?.status).toBe('approved');
    expect(await adapter.settleAction(other, 'github:2', CHAT, 'a1', 'approved', { status: 'done' })).toBeNull();

    await adapter.putChat(tenant, 'github:3', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 1_000);
    expect(await adapter.getChat(tenant, 'github:3', CHAT)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await adapter.getChat(tenant, 'github:3', CHAT)).toBeNull();
  });

  it('L3: deletes expired conversations in the maintenance pass', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putChat(tenant, 'github:7', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 1_000);
    await adapter.putChat(tenant, 'github:8', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const count = async () =>
      Number(
        (
          await admin<{ count: string }[]>`
          SELECT count(*) FROM slotlock.assistant_chats
           WHERE tenant_ref = ${tenant} AND member_ref IN ('github:7', 'github:8')`
        )[0]?.count,
      );
    expect(await count()).toBe(2);
    const pass = await maintainSlotlockTenant(store, tenant);
    expect(pass.pruned).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(1);
    expect(await adapter.getChat(tenant, 'github:8', CHAT)).not.toBeNull();
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
          FROM slotlock.assistant_chats WHERE tenant_ref = ${orgTenant} AND member_ref = 'github:31'`;
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
      await adapter.putChat(chatOnly, 'github:41', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 1_000);
      await adapter.putChat(other, 'github:42', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 1_000);
      await adapter.putChat(other, 'github:43', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const rows = async () =>
        (
          await admin<{ tenant_ref: string; member_ref: string }[]>`
          SELECT tenant_ref, member_ref FROM slotlock.assistant_chats
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
    await adapter.putChat(other, 'github:51', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await adapter.getChat(other, 'github:52', CHAT);
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*) FROM slotlock.assistant_chats WHERE tenant_ref = ${other} AND member_ref = 'github:51'`;
    expect(Number(row?.count)).toBe(0);
  });

  it('puts no action back into a conversation that no longer has it, and keeps a settled one settled', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const pending = { operation: 'slotlock_delete_event', input: { event_id: 'agent:y' }, status: 'pending' };
    await adapter.putChat(other, 'github:61', CHAT, { title: 'Chat', messages: [], added: { x1: pending }, keep: [] }, 60_000);
    await adapter.settleAction(other, 'github:61', CHAT, 'x1', 'pending', { status: 'done', input: {} });
    // A stale turn carries x1 as it stood: the row's state stands.
    await adapter.putChat(other, 'github:61', CHAT, { title: 'Chat', messages: [], added: { x1: pending }, keep: ['x1'] }, 60_000);
    expect((await adapter.getChat(other, 'github:61', CHAT))?.actions.x1).toMatchObject({ status: 'done', input: {} });
    // Reset while the turn ran: the row is gone, and only new actions go in.
    await adapter.deleteChat(other, 'github:61', CHAT);
    await adapter.putChat(other, 'github:61', CHAT, { title: 'Chat', messages: [], added: { x2: pending }, keep: ['x1'] }, 60_000);
    expect(Object.keys((await adapter.getChat(other, 'github:61', CHAT))?.actions ?? {})).toEqual(['x2']);
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

  it('seals a key again under a new secret only while it is still the one stored, and only in its tenant', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter?.resealKey) throw new Error('the store adapter re-seals keys');
    const next = randomBytes(32).toString('hex');
    const settings = { provider: 'openai' as const, baseUrl: 'https://api.example.com/v1', model: 'm' };
    const old = await sealSlotlockAssistantKey(SECRET, tenant, 'sk-rotate-key-5678');
    await adapter.putSettings(tenant, { ...settings, key: { sealed: old, hint: '5678' } }, 'github:1');
    const resealed = await sealSlotlockAssistantKey(next, tenant, 'sk-rotate-key-5678');
    // Another tenant cannot touch it, even naming the stored seal.
    expect(await adapter.resealKey(other, old, resealed)).toBe(false);
    expect((await adapter.getSettings(tenant))?.sealedKey).toBe(old);
    expect(await adapter.resealKey(tenant, old, resealed)).toBe(true);
    const stored = await adapter.getSettings(tenant);
    expect(stored).toMatchObject({ sealedKey: resealed, keyHint: '5678', updatedBy: 'github:1' });
    await expect(openSlotlockAssistantKey(next, tenant, stored?.sealedKey as string)).resolves.toBe('sk-rotate-key-5678');
    // A stale re-seal (the key an owner saved since is not `from`) changes nothing.
    expect(await adapter.resealKey(tenant, old, await sealSlotlockAssistantKey(next, tenant, 'sk-stale'))).toBe(false);
    expect((await adapter.getSettings(tenant))?.sealedKey).toBe(resealed);
  });

  it("erases a tenant's settings and conversations, and no other tenant's", async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putSettings(other, { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', key: null });
    await adapter.putChat(other, 'github:9', CHAT, { title: 'Chat', messages: [], added: {}, keep: [] }, 60_000);
    const erased = await store.eraseTenant({ tenantRef: tenant });
    expect(erased.rows.assistant_settings).toBe(1);
    expect(erased.rows.assistant_chats).toBeGreaterThanOrEqual(2);
    expect(await adapter.getSettings(tenant)).toBeNull();
    expect(await adapter.getChat(tenant, 'github:1', CHAT)).toBeNull();
    expect(await adapter.getSettings(other)).not.toBeNull();
    expect(await adapter.getChat(other, 'github:9', CHAT)).not.toBeNull();
    const again = await store.eraseTenant({ tenantRef: tenant });
    expect(again.rows.assistant_settings).toBe(0);
    expect(again.rows.assistant_chats).toBe(0);
  });
});
