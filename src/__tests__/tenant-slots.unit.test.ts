// The per-tenant line `maxTenantTransactions` puts withTenant calls in: each tenant runs at most its
// share at once, in order, without holding up another tenant, and an aborted request leaves the line.
import { describe, expect, it } from 'vitest';
import { createSlotlockStore, createTenantSlots } from '../store.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createTenantSlots', () => {
  it('runs at most max per tenant, hands each freed slot to the next in line, and leaves other tenants alone', async () => {
    const acquire = createTenantSlots(2);
    const started: string[] = [];
    const take = (tenant: string, name: string) =>
      acquire(tenant).then((release) => {
        started.push(name);
        return release;
      });
    const a1 = take('a', 'a1');
    const a2 = take('a', 'a2');
    const a3 = take('a', 'a3');
    const a4 = take('a', 'a4');
    const b1 = take('b', 'b1');
    await tick();
    expect(started).toEqual(['a1', 'a2', 'b1']);
    (await a2)();
    await tick();
    expect(started).toEqual(['a1', 'a2', 'b1', 'a3']);
    // A second call of the same release frees nothing more.
    (await a2)();
    await tick();
    expect(started).toHaveLength(4);
    (await a1)();
    (await a3)();
    (await b1)();
    (await a4)();
    await tick();
    expect(started).toEqual(['a1', 'a2', 'b1', 'a3', 'a4']);
    // Every slot is back: a tenant starts at once again.
    const again = await acquire('a');
    const other = await acquire('a');
    again();
    other();
  });

  it('takes an aborted waiter out of the line with its reason, and refuses one aborted already', async () => {
    const acquire = createTenantSlots(1);
    const first = await acquire('a');
    const controller = new AbortController();
    const waiting = acquire('a', controller.signal);
    let nextStarted = false;
    const next = acquire('a').then((release) => {
      nextStarted = true;
      return release;
    });
    controller.abort(new Error('handler_timeout'));
    await expect(waiting).rejects.toThrow('handler_timeout');
    first();
    await tick();
    expect(nextStarted).toBe(true);
    (await next)();
    await expect(acquire('a', controller.signal)).rejects.toThrow('handler_timeout');
  });

  it('refuses store options out of range', () => {
    const sql = { begin: () => undefined } as unknown as Parameters<typeof createSlotlockStore>[0];
    for (const options of [
      { maxTenantTransactions: 0 },
      { maxTenantTransactions: 1.5 },
      { tenantLockTimeoutMs: 0 },
      { tenantLockTimeoutMs: 600_001 },
    ]) {
      expect(() => createSlotlockStore(sql, options)).toThrow(
        expect.objectContaining({ code: 'invalid_tenant_transaction_options' }),
      );
    }
    expect(() =>
      createSlotlockStore(sql, { maxTenantTransactions: 2, tenantLockTimeoutMs: 5_000 }),
    ).not.toThrow();
  });
});
