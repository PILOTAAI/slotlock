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
const UPKEEP = ['rollCalendarEventHorizon', 'pruneCalendarEventRetention', 'pruneBookingRetention'];
const ADMINISTRATION = [
  'applySchema',
  'applyTenantRls',
  'grantApplicationRole',
  'withTenant',
  'suspendTenant',
  'unsuspendTenant',
  'eraseTenant',
];

/** A client whose transactions answer withTenant's queries, with the tenant suspended or not. */
function fakeClient(suspended: boolean) {
  const queries: string[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('tenant_suspended')) return [{ suspended }];
      if (text.includes('current_setting')) return [{ value: null }];
      if (text.includes('set_config')) return [{}];
      throw new Error(`unexpected query: ${text}`);
    },
    { savepoint: async () => undefined },
  ) as unknown as TransactionSql;
  const client = {
    begin: async (callback: (tx: TransactionSql) => Promise<unknown>) => callback(tx),
  };
  return { client: client as never, queries };
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

  it('keeps the list to methods a store has', () => {
    const store: SlotlockStore = createSlotlockStore(fakeClient(false).client);
    for (const name of SLOTLOCK_TENANT_WRITE_METHODS) expect(typeof store[name]).toBe('function');
  });
});
