// Pricing a partner's month (RFC 0003 P6), its checksum, which months may close, and the
// Slotlock-Client metrics label (P5): pure functions, no database.
import { describe, expect, it } from 'vitest';
import { createSlotlockMetrics } from '../metrics.js';
import {
  priceSlotlockPartnerMonth,
  slotlockClientLabel,
  slotlockClosedMonth,
  slotlockPartnerMonthChecksum,
  slotlockPreviousMonth,
} from '../partner-billing.js';
import { parseSlotlockPartnerContract } from '../partners.js';

const contract = parseSlotlockPartnerContract({
  plans: {
    small: { resources: 5, api_keys: 2, webhook_endpoints: 1, operations: 10_000, bookings: 500 },
    big: { resources: 50, api_keys: 20, webhook_endpoints: 5, operations: 200_000, bookings: 10_000 },
  },
  pricing: {
    currency: 'usd',
    active_account: 600,
    operations_over_quota_per_10k: 100,
    bookings_over_quota_per_100: 50,
    minimum: 10_000,
  },
});

describe('priceSlotlockPartnerMonth', () => {
  it('prices active accounts, each account’s use above its own quota, and the minimum', () => {
    const lines = priceSlotlockPartnerMonth(contract, [
      // 15,000 over: two blocks of 10,000 (rounded up per account); 1 booking over: one block of 100.
      { account: 'a', plan: 'small', totals: { operations: 25_000, bookings: 501 } },
      // 1 over: one more block, not merged with a's remainder.
      { account: 'b', plan: 'small', totals: { operations: 10_001 } },
      // Within its quota.
      { account: 'c', plan: 'big', totals: { operations: 150_000, bookings: 9_000 } },
      // No operation: not active, not priced.
      { account: 'd', plan: 'small', totals: { resources: 3 } },
    ]);
    expect(lines).toEqual([
      expect.objectContaining({ line: 'active_accounts', quantity: 3, amount: 1_800, currency: 'usd' }),
      expect.objectContaining({ line: 'operations_over_quota', quantity: 3, amount: 300 }),
      expect.objectContaining({ line: 'bookings_over_quota', quantity: 1, amount: 50 }),
      expect.objectContaining({ line: 'minimum', quantity: 1, amount: 10_000 - 2_150 }),
    ]);
  });

  it('adds no minimum line once the month reaches it, and nothing without pricing', () => {
    const busy = Array.from({ length: 20 }, (_, index) => ({
      account: `a${index}`,
      plan: 'small',
      totals: { operations: 1 },
    }));
    expect(priceSlotlockPartnerMonth(contract, busy).map((line) => line.line)).toEqual(['active_accounts']);
    const unpriced = parseSlotlockPartnerContract({ plans: { small: { resources: 5, api_keys: 2, webhook_endpoints: 1, operations: 1, bookings: 1 } } });
    expect(priceSlotlockPartnerMonth(unpriced, busy)).toEqual([]);
  });

  it('bills an account on a plan the contract no longer has for activity, never for overage', () => {
    expect(
      priceSlotlockPartnerMonth(contract, [{ account: 'gone', plan: 'retired', totals: { operations: 1_000_000 } }]).map(
        (line) => line.line,
      ),
    ).toEqual(['active_accounts', 'minimum']);
  });
});

describe('slotlockPartnerMonthChecksum', () => {
  it('is the same for the same numbers in any order, and differs for any other', () => {
    const lines = [{ line: 'minimum', description: 'x', quantity: 1, amount: 5, currency: 'usd' }];
    const one = slotlockPartnerMonthChecksum(
      [
        { account: 'a', plan: 'small', totals: { operations: 2, bookings: 1 } },
        { account: 'b', plan: 'small', totals: { operations: 3 } },
      ],
      lines,
    );
    const reordered = slotlockPartnerMonthChecksum(
      [
        { account: 'b', plan: 'small', totals: { operations: 3 } },
        { account: 'a', plan: 'small', totals: { bookings: 1, operations: 2 } },
      ],
      lines,
    );
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(one);
    expect(
      slotlockPartnerMonthChecksum([{ account: 'a', plan: 'small', totals: { operations: 2, bookings: 1 } }], lines),
    ).not.toBe(one);
  });
});

describe('slotlockClosedMonth', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('closes an ended month, with its first and last day', () => {
    expect(slotlockClosedMonth('2026-10', now)).toEqual({ from: '2026-10-01', to: '2026-10-31', next: '2026-11-01' });
    expect(slotlockClosedMonth('2024-02', now)).toMatchObject({ to: '2024-02-29' });
    expect(slotlockPreviousMonth(now)).toBe('2026-10');
    expect(slotlockPreviousMonth(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-12');
  });
  it('refuses this month, a later one and anything not YYYY-MM', () => {
    expect(() => slotlockClosedMonth('2026-11', now)).toThrow(expect.objectContaining({ code: 'month_not_ended' }));
    expect(() => slotlockClosedMonth('2027-01', now)).toThrow(expect.objectContaining({ code: 'month_not_ended' }));
    for (const bad of ['2026-13', '2026-1', 'last', '2026-10-01']) {
      expect(() => slotlockClosedMonth(bad, now), bad).toThrow(expect.objectContaining({ code: 'invalid_month' }));
    }
  });
});

describe('Slotlock-Client label', () => {
  const known = new Set(['stackapi', 'n8n']);
  it('names a known integrator, and nothing else from the request', () => {
    expect(slotlockClientLabel('StackAPI/2.3.1 (+https://stackapi.app)', known)).toBe('stackapi');
    expect(slotlockClientLabel('n8n', known)).toBe('n8n');
    expect(slotlockClientLabel('someone-else/1.0', known)).toBe('other');
    expect(slotlockClientLabel('  ', known)).toBe('none');
    expect(slotlockClientLabel(null, known)).toBe('none');
  });
  it('is counted in the metrics scrape', () => {
    const metrics = createSlotlockMetrics({ version: '0.0.0', now: () => 0 });
    metrics.client('stackapi');
    metrics.client('stackapi');
    metrics.client('other');
    const scrape = metrics.render();
    expect(scrape).toContain('slotlock_requests_by_client_total{client="stackapi"} 2');
    expect(scrape).toContain('slotlock_requests_by_client_total{client="other"} 1');
  });
});
