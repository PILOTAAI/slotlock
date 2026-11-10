// Keys limited to part of their tenant (RFC 0003 G6), against real Postgres as the LOGIN role
// grantApplicationRole grants: a key limited to locations and groups reaches only those resources,
// by the database's own policies, through the agent operations and the store alike; one outside
// is not found. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyAuthenticator, createSlotlockApiKeyStore } from '../api-keys.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('keys limited to locations and groups (real Postgres, application role)', () => {
  const role = `slotlock_scope_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const acme = `scoped-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    // Applied twice: the scope policies are rebuilt with the tenant ones, never doubled.
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
    await store.withTenant(acme, async (scoped) => {
      await scoped.putLocation({ tenantRef: acme, ref: 'north', name: 'North' });
      await scoped.putLocation({ tenantRef: acme, ref: 'leeds', name: 'Leeds', parentRef: 'north' });
      await scoped.putLocation({ tenantRef: acme, ref: 'south', name: 'South' });
      await scoped.putGroup({ tenantRef: acme, ref: 'team', name: 'Team' });
      for (const [ref, location] of [
        ['in-leeds', 'leeds'],
        ['in-south', 'south'],
        ['team-south', 'south'],
        ['nowhere', undefined],
      ] as const) {
        const made = await scoped.createResource({
          tenantRef: acme,
          externalRef: ref,
          timezone: 'UTC',
          ...(location ? { location } : {}),
        });
        ids[ref] = made.id;
      }
      await scoped.addGroupMember({ tenantRef: acme, group: 'team', resourceId: ids['team-south'] as string });
    });
  });

  afterAll(async () => {
    await admin`SELECT * FROM slotlock.erase_tenant(${acme}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps a scope with its key, read and write only, and authenticates with it', async () => {
    const keys = createSlotlockApiKeyStore(application);
    await expect(
      keys.create({ tenantRef: acme, name: 'too much', scopes: ['read', 'write', 'admin'], resourceScope: { locations: ['north'], groups: [] } }),
    ).rejects.toMatchObject({ code: 'invalid_api_key_scopes' });
    for (const resourceScope of [{ locations: [], groups: [] }, { locations: ['Not A Ref'], groups: [] }]) {
      await expect(
        keys.create({ tenantRef: acme, name: 'bad', scopes: ['read'], resourceScope }),
        JSON.stringify(resourceScope),
      ).rejects.toMatchObject({ code: 'invalid_api_key_resource_scope' });
    }
    const { key, apiKey } = await keys.create({
      tenantRef: acme,
      name: 'North and the team',
      scopes: ['read', 'write'],
      resourceScope: { locations: ['north'], groups: ['team'] },
    });
    expect(apiKey.resourceScope).toEqual({ locations: ['north'], groups: ['team'] });
    const plain = await keys.create({ tenantRef: acme, name: 'everything', scopes: ['read'] });
    const listed = await keys.list({ tenantRef: acme });
    expect(listed.find((found) => found.id === apiKey.id)?.resourceScope).toEqual({ locations: ['north'], groups: ['team'] });
    expect(listed.find((found) => found.id === plain.apiKey.id)).not.toHaveProperty('resourceScope');
    const authenticate = createSlotlockApiKeyAuthenticator(keys);
    const principal = await authenticate(new Request('https://example.com', { headers: { authorization: `Bearer ${key}` } }));
    expect(principal).toMatchObject({ tenantRef: acme, resourceScope: { locations: ['north'], groups: ['team'] } });
    // Kept through rotation: the same key, a new secret.
    const rotated = await keys.rotate({ tenantRef: acme, id: apiKey.id });
    expect(
      await authenticate(new Request('https://example.com', { headers: { authorization: `Bearer ${rotated?.key}` } })),
    ).toMatchObject({ resourceScope: { locations: ['north'], groups: ['team'] } });
  });

  it('reaches only the resources at its locations or in its groups, through every operation', async () => {
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const principal = {
      subject: 'api_key:scoped',
      tenantRef: acme,
      scopes: ['read', 'write'],
      resourceScope: { locations: ['north'], groups: ['team'] },
    };
    const call = (operation: string, input: Record<string, unknown>) =>
      invokeSlotlockAgentOperation({
        operation,
        input,
        request: new Request('https://example.com'),
        options: { backend, authenticate: async () => principal, authorize: () => true },
      } as never) as Promise<{ ok: boolean; data?: Record<string, unknown>; code?: string; status?: number }>;
    const listed = await call('slotlock_list_resources', { limit: 50 });
    expect(((listed.data?.resources ?? []) as { external_ref: string }[]).map((found) => found.external_ref).sort()).toEqual([
      'in-leeds',
      'team-south',
    ]);
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const window = { start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() };
    // Outside: not found, never forbidden, whether read or written.
    expect(await call('slotlock_get_free_busy', { resource_ids: [ids['in-south']], ...window })).toMatchObject({
      ok: false,
      code: 'resource_not_found',
    });
    expect(
      await call('slotlock_hold_slots', {
        slots: [{ resource_id: ids['nowhere'], ...window }],
        idempotency_key: 'outside',
        ttl_seconds: 300,
      }),
    ).toMatchObject({ data: { refused: [{ index: 0, code: 'resource_not_found' }] } });
    // Inside: as any key.
    expect(await call('slotlock_get_free_busy', { resource_ids: [ids['in-leeds']], ...window })).toMatchObject({ ok: true });
    const held = await call('slotlock_hold_slots', {
      slots: [{ resource_id: ids['team-south'], ...window }],
      idempotency_key: 'inside',
      ttl_seconds: 300,
    });
    expect(held).toMatchObject({ ok: true, data: { refused: [] } });
    // A selection covers the key's resources only.
    expect(await call('slotlock_get_free_busy', { location: 'south', ...window })).toMatchObject({
      ok: true,
      data: { selected_resource_ids: [ids['team-south']] },
    });
  });

  it("holds the store itself to the scope: other resources' rows are not there to read or write", async () => {
    const scope = { locations: ['north'], groups: [] };
    const seen = await store.withTenant(acme, (scoped) => scoped.listResources({ tenantRef: acme, limit: 50 }), { resourceScope: scope });
    expect(seen.map((resource) => resource.externalRef)).toEqual(['in-leeds']);
    expect(
      await store.withTenant(acme, (scoped) => scoped.getResource({ tenantRef: acme, id: ids['in-south'] as string }), { resourceScope: scope }),
    ).toBeNull();
    // The feed: only changes about its resources.
    const changes = await store.withTenant(
      acme,
      (scoped) => scoped.listChanges({ tenantRef: acme, limit: 500 }),
      { resourceScope: scope },
    );
    if (!changes.ok) throw new Error(changes.code);
    expect(new Set(changes.changes.map((change) => change.resourceId))).toEqual(new Set([ids['in-leeds']]));
    // Unlimited, the same transaction shape sees the whole tenant.
    expect(await store.withTenant(acme, (scoped) => scoped.listResources({ tenantRef: acme, limit: 50 }))).toHaveLength(4);
    // A scope that reaches nothing reaches nothing.
    expect(
      await store.withTenant(acme, (scoped) => scoped.listResources({ tenantRef: acme, limit: 50 }), {
        resourceScope: { locations: ['nowhere-at-all'], groups: [] },
      }),
    ).toEqual([]);
    // Every table a limited key is held to has the restrictive policy, and nothing more.
    const policies = await admin<{ tablename: string; permissive: string }[]>`
      SELECT tablename, permissive FROM pg_policies
       WHERE schemaname = 'slotlock' AND policyname = 'resource_scope_v1' ORDER BY tablename`;
    expect(policies.every((policy) => policy.permissive === 'RESTRICTIVE')).toBe(true);
    expect(policies.map((policy) => policy.tablename)).toContain('reservations');
  });
});
