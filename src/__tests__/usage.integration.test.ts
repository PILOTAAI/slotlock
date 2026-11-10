// Usage metering (usage.ts) against real Postgres, as the LOGIN role grantApplicationRole grants:
// operation counts recorded once per batch, bookings and holds rolled up from the feed once each,
// read back by day, kept from the serving role, and erased with the tenant. Skipped without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import type { SlotlockApplicationBackend } from '../application-api.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import {
  type SlotlockUsageCount,
  readSlotlockTenantUsage,
  recordSlotlockUsage,
  slotlockUsageDay,
  totalSlotlockUsage,
} from '../usage.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('usage metering (real Postgres, application role)', () => {
  const role = `slotlock_usage_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `usage-${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const today = () => slotlockUsageDay(Date.now());
  const read = (tenantRef: string) => readSlotlockTenantUsage(application, tenantRef, today(), today());

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
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const keyed = async (tenantRef: string) =>
    (await createSlotlockApiKeyStore(application).create({ tenantRef, name: 'agent', scopes: ['read', 'write'] }))
      .apiKey.id;
  const operations = (tenantRef: string, keyId: string, count: number, origin = 'mcp'): SlotlockUsageCount => ({
    tenantRef,
    day: today(),
    metric: 'operations',
    keyId,
    origin,
    count,
  });

  it('records a batch of operation counts once, however often it is sent', async () => {
    const acme = tenant('acme');
    const key = await keyed(acme);
    const flush = randomUUID();
    const batch = [operations(acme, key, 3), operations(acme, key, 2), operations(acme, '', 1, 'rest')];
    expect(await recordSlotlockUsage(application, flush, batch)).toBe(true);
    // Its answer was lost, and the server sends it again: nothing is added twice.
    expect(await recordSlotlockUsage(application, flush, batch)).toBe(false);
    expect(await recordSlotlockUsage(application, randomUUID(), [operations(acme, key, 4)])).toBe(true);
    expect(await read(acme)).toEqual([
      { day: today(), metric: 'operations', keyId: '', origin: 'rest', count: 1 },
      { day: today(), metric: 'operations', keyId: key, origin: 'mcp', count: 9 },
    ]);
  });

  it('refuses rows that are not operations of today, and drops a tenant that no longer exists', async () => {
    const acme = tenant('strict');
    await keyed(acme);
    const refused = (rows: unknown) =>
      application`SELECT slotlock.record_usage(${randomUUID()}::uuid, ${JSON.stringify(rows)}::text::jsonb)`;
    const row = { tenant_ref: acme, day: today(), metric: 'operations', key_id: '', origin: 'rest', count: 1 };
    for (const bad of [
      [],
      [{ ...row, metric: 'bookings' }],
      [{ ...row, metric: 'resources' }],
      [{ ...row, day: '2020-01-01' }],
      [{ ...row, count: 0 }],
      [{ ...row, count: '1' }],
    ]) {
      await expect(refused(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    // What else a server counts: webhook deliveries and assistant messages.
    expect(
      await recordSlotlockUsage(application, randomUUID(), [
        { ...operations(acme, '', 3, 'webhooks'), metric: 'webhook_deliveries' },
        { ...operations(acme, '', 1, 'dashboard-assistant'), metric: 'assistant_messages' },
      ]),
    ).toBe(true);
    expect(totalSlotlockUsage(await read(acme))).toMatchObject({ webhook_deliveries: 3, assistant_messages: 1 });
    // No key, no feed: erased, or never was. Its counts are dropped, the batch still recorded.
    const gone = `usage-gone-${randomUUID()}`;
    expect(await recordSlotlockUsage(application, randomUUID(), [operations(gone, '', 5)])).toBe(true);
    expect(await read(gone)).toEqual([]);
  });

  it('rolls bookings and holds up from the feed once each, never maintenance’s own changes', async () => {
    const fleet = tenant('fleet');
    const key = await keyed(fleet);
    const start = (offsetHours: number) => new Date(Date.now() + 48 * HOUR + offsetHours * HOUR);
    await store.withTenant(
      fleet,
      async (scoped) => {
        const resource = await scoped.createResource({ tenantRef: fleet, externalRef: 'room-1', timezone: 'UTC' });
        const held = await scoped.acquireHold({
          tenantRef: fleet,
          resourceId: resource.id,
          start: start(0),
          end: start(1),
          ttlMs: 600_000,
        });
        if (!held.ok) throw new Error(held.code);
        expect((await scoped.confirmHold(held.hold.id, { tenantRef: fleet })).ok).toBe(true);
        const other = await scoped.acquireHold({
          tenantRef: fleet,
          resourceId: resource.id,
          start: start(2),
          end: start(3),
          ttlMs: 600_000,
        });
        if (!other.ok) throw new Error(other.code);
        const booked = await scoped.createExternalReservation({
          tenantRef: fleet,
          externalRef: 'booking-1',
          resourceId: resource.id,
          start: start(4),
          end: start(5),
          bufferAfterMs: 0,
          revision: 1,
        });
        expect(booked.ok).toBe(true);
      },
      { isolation: 'read committed', origin: 'mcp', keyId: key },
    );
    // A change maintenance makes for itself (here a hold it takes) is not the tenant's use.
    await store.withTenant(
      fleet,
      async (scoped) => {
        const [resource] = await scoped.listResources({ tenantRef: fleet });
        const held = await scoped.acquireHold({
          tenantRef: fleet,
          resourceId: resource?.id as string,
          start: start(6),
          end: start(7),
          ttlMs: 600_000,
        });
        expect(held.ok).toBe(true);
      },
      { isolation: 'read committed', origin: 'maintenance' },
    );

    const rolled = await store.withTenant(fleet, (scoped) => scoped.rollUpUsage({ tenantRef: fleet }));
    expect(rolled).toBeGreaterThanOrEqual(6);
    expect(await read(fleet)).toEqual([
      // A confirmed hold and an external booking.
      { day: today(), metric: 'bookings', keyId: key, origin: 'mcp', count: 2 },
      { day: today(), metric: 'holds', keyId: key, origin: 'mcp', count: 2 },
      // The day's resource count.
      { day: today(), metric: 'resources', keyId: '', origin: 'maintenance', count: 1 },
    ]);
    // Rolled up again, nothing is counted twice, and the resource count is replaced, not added to.
    await store.withTenant(fleet, (scoped) =>
      scoped.createResource({ tenantRef: fleet, externalRef: 'room-2', timezone: 'UTC' }),
    );
    expect(await store.withTenant(fleet, (scoped) => scoped.rollUpUsage({ tenantRef: fleet }))).toBe(1);
    expect(totalSlotlockUsage(await read(fleet))).toEqual({
      operations: 0,
      bookings: 2,
      holds: 2,
      webhook_deliveries: 0,
      assistant_messages: 0,
      resources: 2,
    });
  });

  it('reads at most a retention of days, and keeps the tables from the serving role', async () => {
    const acme = tenant('range');
    await keyed(acme);
    await recordSlotlockUsage(application, randomUUID(), [operations(acme, '', 1)]);
    expect(await readSlotlockTenantUsage(application, acme, '2025-01-01', today())).toEqual([]);
    expect(await readSlotlockTenantUsage(application, acme, today(), today())).toHaveLength(1);
    for (const table of ['usage_daily', 'usage_flushes', 'usage_cursors', 'usage_meter_start']) {
      await expect(application.unsafe(`SELECT * FROM slotlock.${table}`), table).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('counts nothing written before metering began', async () => {
    const before = tenant('before');
    await store.withTenant(
      before,
      async (scoped) => {
        const resource = await scoped.createResource({ tenantRef: before, externalRef: 'van-1', timezone: 'UTC' });
        const held = await scoped.acquireHold({
          tenantRef: before,
          resourceId: resource.id,
          start: new Date(Date.now() + 72 * HOUR),
          end: new Date(Date.now() + 73 * HOUR),
          ttlMs: 600_000,
        });
        expect(held.ok).toBe(true);
      },
      { isolation: 'read committed' },
    );
    const [kept] = await admin<{ txid: string }[]>`SELECT txid::text FROM slotlock.usage_meter_start`;
    try {
      // As if this release were migrated now: the hold above came before.
      await admin`UPDATE slotlock.usage_meter_start
                     SET txid = pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())`;
      await store.withTenant(before, (scoped) => scoped.rollUpUsage({ tenantRef: before }));
      // The hold is not counted; the resource it held is in today's count, which is the state now.
      expect(await read(before)).toEqual([
        { day: today(), metric: 'resources', keyId: '', origin: 'maintenance', count: 1 },
      ]);
    } finally {
      await admin`UPDATE slotlock.usage_meter_start SET txid = ${kept?.txid as string}::xid8`;
    }
  });

  it('answers GET /v1/usage with totals by day, key and surface, this month by default', async () => {
    const acme = tenant('api');
    const key = await keyed(acme);
    await recordSlotlockUsage(application, randomUUID(), [
      operations(acme, key, 4, 'mcp'),
      operations(acme, key, 1, 'application'),
      operations(acme, '', 2, 'dashboard-assistant'),
    ]);
    const backend: SlotlockApplicationBackend = createSlotlockStoreApplicationBackend(store);
    const context = {
      principal: { subject: `key:${key}`, tenantRef: acme, keyId: key },
      operation: 'slotlock_get_usage' as const,
      signal: new AbortController().signal,
    };
    const day = today();
    const none = { operations: 0, bookings: 0, holds: 0, webhook_deliveries: 0, assistant_messages: 0, resources: 0 };
    expect(await backend.getUsage(context, {})).toEqual({
      from: `${day.slice(0, 8)}01`,
      to: day,
      totals: { ...none, operations: 7 },
      days: [{ day, ...none, operations: 7 }],
      keys: [
        { key_id: key, ...none, operations: 5 },
        { key_id: null, ...none, operations: 2 },
      ],
      surfaces: [
        { origin: 'mcp', ...none, operations: 4 },
        { origin: 'dashboard-assistant', ...none, operations: 2 },
        { origin: 'application', ...none, operations: 1 },
      ],
    });
    // Another tenant's key sees only its own.
    const other = { ...context, principal: { subject: 'key:other', tenantRef: tenant('other-api') } };
    expect((await backend.getUsage(other, { from: day, to: day })).totals).toEqual(none);
    for (const range of [
      { from: day, to: '2000-01-01' },
      { from: '2020-01-01', to: day },
      { from: day, to: '2999-12-31' },
    ]) {
      await expect(backend.getUsage(context, range), JSON.stringify(range)).rejects.toMatchObject({
        code: 'invalid_usage_range',
        status: 400,
      });
    }
  });

  it("erases a tenant's usage and its cursor with the tenant, and no other tenant's", async () => {
    const erased = tenant('erased');
    const kept = tenant('kept');
    for (const ref of [erased, kept]) {
      await keyed(ref);
      await recordSlotlockUsage(application, randomUUID(), [operations(ref, '', 2)]);
      await store.withTenant(ref, (scoped) => scoped.createResource({ tenantRef: ref, externalRef: 'r', timezone: 'UTC' }));
      await store.withTenant(ref, (scoped) => scoped.rollUpUsage({ tenantRef: ref }));
    }
    const result = await store.eraseTenant({ tenantRef: erased });
    // Its operations and its resource count.
    expect(result.rows).toMatchObject({ usage_daily: 2, usage_cursors: 1 });
    expect(await read(erased)).toEqual([]);
    expect(await read(kept)).toHaveLength(2);
    const [cursor] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.usage_cursors WHERE tenant_ref = ${erased}`;
    expect(cursor?.count).toBe(0);
  });
});
