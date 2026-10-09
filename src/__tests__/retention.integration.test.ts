// The public retention API against real Postgres: the agent quota it returns, what it never deletes,
// and that forced tenant RLS confines it to the tenant in context under a non-bypass role.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS,
  type SlotlockSql,
  type SlotlockStore,
  createSlotlockStore,
} from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR_MS = 3_600_000;
const NOTHING_PRUNED = { commandsDeleted: 0, tombstonesDeleted: 0, hasMore: false };

describe('Slotlock event retention arguments', () => {
  it('rejects an invalid tenant, batch or window before touching the database', async () => {
    const store = createSlotlockStore((() => {
      throw new Error('no query expected');
    }) as unknown as SlotlockSql);
    for (const [params, code] of [
      [{ tenantRef: '' }, 'invalid_identity'],
      [{ tenantRef: 'x'.repeat(501) }, 'invalid_identity'],
      [{ tenantRef: 'tenant', limit: 0 }, 'invalid_limit'],
      [{ tenantRef: 'tenant', limit: 1_001 }, 'invalid_limit'],
      [{ tenantRef: 'tenant', limit: 1.5 }, 'invalid_limit'],
      [{ tenantRef: 'tenant', retentionDays: 0 }, 'invalid_retention_window'],
      [{ tenantRef: 'tenant', retentionDays: 3_651 }, 'invalid_retention_window'],
      [{ tenantRef: 'tenant', retentionDays: 0.5 }, 'invalid_retention_window'],
    ] as const) {
      await expect(store.pruneCalendarEventRetention(params)).rejects.toMatchObject({ code });
    }
  });
});

