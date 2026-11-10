// The usage meter without a database: counting, batching, and a batch the database refused sent
// again under its own id.
import { describe, expect, it } from 'vitest';
import type { SlotlockAgentPrincipal } from '../agent-server.js';
import { type SlotlockUsageCount, createSlotlockUsageMeter, slotlockUsageDay, totalSlotlockUsage } from '../usage.js';

const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';
const principal = (tenantRef: string, keyId?: string): SlotlockAgentPrincipal => ({
  subject: `key:${keyId ?? 'token'}`,
  tenantRef,
  ...(keyId ? { keyId } : {}),
});

function recorder(fail = 0) {
  const calls: Array<{ flushId: string; rows: SlotlockUsageCount[] }> = [];
  let failures = fail;
  return {
    calls,
    record: async (flushId: string, rows: readonly SlotlockUsageCount[]) => {
      calls.push({ flushId, rows: rows.map((row) => ({ ...row })) });
      if (failures > 0) {
        failures -= 1;
        throw new Error('database down');
      }
      return true;
    },
  };
}

describe('the usage meter', () => {
  it('counts operations by tenant, UTC day, key and surface, and records them in one batch', async () => {
    let at = Date.UTC(2026, 10, 10, 23, 59, 59);
    const { calls, record } = recorder();
    const meter = createSlotlockUsageMeter({ record, intervalMs: 0, now: () => at });
    meter.count({ principal: principal('acme', KEY), operation: 'slotlock_list_resources', origin: 'mcp' });
    meter.count({ principal: principal('acme', KEY), operation: 'slotlock_get_free_busy', origin: 'mcp' });
    meter.count({ principal: principal('acme'), operation: 'slotlock_list_resources', origin: 'rest' });
    at += 1_000; // the next UTC day
    meter.count({ principal: principal('acme', KEY), operation: 'slotlock_list_resources', origin: 'mcp' });
    meter.count({ principal: principal('globex', 'not-a-uuid'), operation: 'slotlock_list_events', origin: 'a2a' });
    expect(meter.pending()).toBe(4);
    await meter.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rows).toEqual([
      { tenantRef: 'acme', day: '2026-11-10', keyId: KEY, origin: 'mcp', count: 2 },
      { tenantRef: 'acme', day: '2026-11-10', keyId: '', origin: 'rest', count: 1 },
      { tenantRef: 'acme', day: '2026-11-11', keyId: KEY, origin: 'mcp', count: 1 },
      // A key id that is not a UUID is recorded as no key.
      { tenantRef: 'globex', day: '2026-11-11', keyId: '', origin: 'a2a', count: 1 },
    ]);
    expect(meter.pending()).toBe(0);
    await meter.flush();
    expect(calls).toHaveLength(1);
  });

  it('sends a refused batch again under the same id, before anything counted since', async () => {
    const errors: unknown[] = [];
    const { calls, record } = recorder(2);
    const meter = createSlotlockUsageMeter({ record, intervalMs: 0, onError: (error) => errors.push(error) });
    meter.count({ principal: principal('acme'), operation: 'slotlock_list_resources', origin: 'rest' });
    await meter.flush();
    meter.count({ principal: principal('acme'), operation: 'slotlock_list_events', origin: 'rest' });
    meter.count({ principal: principal('acme'), operation: 'slotlock_list_events', origin: 'mcp' });
    await meter.flush(); // the held batch fails again: nothing new is sent
    expect(meter.pending()).toBe(3);
    await meter.close();
    const first = calls[0]?.flushId;
    expect(calls.map((call) => call.flushId)).toEqual([first, first, first, expect.any(String)]);
    expect(calls[3]?.flushId).not.toBe(first);
    expect(calls[3]?.rows.map((row) => [row.origin, row.count])).toEqual([
      ['rest', 1],
      ['mcp', 1],
    ]);
    expect(meter.pending()).toBe(0);
    expect(errors).toHaveLength(2);
  });

  it('never lets counting change a call, and flushes one at a time', async () => {
    let concurrent = 0;
    let most = 0;
    const meter = createSlotlockUsageMeter({
      intervalMs: 0,
      record: async () => {
        concurrent += 1;
        most = Math.max(most, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return true;
      },
    });
    expect(() =>
      meter.count({ principal: { subject: 'x', tenantRef: '' }, operation: 'slotlock_list_resources', origin: 'rest' }),
    ).not.toThrow();
    expect(meter.pending()).toBe(0);
    for (let i = 0; i < 5; i++) {
      meter.count({ principal: principal('acme'), operation: 'slotlock_list_resources', origin: 'rest' });
      void meter.flush();
    }
    await meter.close();
    expect(most).toBe(1);
  });

  it('names UTC days and totals every metric', () => {
    expect(slotlockUsageDay(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(
      totalSlotlockUsage([
        { day: '2026-11-10', metric: 'operations', keyId: '', origin: 'rest', count: 3 },
        { day: '2026-11-11', metric: 'operations', keyId: KEY, origin: 'mcp', count: 2 },
        { day: '2026-11-11', metric: 'bookings', keyId: KEY, origin: 'mcp', count: 1 },
      ]),
    ).toEqual({ operations: 5, bookings: 1, holds: 0 });
  });
});
