// Configuration changes on the feed, and where every change came from (RFC 0002 P1-5, P1-6), against
// real Postgres: a resource's rules, pool, hours and life, its coverage sources, webhook endpoints and
// API keys each append one row in the change's own transaction, with what changed before and after,
// who made it (actor, key id) and through which surface. No row carries a secret. Skipped without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAgentServer } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { createSlotlockApiKeyAuthenticator, createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboardResources } from '../dashboard.js';
import { slotlockCoverageSourceId } from '../event-feed.js';
import { maintainSlotlockTenant } from '../maintenance.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { modernRequest } from './helpers/modern-mcp.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;

interface Row {
  type: string;
  subject: string;
  resource_id: string | null;
  data: Record<string, unknown>;
  actor: string | null;
  origin: string | null;
  key_id: string | null;
}

describe.skipIf(!url)('configuration changes and provenance on the feed (real Postgres)', () => {
  let admin: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 8, 1);
  const at = (hour: number) => new Date(base + hour * HOUR);

  /** The tenant's feed rows after the ones already read, in feed order. */
  const reader = (tenantRef: string) => {
    let seen = 0;
    const all = () =>
      admin<Row[]>`
        SELECT type, subject, resource_id::text, data, actor, origin, key_id::text
          FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} ORDER BY txid, id`;
    return {
      all,
      async next() {
        const rows = await all();
        const fresh = rows.slice(seen);
        seen = rows.length;
        return fresh;
      },
    };
  };

  beforeAll(async () => {
    admin = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(admin);
    await store.applySchema();
  });

  afterAll(async () => {
    for (const ref of tenants) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    }
    await admin.end();
  });

  it('records each change to a resource, its coverage and its webhooks once, with before and after', async () => {
    const tenantRef = tenant('config');
    const keyId = randomUUID();
    const as = { actor: `api_key:${keyId}`, origin: 'application' as const, keyId };
    const by = { actor: as.actor, origin: 'application', key_id: keyId };
    const feed = reader(tenantRef);

    const resource = await store.withTenant(
      tenantRef,
      (t) => t.createResource({ tenantRef, externalRef: 'van-1', timezone: 'UTC' }),
      as,
    );
    const id = resource.id;
    expect(await feed.next()).toEqual([
      {
        type: 'resource.created',
        subject: id,
        resource_id: id,
        data: {
          id,
          reference: 'van-1',
          timezone: 'UTC',
          visibility: 'shared',
          pool: null,
          availability: null,
          booking_rules: null,
        },
        ...by,
      },
    ]);
    // Creating it again changes nothing, and appends nothing.
    await store.withTenant(tenantRef, (t) => t.createResource({ tenantRef, externalRef: 'van-1', timezone: 'UTC' }), as);
    expect(await feed.next()).toEqual([]);

    const updated = (before: Record<string, unknown>, after: Record<string, unknown>) => [
      {
        type: 'resource.updated',
        subject: id,
        resource_id: id,
        data: { id, reference: 'van-1', before, after },
        ...by,
      },
    ];
    // Booking rules, check-in among them.
    await store.withTenant(
      tenantRef,
      (t) => t.setResourceBookingRules({ tenantRef, id, rules: { minNoticeMinutes: 60, checkInMinutes: 15 } }),
      as,
    );
    expect(await feed.next()).toEqual(
      updated({ booking_rules: null }, { booking_rules: { minNoticeMinutes: 60, checkInMinutes: 15 } }),
    );
    await store.withTenant(tenantRef, (t) => t.setResourceBookingRules({ tenantRef, id, rules: { minNoticeMinutes: 60 } }), as);
    expect(await feed.next()).toEqual(
      updated(
        { booking_rules: { minNoticeMinutes: 60, checkInMinutes: 15 } },
        { booking_rules: { minNoticeMinutes: 60 } },
      ),
    );
    // Pool membership, and the same pool again: nothing.
    await store.withTenant(tenantRef, (t) => t.setResourcePool({ tenantRef, id, pool: 'vans' }), as);
    expect(await feed.next()).toEqual(updated({ pool: null }, { pool: 'vans' }));
    await store.withTenant(tenantRef, (t) => t.setResourcePool({ tenantRef, id, pool: 'vans' }), as);
    expect(await feed.next()).toEqual([]);
    // Bookable hours.
    const hours = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 }];
    await store.withTenant(tenantRef, (t) => t.setResourceAvailability({ tenantRef, id, rules: hours }), as);
    const [hoursRow] = await feed.next();
    expect(hoursRow).toMatchObject({ type: 'resource.updated', ...by, data: { before: { availability: null } } });
    expect(Object.keys((hoursRow?.data.after ?? {}) as object)).toEqual(['availability']);

    // Archived and restored; archiving an archived resource again changes nothing.
    await store.withTenant(tenantRef, (t) => t.archiveResource({ tenantRef, id }), as);
    await store.withTenant(tenantRef, (t) => t.archiveResource({ tenantRef, id }), as);
    await store.withTenant(tenantRef, (t) => t.restoreResource({ tenantRef, id }), as);
    expect((await feed.next()).map(({ type, origin, key_id }) => [type, origin, key_id])).toEqual([
      ['resource.archived', 'application', keyId],
      ['resource.restored', 'application', keyId],
    ]);

    // Coverage: a source recorded, read again (progress, not a change), deleted.
    const cover = (revision: number) =>
      store.withTenant(
        tenantRef,
        (t) =>
          t.recordCalendarCoverage({
            tenantRef,
            resourceId: id,
            source: 'google:fleet',
            window: { start: at(0), end: at(24) },
            revision,
          }),
        as,
      );
    expect(await cover(1)).toMatchObject({ ok: true });
    expect(await cover(2)).toMatchObject({ ok: true });
    await store.withTenant(tenantRef, (t) => t.deleteCoverage({ tenantRef, resourceId: id, source: 'google:fleet' }), as);
    expect(await feed.next()).toEqual([
      {
        type: 'coverage.recorded',
        subject: slotlockCoverageSourceId(tenantRef, 'google:fleet'),
        resource_id: id,
        data: {
          resource_id: id,
          source_id: slotlockCoverageSourceId(tenantRef, 'google:fleet'),
          start: expect.any(String),
          end: expect.any(String),
          revision: 1,
        },
        ...by,
      },
      {
        type: 'coverage.deleted',
        subject: slotlockCoverageSourceId(tenantRef, 'google:fleet'),
        resource_id: id,
        data: { resource_id: id, source_id: slotlockCoverageSourceId(tenantRef, 'google:fleet') },
        ...by,
      },
    ]);

    // A webhook endpoint added and deleted: its id and types, never its URL or secret.
    const hookUrl = `https://hooks.example.com/slotlock?token=${randomBytes(12).toString('hex')}`;
    const created = await store.withTenant(
      tenantRef,
      (t) => t.createWebhookEndpoint({ tenantRef, url: hookUrl, eventTypes: ['resource.updated', 'key.revoked'] }),
      as,
    );
    if (!created.ok) throw new Error(created.code);
    await store.withTenant(tenantRef, (t) => t.deleteWebhookEndpoint({ tenantRef, id: created.endpoint.id }), as);
    expect(await feed.next()).toEqual([
      {
        type: 'webhook.created',
        subject: created.endpoint.id,
        resource_id: null,
        data: { id: created.endpoint.id, event_types: ['resource.updated', 'key.revoked'] },
        ...by,
      },
      {
        type: 'webhook.deleted',
        subject: created.endpoint.id,
        resource_id: null,
        data: { id: created.endpoint.id, event_types: ['resource.updated', 'key.revoked'] },
        ...by,
      },
    ]);

    // A change that rolls back appends nothing.
    await expect(
      store.withTenant(
        tenantRef,
        async (t) => {
          await t.setResourcePool({ tenantRef, id, pool: 'trucks' });
          await t.setResourceBookingRules({ tenantRef, id, rules: null });
          throw new Error('rolled back');
        },
        as,
      ),
    ).rejects.toThrow('rolled back');
    expect(await feed.next()).toEqual([]);

    // Deleted: one row, not one more for each coverage source it took with it.
    expect(await cover(1)).toMatchObject({ ok: true });
    await feed.next();
    expect(await store.withTenant(tenantRef, (t) => t.deleteResource({ tenantRef, id }), as)).toEqual({
      ok: true,
      deleted: true,
    });
    expect(await feed.next()).toEqual([
      { type: 'resource.deleted', subject: id, resource_id: id, data: { id, reference: 'van-1' }, ...by },
    ]);

    // No URL, token or secret anywhere on the feed, and every row says where it came from.
    const everything = JSON.stringify(await feed.all());
    expect(everything).not.toContain('hooks.example.com');
    expect(everything).not.toContain(created.secret);
    expect(everything).not.toContain(created.secret.slice('whsec_'.length, 20));
  });

  it('records API keys created, rotated and revoked: ids and states, never the key, its digest or prefix', async () => {
    const tenantRef = tenant('keys');
    const keys = createSlotlockApiKeyStore(admin);
    const feed = reader(tenantRef);
    const created = await keys.create({
      tenantRef,
      name: 'Night desk',
      scopes: ['read', 'write'],
      createdBy: 'github:7',
      origin: 'dashboard',
    });
    const rotated = await keys.rotate({ tenantRef, id: created.apiKey.id, actor: 'github:8', origin: 'dashboard' });
    const revoked = await keys.revoke({ tenantRef, id: created.apiKey.id, actor: 'github:8', origin: 'dashboard' });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    // Revoking it again changes nothing.
    await keys.revoke({ tenantRef, id: created.apiKey.id, actor: 'github:8', origin: 'dashboard' });
    const id = created.apiKey.id;
    expect(await feed.next()).toEqual([
      {
        type: 'key.created',
        subject: id,
        resource_id: null,
        data: { id, scopes: ['read', 'write'], expires_at: null, revoked_at: null },
        actor: 'github:7',
        origin: 'dashboard',
        key_id: null,
      },
      {
        type: 'key.rotated',
        subject: id,
        resource_id: null,
        data: { id, scopes: ['read', 'write'], expires_at: null, revoked_at: null },
        actor: 'github:8',
        origin: 'dashboard',
        key_id: null,
      },
      {
        type: 'key.revoked',
        subject: id,
        resource_id: null,
        data: { id, scopes: ['read', 'write'], expires_at: null, revoked_at: expect.any(String) },
        actor: 'github:8',
        origin: 'dashboard',
        key_id: null,
      },
    ]);
    const everything = JSON.stringify(await feed.all());
    for (const secret of [created.key, rotated?.key as string, created.apiKey.prefix, rotated?.apiKey.prefix as string]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain('Night desk');
    const digests = await admin<{ hex: string }[]>`
      SELECT encode(secret_hash, 'hex') AS hex FROM slotlock.api_keys WHERE id = ${id}`;
    expect(everything).not.toContain(digests[0]?.hex as string);
    // A key made outside any surface is the library's.
    await keys.create({ tenantRef, name: 'Script', scopes: ['read'] });
    expect(await feed.next()).toMatchObject([{ type: 'key.created', actor: null, origin: 'library' }]);
  });

  it('records the surface and the API key of every change: mcp, a2a, rest, application, dashboard, maintenance', async () => {
    const tenantRef = tenant('surfaces');
    const keys = createSlotlockApiKeyStore(admin);
    const { key, apiKey } = await keys.create({ tenantRef, name: 'ops', scopes: ['read', 'write', 'admin'] });
    const server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      allowedOrigins: ['http://localhost'],
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: createSlotlockApiKeyAuthenticator(keys),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store),
        authorize: async () => true,
      },
    });
    const rest = async (method: string, path: string, body?: unknown) => {
      const response = await server.fetch(
        new Request(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(200);
      return (await response.json()) as Record<string, any>;
    };

    // The application API (REST, admin): a resource.
    const { resource } = await rest('POST', '/v1/resources', { external_ref: 'room-1', timezone: 'UTC' });
    // MCP: the event created.
    const mcp = await server.fetch(
      modernRequest(
        'tools/call',
        {
          name: 'slotlock_create_event',
          arguments: {
            resource_id: resource.id,
            starts_at: at(9).toISOString(),
            ends_at: at(10).toISOString(),
            timezone: 'UTC',
            title: 'Board',
            idempotency_key: `mcp-${randomUUID()}`,
          },
        },
        { headers: { Authorization: `Bearer ${key}` } },
      ),
    );
    const mcpBody = (await mcp.json()) as { result?: { structuredContent?: { event?: { id: string; revision: number } } } };
    const event = mcpBody.result?.structuredContent?.event;
    if (!event) throw new Error(`MCP create failed: ${JSON.stringify(mcpBody)}`);
    // The tenant's own id for it, which its history is read by (an agent sees another).
    const [stored] = await admin<{ id: string }[]>`
      SELECT id::text FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
    // A2A: the event moved.
    const a2a = await server.fetch(
      new Request(`${BASE}/a2a`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'A2A-Version': '1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'move',
          method: 'SendMessage',
          params: {
            message: {
              messageId: `move-${randomUUID()}`,
              role: 'ROLE_USER',
              parts: [
                {
                  data: {
                    skill: 'slotlock_update_event',
                    arguments: {
                      event_id: event.id,
                      expected_revision: event.revision,
                      starts_at: at(11).toISOString(),
                      ends_at: at(12).toISOString(),
                      idempotency_key: `a2a-${randomUUID()}`,
                    },
                  },
                  mediaType: 'application/json',
                },
              ],
            },
          },
        }),
      }),
    );
    const moved = ((await a2a.json()) as { result?: { message?: { parts?: { data?: { event?: { revision: number } } }[] } } })
      .result?.message?.parts?.[0]?.data?.event;
    if (!moved) throw new Error('A2A update failed');
    // REST (an agent route): the event cancelled.
    await rest(
      'DELETE',
      `/v1/events/${event.id}?expected_revision=${moved.revision}&idempotency_key=rest-${randomUUID()}`,
    );

    // RFC 0002 P1-6: update then cancel an event, read its history: the entries name the key, and
    // now also where each came from.
    const { history } = await rest('GET', `/v1/tenant/events/${stored?.id}/history`);
    expect(history.map(({ type, actor, origin, key_id }: Record<string, unknown>) => [type, actor, origin, key_id])).toEqual([
      ['event.cancelled', `api_key:${apiKey.id}`, 'rest', apiKey.id],
      ['event.updated', `api_key:${apiKey.id}`, 'a2a', apiKey.id],
      ['event.created', `api_key:${apiKey.id}`, 'mcp', apiKey.id],
    ]);
    const resourceHistory = await rest('GET', `/v1/resources/${resource.id}/history`);
    expect(resourceHistory.history.at(-1)).toMatchObject({
      type: 'resource.created',
      actor: `api_key:${apiKey.id}`,
      origin: 'application',
      key_id: apiKey.id,
    });

    // The dashboard: the pool, as the person signed in.
    const dashboardResources = createSlotlockDashboardResources(store);
    if (!dashboardResources.setPool) throw new Error('the dashboard adapter sets pools');
    await dashboardResources.setPool(tenantRef, resource.id, 'rooms', 'github:42');
    // Maintenance: a source gone stale.
    await store.withTenant(tenantRef, (t) =>
      t.recordCalendarCoverage({
        tenantRef,
        resourceId: resource.id,
        source: 'ical:rooms',
        window: { start: at(0), end: at(24) },
        revision: 1,
      }),
    );
    await admin`
      UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '3 days'
       WHERE tenant_ref = ${tenantRef}`;
    await maintainSlotlockTenant(store, tenantRef);
    const rows = await reader(tenantRef).all();
    expect(rows.filter(({ type }) => type === 'resource.updated')).toMatchObject([
      { actor: 'github:42', origin: 'dashboard', key_id: null, data: { after: { pool: 'rooms' } } },
    ]);
    expect(rows.filter(({ type }) => type === 'coverage.recorded')).toMatchObject([{ origin: 'library', key_id: null }]);
    expect(rows.filter(({ type }) => type === 'coverage.stale')).toMatchObject([{ origin: 'maintenance' }]);

    // The feed and its CloudEvents carry the same, as extension attributes.
    const { changes } = await rest('GET', '/v1/changes?limit=100');
    const created = changes.find(({ type }: { type: string }) => type === 'io.pylota.slotlock.event.created');
    expect(created).toMatchObject({ slotlockorigin: 'mcp', slotlockkeyid: apiKey.id });
    const stale = changes.find(({ type }: { type: string }) => type === 'io.pylota.slotlock.coverage.stale');
    expect(stale).toMatchObject({ slotlockorigin: 'maintenance' });
    expect(stale).not.toHaveProperty('slotlockkeyid');
    expect(JSON.stringify(changes)).not.toContain(key);
  });

  it('keeps each tenant to its own configuration changes under row-level security, and erases them with it', async () => {
    const role = `slotlock_cfg_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(18).toString('hex');
    await store.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    const serving = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 2,
      onnotice: () => {},
    });
    try {
      await store.grantApplicationRole(role);
      const app = createSlotlockStore(serving);
      const [one, two] = [tenant('rls-one'), tenant('rls-two')];
      for (const ref of [one, two]) {
        await app.withTenant(
          ref,
          async (t) => {
            const made = await t.createResource({ tenantRef: ref, externalRef: 'van', timezone: 'UTC' });
            await t.setResourcePool({ tenantRef: ref, id: made.id, pool: 'vans' });
            const hook = await t.createWebhookEndpoint({ tenantRef: ref, url: 'https://example.com/hook' });
            if (!hook.ok) throw new Error(hook.code);
          },
          { origin: 'rest' },
        );
      }
      const page = await app.withTenant(one, (t) => t.listChanges({ tenantRef: one }));
      if (!page.ok) throw new Error(page.code);
      expect(page.changes.map(({ type, origin }) => [type, origin])).toEqual([
        ['resource.created', 'rest'],
        ['resource.updated', 'rest'],
        ['webhook.created', 'rest'],
      ]);
      // Tenant one, reading tenant two's feed by name, sees none of it.
      await expect(
        app.withTenant(one, (t) => t.listRecentChanges({ tenantRef: two })),
      ).resolves.toEqual([]);
      const [counted] = await serving.begin(async (tx) => {
        await tx`SELECT set_config('slotlock.tenant_ref', ${one}, true)`;
        return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.outbox`;
      });
      expect(counted?.count).toBe(3);

      // Erasure takes them with the tenant, and appends none of its own.
      await admin`SELECT * FROM slotlock.erase_tenant(${one}::text)`;
      const [left] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.outbox WHERE tenant_ref = ${one}`;
      expect(left?.count).toBe(0);
      const [kept] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.outbox WHERE tenant_ref = ${two}`;
      expect(kept?.count).toBe(3);
    } finally {
      await serving.end({ timeout: 5 });
      await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });
});
