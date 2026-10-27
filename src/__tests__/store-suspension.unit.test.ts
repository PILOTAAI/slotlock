// A suspended tenant's withTenant store refuses every write and answers every read. Each store method
// is named here as a write, a read, upkeep or administration, so a method added later without a place
// in SLOTLOCK_TENANT_WRITE_METHODS fails this test instead of writing for a suspended tenant. A stand-
// in transaction answers the store's own queries; the real database runs in tenant-admin.integration.
import type { TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_TENANT_WRITE_METHODS,
  type SlotlockStore,
  type SlotlockTenantStore,
  createSlotlockStore,
} from '../store.js';

const READS = [
  'listChanges',
  'listWebhookEndpoints',
  'getResource',
  'listResources',
  'getHold',
  'listHolds',
  'getReservation',
  'listReservations',
  'listBusy',
  'getCalendarEvent',
  'getCalendarEventById',
  'listCalendarEvents',
  'getFreeBusy',
  'findNextAvailableFor',
  'isTenantSuspended',
];
const UPKEEP = [
  'rollCalendarEventHorizon',
  'pruneCalendarEventRetention',
  'pruneBookingRetention',
  // Delivering what already happened reads the feed; a suspension stops new changes, not these.
  'claimWebhookDeliveries',
  'settleWebhookDelivery',
  'pruneChanges',
];
const ADMINISTRATION = [
  'applySchema',
  'applyTenantRls',
  'grantApplicationRole',
  'withTenant',
  'suspendTenant',
  'unsuspendTenant',
  'eraseTenant',
];

/**
 * A client whose transactions answer withTenant's queries, with the tenant suspended or not. With
 * `check`, reading the suspension fails as PostgreSQL fails it (SQLSTATE 42501 for a role not
 * granted EXECUTE, 42883 for a schema without the function). `isolation` is the level the
 * transaction reports.
 */
function fakeClient(
  suspended: boolean,
  options: { check?: '42501' | '42883'; isolation?: string } = {},
) {
  const queries: string[] = [];
  const modes: string[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('tenant_suspended')) {
        if (options.check === '42501') {
          throw Object.assign(new Error('permission denied for function tenant_suspended'), {
            code: '42501',
          });
        }
        if (options.check === '42883') {
          throw Object.assign(
            new Error('function slotlock.tenant_suspended(text) does not exist'),
            {
              code: '42883',
            },
          );
        }
        return [{ suspended }];
      }
      if (text.includes('pg_advisory_xact_lock_shared')) {
        return [{ value: null, isolation: options.isolation ?? 'read committed' }];
      }
      if (text.includes('transaction_isolation')) {
        return [{ level: options.isolation ?? 'read committed' }];
      }
      if (text.includes('set_config')) return [{}];
      throw new Error(`unexpected query: ${text}`);
    },
    {
      savepoint: async (callback: (savepoint: TransactionSql) => Promise<unknown>) => callback(tx),
    },
  ) as unknown as TransactionSql;
  const client = {
    begin: async (
      mode: string | ((tx: TransactionSql) => Promise<unknown>),
      callback?: (tx: TransactionSql) => Promise<unknown>,
    ) => {
      if (typeof mode === 'function') return mode(tx);
      modes.push(mode);
      return callback?.(tx);
    },
  };
  return { client: client as never, tx, queries, modes };
}

describe('a suspended tenant', () => {
  it('names every store method as a write, a read, upkeep or administration', () => {
    const store = createSlotlockStore(fakeClient(false).client);
    expect(Object.keys(store).sort()).toEqual(
      [...SLOTLOCK_TENANT_WRITE_METHODS, ...READS, ...UPKEEP, ...ADMINISTRATION].sort(),
    );
  });

  it('is refused every write inside withTenant, before any query, and may still read', async () => {
    const { client, queries } = fakeClient(true);
    const store = createSlotlockStore(client);
    await store.withTenant('fleet', async (tenant: SlotlockTenantStore) => {
      const before = queries.length;
      for (const name of SLOTLOCK_TENANT_WRITE_METHODS) {
        const method = tenant[name] as (...args: unknown[]) => Promise<unknown>;
        await expect(method.call(tenant, {}), name).rejects.toMatchObject({
          code: 'tenant_suspended',
        });
      }
      expect(queries.length).toBe(before);
      // A read goes to the database as usual (and this stand-in refuses it).
      await expect(tenant.listResources({ tenantRef: 'fleet' })).rejects.toThrow(
        'unexpected query',
      );
    });
    // The lock that suspension waits on is taken, shared, before the suspension is read.
    const lock = queries.findIndex((text) => text.includes('pg_advisory_xact_lock_shared'));
    const read = queries.findIndex((text) => text.includes('tenant_suspended'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
  });

  it('leaves an active tenant its writes', async () => {
    const store = createSlotlockStore(fakeClient(false).client);
    await store.withTenant('fleet', async (tenant) => {
      // Validation runs: the write was not replaced.
      await expect(
        tenant.acquireHold({
          resourceId: 'x',
          start: new Date(Number.NaN),
          end: new Date(Number.NaN),
          ttlMs: 1,
        }),
      ).resolves.toEqual({ ok: false, code: 'invalid_window' });
    });
  });

  it('names the remedy when the serving role may not read suspensions', async () => {
    const store = createSlotlockStore(fakeClient(false, { check: '42501' }).client);
    const refused = store.withTenant('fleet', async () => 'ran');
    await expect(refused).rejects.toMatchObject({ code: 'application_role_not_granted' });
    await expect(refused).rejects.toThrow(/grantApplicationRole/);
  });

  it('says the schema is outdated when it has no suspension check', async () => {
    const store = createSlotlockStore(fakeClient(false, { check: '42883' }).client);
    const refused = store.withTenant('fleet', async () => 'ran');
    await expect(refused).rejects.toMatchObject({ code: 'schema_outdated' });
    await expect(refused).rejects.toThrow(/slotlock migrate/);
  });

  it('runs its own transaction READ COMMITTED, whatever the role defaults to', async () => {
    const { client, modes } = fakeClient(false);
    await createSlotlockStore(client).withTenant('fleet', async () => undefined);
    expect(modes).toEqual(['isolation level read committed']);
  });

  it('refuses writes, and answers reads, inside a caller transaction that is not READ COMMITTED', async () => {
    // A REPEATABLE READ snapshot can predate a suspension the tenant's lock waited for.
    const { tx, queries } = fakeClient(false, { isolation: 'repeatable read' });
    await createSlotlockStore(tx).withTenant('fleet', async (tenant) => {
      const before = queries.length;
      for (const name of SLOTLOCK_TENANT_WRITE_METHODS) {
        const method = tenant[name] as (...args: unknown[]) => Promise<unknown>;
        await expect(method.call(tenant, {}), name).rejects.toMatchObject({
          code: 'invalid_transaction_isolation',
        });
      }
      expect(queries.length).toBe(before);
      await expect(tenant.listResources({ tenantRef: 'fleet' })).rejects.toThrow(
        'unexpected query',
      );
    });
  });

  it('keeps the list to methods a store has', () => {
    const store: SlotlockStore = createSlotlockStore(fakeClient(false).client);
    for (const name of SLOTLOCK_TENANT_WRITE_METHODS) expect(typeof store[name]).toBe('function');
  });
});
