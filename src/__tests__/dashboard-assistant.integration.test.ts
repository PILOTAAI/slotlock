// The assistant's records against real Postgres, as a LOGIN role without BYPASSRLS that
// grantApplicationRole granted: both tables are under forced row-level security, a tenant reads and
// writes only its own settings and conversations, an approval is claimed once however many race,
// a conversation lapses, and erase_tenant deletes both. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSlotlockAssistantKey, sealSlotlockAssistantKey } from '../assistant.js';
import { createSlotlockDashboardResources } from '../dashboard.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

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
    await adapter.putConversation(tenant, 'github:1', { messages: [{ role: 'user', text: 'secret plans' }], actions: {} }, 60_000);

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

    // Saved without a new key, the key stays.
    await adapter.putSettings(tenant, { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'other', key: 'keep' });
    expect(await adapter.getSettings(tenant)).toMatchObject({ provider: 'openai', keyHint: '1234', sealedKey: sealed });
  });

  it('lets one of many racing approvals claim an action, and lapses a conversation', async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    const action = { operation: 'slotlock_delete_event', input: { event_id: 'agent:x' }, status: 'pending' };
    await adapter.putConversation(tenant, 'github:2', { messages: [], actions: { a1: action } }, 60_000);
    // Stored again with the action pending: the stored state wins over the copy sent.
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => adapter.settleAction(tenant, 'github:2', 'a1', 'pending', { status: 'approved' })),
    );
    expect(claims.filter((claim) => claim !== null)).toEqual([{ ...action, status: 'approved' }]);
    await adapter.putConversation(tenant, 'github:2', { messages: [{ role: 'note', text: 'n' }], actions: { a1: action } }, 60_000);
    expect((await adapter.getConversation(tenant, 'github:2'))?.actions.a1?.status).toBe('approved');
    expect(await adapter.settleAction(other, 'github:2', 'a1', 'approved', { status: 'done' })).toBeNull();

    await adapter.putConversation(tenant, 'github:3', { messages: [], actions: {} }, 1_000);
    expect(await adapter.getConversation(tenant, 'github:3')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await adapter.getConversation(tenant, 'github:3')).toBeNull();
  });

  it("erases a tenant's settings and conversations, and no other tenant's", async () => {
    const adapter = createSlotlockDashboardResources(store).assistant;
    if (!adapter) throw new Error('the store adapter keeps assistant records');
    await adapter.putSettings(other, { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', key: null });
    await adapter.putConversation(other, 'github:9', { messages: [], actions: {} }, 60_000);
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