describe.skipIf(!url)('Slotlock event retention (real Postgres)', () => {
  const probeRole = 'slotlock_retention_rls_probe';
  const tenants: string[] = [];
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let slot = 0;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    for (const tenantRef of tenants) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    }
    await sql.unsafe(`DROP OWNED BY ${probeRole}`).catch(() => undefined);
    await sql.unsafe(`DROP ROLE IF EXISTS ${probeRole}`);
    await sql.end();
  });

  async function tenantWithResource(label: string) {
    const tenantRef = `retention-${label}-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      externalRef: `vehicle-${crypto.randomUUID()}`,
      tenantRef,
      timezone: 'Europe/London',
    });
    return { tenantRef, resourceId: resource.id };
  }

  function put(
    target: SlotlockStore,
    params: {
      tenantRef: string;
      resourceId: string;
      externalRef: string;
      ownerRef?: string;
      idempotencyKey?: string;
    },
  ) {
    // Every event gets its own hour, so the overlap arbiter never decides a retention test.
    const start = new Date(Date.UTC(2027, 5, 1) + slot++ * 2 * HOUR_MS);
    return target.putCalendarEvent({
      tenantRef: params.tenantRef,
      ...(params.ownerRef ? { ownerRef: params.ownerRef } : {}),
      externalRef: params.externalRef,
      idempotencyKey: params.idempotencyKey ?? `put-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: params.resourceId,
      start,
      end: new Date(start.getTime() + HOUR_MS),
      timezone: 'Europe/London',
      summary: 'Vehicle handover',
    });
  }

  function cancel(
    target: SlotlockStore,
    params: { tenantRef: string; externalRef: string; ownerRef?: string; idempotencyKey?: string },
  ) {
    return target.cancelCalendarEvent({
      tenantRef: params.tenantRef,
      ...(params.ownerRef ? { ownerRef: params.ownerRef } : {}),
      externalRef: params.externalRef,
      idempotencyKey: params.idempotencyKey ?? `cancel-${crypto.randomUUID()}`,
      expectedRevision: 1,
    });
  }

  /** Backdate a tenant's commands (all, or one idempotency key) by `days`. */
  async function ageCommands(tenantRef: string, days: number, idempotencyKey?: string) {
    await sql`
      UPDATE slotlock.calendar_event_commands
         SET created_at = now() - ${days}::int * interval '1 day'
       WHERE tenant_ref = ${tenantRef}
         AND (${idempotencyKey ?? null}::text IS NULL OR idempotency_key = ${idempotencyKey ?? null})`;
  }

  async function ageTombstones(tenantRef: string, days: number) {
    await sql`
      UPDATE slotlock.calendar_event_tombstones
         SET cancelled_at = now() - ${days}::int * interval '1 day'
       WHERE tenant_ref = ${tenantRef}`;
  }

  /** Row counts as the owner connection sees them (it bypasses RLS). */
  async function rows(tenantRef: string) {
    const [counts] = await sql<{ commands: number; tombstones: number; events: number }[]>`
      SELECT
        (SELECT count(*)::int FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef})
          AS commands,
        (SELECT count(*)::int FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef})
          AS tombstones,
        (SELECT count(*)::int FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef})
          AS events`;
    return counts;
  }

  it('returns agent quota once commands and tombstones pass the replay window', async () => {
    const { tenantRef, resourceId } = await tenantWithResource('quota');
    const quotaStore = createSlotlockStore(sql, {
      agentOwnerEventQuota: 2,
      agentOwnerCommandQuota: 5,
    });
    const ownerRef = `agent:${'1'.repeat(64)}`;
    const agent = { tenantRef, resourceId, ownerRef };

    expect(await put(quotaStore, { ...agent, externalRef: 'held-1' })).toMatchObject({ ok: true });
    expect(await put(quotaStore, { ...agent, externalRef: 'held-2' })).toMatchObject({ ok: true });
    expect(await cancel(quotaStore, { ...agent, externalRef: 'held-1' })).toMatchObject({
      ok: true,
    });
    // Three commands use the whole put allowance: 5, less one reserved cancel per identity (2).
    expect(await put(quotaStore, { ...agent, externalRef: 'held-3' })).toEqual({
      ok: false,
      code: 'owner_command_quota_exceeded',
      limit: 5,
    });
    // Inside the replay window nothing is released.
    expect(await quotaStore.pruneCalendarEventRetention({ tenantRef })).toEqual(NOTHING_PRUNED);

    await ageCommands(tenantRef, SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS + 1);
    await ageTombstones(tenantRef, SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS + 1);
    expect(await quotaStore.pruneCalendarEventRetention({ tenantRef })).toEqual({
      commandsDeleted: 3,
      tombstonesDeleted: 1,
      hasMore: false,
    });
    expect(await rows(tenantRef)).toEqual({ commands: 0, tombstones: 0, events: 1 });
    expect(await put(quotaStore, { ...agent, externalRef: 'held-3' })).toMatchObject({
      ok: true,
      revision: 1,
    });
  });

  it('keeps young commands, internal tombstones and tombstones a command still names', async () => {
    const { tenantRef, resourceId } = await tenantWithResource('boundaries');
    const ownerRef = `agent:${'2'.repeat(64)}`;
    const recentCancelKey = `cancel-${crypto.randomUUID()}`;
    const youngPutKey = `put-${crypto.randomUUID()}`;

    await put(store, { tenantRef, resourceId, ownerRef, externalRef: 'agent-cancelled' });
    await cancel(store, {
      tenantRef,
      ownerRef,
      externalRef: 'agent-cancelled',
      idempotencyKey: recentCancelKey,
    });
    await put(store, { tenantRef, resourceId, externalRef: 'internal-cancelled' });
    await cancel(store, { tenantRef, externalRef: 'internal-cancelled' });
    await put(store, {
      tenantRef,
      resourceId,
      ownerRef,
      externalRef: 'agent-active',
      idempotencyKey: youngPutKey,
    });

    await ageCommands(tenantRef, 40);
    await ageTombstones(tenantRef, 40);
    await ageCommands(tenantRef, 0, recentCancelKey);
    await ageCommands(tenantRef, 0, youngPutKey);

    // The old agent put and both internal commands go. The agent tombstone stays while its
    // cancellation command is inside the window; the internal tombstone stays for good.
    expect(await store.pruneCalendarEventRetention({ tenantRef })).toEqual({
      commandsDeleted: 3,
      tombstonesDeleted: 0,
      hasMore: false,
    });
    expect(await rows(tenantRef)).toEqual({ commands: 2, tombstones: 2, events: 1 });

    await ageCommands(tenantRef, 40, recentCancelKey);
    expect(await store.pruneCalendarEventRetention({ tenantRef })).toEqual({
      commandsDeleted: 1,
      tombstonesDeleted: 1,
      hasMore: false,
    });
    const [internal] = await sql<{ owner_ref: string }[]>`
      SELECT owner_ref FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef}`;
    expect(internal).toEqual({ owner_ref: 'internal' });
    expect(await rows(tenantRef)).toEqual({ commands: 1, tombstones: 1, events: 1 });
  });

  it('honours a shorter replay window and bounded batches', async () => {
    const { tenantRef, resourceId } = await tenantWithResource('batches');
    for (const externalRef of ['batch-1', 'batch-2', 'batch-3']) {
      expect(await put(store, { tenantRef, resourceId, externalRef })).toMatchObject({ ok: true });
    }
    await ageCommands(tenantRef, 8);

    expect(await store.pruneCalendarEventRetention({ tenantRef })).toEqual(NOTHING_PRUNED);
    expect(
      await store.pruneCalendarEventRetention({ tenantRef, retentionDays: 7, limit: 2 }),
    ).toEqual({ commandsDeleted: 2, tombstonesDeleted: 0, hasMore: true });
    expect(
      await store.pruneCalendarEventRetention({ tenantRef, retentionDays: 7, limit: 2 }),
    ).toEqual({ commandsDeleted: 1, tombstonesDeleted: 0, hasMore: false });
    expect(await rows(tenantRef)).toEqual({ commands: 0, tombstones: 0, events: 3 });
  });

  it('prunes only the tenant in context when forced RLS binds a non-bypass role', async () => {
    const own = await tenantWithResource('rls-own');
    const canary = await tenantWithResource('rls-canary');
    const ownerRef = `agent:${'3'.repeat(64)}`;
    for (const tenant of [own, canary]) {
      await put(store, { ...tenant, ownerRef, externalRef: 'cancelled' });
      await cancel(store, { tenantRef: tenant.tenantRef, ownerRef, externalRef: 'cancelled' });
      await ageCommands(tenant.tenantRef, 40);
      await ageTombstones(tenant.tenantRef, 40);
    }

    await store.applyTenantRls();
    await sql.unsafe(`DROP OWNED BY ${probeRole}`).catch(() => undefined);
    await sql.unsafe(`DROP ROLE IF EXISTS ${probeRole}`);
    await sql.unsafe(
      `CREATE ROLE ${probeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await sql.unsafe(`GRANT USAGE ON SCHEMA slotlock TO ${probeRole}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA slotlock TO ${probeRole}`,
    );
    const asProbe = async <T>(callback: (probeStore: SlotlockStore) => Promise<T>): Promise<T> =>
      (await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${probeRole}`);
        const [role] = await tx<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
          SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
        return callback(createSlotlockStore(tx));
      })) as T;

    // Without a tenant context forced RLS shows the role nothing, so nothing is deleted.
    expect(
      await asProbe((probe) => probe.pruneCalendarEventRetention({ tenantRef: own.tenantRef })),
    ).toEqual(NOTHING_PRUNED);
    // Naming another tenant under this tenant's context reaches none of its rows.
    expect(
      await asProbe((probe) =>
        probe.withTenant(own.tenantRef, (tenant) =>
          tenant.pruneCalendarEventRetention({ tenantRef: canary.tenantRef }),
        ),
      ),
    ).toEqual(NOTHING_PRUNED);
    expect(await rows(canary.tenantRef)).toEqual({ commands: 2, tombstones: 1, events: 0 });

    expect(
      await asProbe((probe) =>
        probe.withTenant(own.tenantRef, (tenant) =>
          tenant.pruneCalendarEventRetention({ tenantRef: own.tenantRef }),
        ),
      ),
    ).toEqual({ commandsDeleted: 2, tombstonesDeleted: 1, hasMore: false });
    expect(await rows(own.tenantRef)).toEqual({ commands: 0, tombstones: 0, events: 0 });
    expect(await rows(canary.tenantRef)).toEqual({ commands: 2, tombstones: 1, events: 0 });
  });
});
