// Monthly quotas (quotas.ts) with a fake database and clock: what a check counts, when it reads
// again, what it refuses, the notices it sends once, and the fields an answer carries.
import { describe, expect, it } from 'vitest';
import { SlotlockAgentOperationError } from '../agent-server.js';
import { SLOTLOCK_PLAN_QUOTAS, type SlotlockPlan } from '../plans.js';
import {
  type SlotlockQuotaNotice,
  type SlotlockQuotaUse,
  createSlotlockQuotas,
  slotlockQuotaFields,
  slotlockQuotaPeriod,
  slotlockQuotaRefusal,
} from '../quotas.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');

function fixture(options: { plan?: SlotlockPlan | null; used?: SlotlockQuotaUse } = {}) {
  const state = {
    at: NOW,
    plan: options.plan === undefined ? ('free' as SlotlockPlan | null) : options.plan,
    used: options.used ?? { operations: 0, bookings: 0 },
    reads: 0,
    fromDays: [] as string[],
    fail: false,
    local: { unrecorded: 0, counted: 0 },
    notices: [] as SlotlockQuotaNotice[],
    noticeFails: false,
    errors: [] as unknown[],
  };
  const quotas = createSlotlockQuotas({
    now: () => state.at,
    plan: async () => {
      if (state.fail) throw new Error('database away');
      return state.plan;
    },
    used: async (_tenant, fromDay) => {
      state.reads += 1;
      state.fromDays.push(fromDay);
      return { ...state.used };
    },
    local: () => ({ ...state.local }),
    notice: async (notice) => {
      if (state.noticeFails) throw new Error('notice failed');
      state.notices.push(notice);
    },
    onError: (error) => state.errors.push(error),
  });
  return { state, quotas };
}

const check = (quotas: ReturnType<typeof fixture>['quotas'], operation = 'slotlock_list_resources' as const) =>
  quotas.check({ tenantRef: 'acme', operation });

describe('monthly quotas', () => {
  it('has the plans RFC 0003 proposes', () => {
    expect(SLOTLOCK_PLAN_QUOTAS).toEqual({
      free: { operations: 25_000, bookings: 1_000, stopPercent: 100 },
      developer: { operations: 500_000, bookings: 25_000, stopPercent: 110 },
    });
  });

  it('binds no tenant without a plan', async () => {
    const { state, quotas } = fixture({ plan: null, used: { operations: 1e9, bookings: 1e9 } });
    expect(await check(quotas)).toEqual({ ok: true, standings: [] });
    // A tenant on no plan is never counted.
    expect(state.reads).toBe(0);
  });

  it('counts the month so far from its first day, with what this server has not recorded', async () => {
    const { state, quotas } = fixture({ used: { operations: 100, bookings: 3 } });
    state.local = { unrecorded: 7, counted: 50 };
    const first = await check(quotas);
    expect(state.fromDays).toEqual(['2026-11-01']);
    expect(first).toMatchObject({
      ok: true,
      standings: [
        { metric: 'operations', quota: 25_000, stop: 25_000, used: 107, periodStart: '2026-11-01' },
        { metric: 'bookings', quota: 1_000, stop: 1_000, used: 3 },
      ],
    });
    expect(first.ok && first.standings[0]?.resetsAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // Ten more operations counted since, and a booking this server let run: no read for 30 s.
    state.local = { unrecorded: 2, counted: 60 };
    await check(quotas, 'slotlock_book_together' as never);
    state.at += 29_000;
    expect(await check(quotas)).toMatchObject({
      standings: [{ used: 117 }, { used: 4 }],
    });
    expect(state.reads).toBe(1);
    state.at += 1_000;
    state.used = { operations: 300, bookings: 4 };
    state.local = { unrecorded: 0, counted: 60 };
    expect(await check(quotas)).toMatchObject({ standings: [{ used: 300 }, { used: 4 }] });
    expect(state.reads).toBe(2);
  });

  it('refuses every operation past the operations quota, at the reset', async () => {
    const { quotas } = fixture({ used: { operations: 25_000, bookings: 0 } });
    const refused = await check(quotas);
    expect(refused).toMatchObject({ ok: false, exceeded: { metric: 'operations', stop: 25_000, used: 25_000 } });
    if (refused.ok) throw new Error('not refused');
    const error = slotlockQuotaRefusal(refused.exceeded);
    expect(error).toBeInstanceOf(SlotlockAgentOperationError);
    expect(error).toMatchObject({
      code: 'quota_exceeded',
      status: 429,
      details: {
        metric: 'operations',
        quota: '25000',
        stop: '25000',
        used: '25000',
        resets_at: '2026-12-01T00:00:00.000Z',
      },
    });
  });

  it('never refuses reading the usage or erasing the tenant', async () => {
    const { quotas } = fixture({ used: { operations: 25_000, bookings: 1_000 } });
    for (const operation of ['slotlock_get_usage', 'slotlock_erase_tenant'] as const) {
      expect(await quotas.check({ tenantRef: 'acme', operation }), operation).toMatchObject({
        ok: true,
        standings: [{ used: 25_000 }, { used: 1_000 }],
      });
    }
    expect((await quotas.check({ tenantRef: 'acme', operation: 'slotlock_get_tenant' })).ok).toBe(false);
  });

  it('notes bookings as the database counted them, never on the estimate since', async () => {
    const { state, quotas } = fixture({ used: { operations: 0, bookings: 799 } });
    // Booking operations this server let run, which may not all have booked.
    for (let i = 0; i < 5; i += 1) await quotas.check({ tenantRef: 'acme', operation: 'slotlock_put_reservation' });
    await Promise.resolve();
    expect(state.notices).toEqual([]);
    state.at += 30_000;
    state.used = { operations: 0, bookings: 800 };
    await check(quotas);
    await Promise.resolve();
    expect(state.notices).toEqual([expect.objectContaining({ metric: 'bookings', percent: 80, used: 800 })]);
  });

  it('refuses only the operations that book once the bookings quota is used up', async () => {
    const { quotas } = fixture({ used: { operations: 10, bookings: 1_000 } });
    expect((await check(quotas)).ok).toBe(true);
    expect((await quotas.check({ tenantRef: 'acme', operation: 'slotlock_cancel_reservation' })).ok).toBe(true);
    for (const operation of ['slotlock_put_reservation', 'slotlock_confirm_hold', 'slotlock_hold_slots'] as const) {
      expect(await quotas.check({ tenantRef: 'acme', operation }), operation).toMatchObject({
        ok: false,
        exceeded: { metric: 'bookings', stop: 1_000 },
      });
    }
  });

  it('lets a Developer tenant go a tenth past its quota before refusing', async () => {
    const { state, quotas } = fixture({ plan: 'developer', used: { operations: 549_999, bookings: 0 } });
    expect(await check(quotas)).toMatchObject({
      ok: true,
      standings: [{ quota: 500_000, stop: 550_000 }, { quota: 25_000, stop: 27_500 }],
    });
    state.at += 30_000;
    state.used = { operations: 550_000, bookings: 0 };
    expect(await check(quotas)).toMatchObject({ ok: false, exceeded: { metric: 'operations', stop: 550_000 } });
  });

  it('reads again every 2 seconds near a stop, and at once in a new month', async () => {
    const { state, quotas } = fixture({ used: { operations: 23_000, bookings: 0 } });
    await check(quotas);
    state.at += 1_999;
    await check(quotas);
    expect(state.reads).toBe(1);
    state.at += 1;
    await check(quotas);
    expect(state.reads).toBe(2);
    // December: counted again from its first day, whatever the cache held.
    state.at = Date.parse('2026-12-01T00:00:00Z');
    state.used = { operations: 0, bookings: 0 };
    expect(await check(quotas)).toMatchObject({
      ok: true,
      standings: [{ used: 0, periodStart: '2026-12-01' }, { used: 0 }],
    });
    expect(state.fromDays.at(-1)).toBe('2026-12-01');
  });

  it('lets an operation run when the counts cannot be read, on the last ones it read', async () => {
    const { state, quotas } = fixture({ used: { operations: 25_000, bookings: 0 } });
    state.fail = true;
    expect(await check(quotas)).toEqual({ ok: true, standings: [] });
    expect(state.errors).toHaveLength(1);
    state.fail = false;
    expect((await check(quotas)).ok).toBe(false);
    state.at += 30_000;
    state.fail = true;
    // Still this month's counts: still refused.
    expect((await check(quotas)).ok).toBe(false);
  });

  it('reads once for checks that arrive together', async () => {
    const { state, quotas } = fixture();
    await Promise.all([check(quotas), check(quotas), check(quotas)]);
    expect(state.reads).toBe(1);
  });

  it('notes 80% and 100% of each quota once, and tries a failed notice again', async () => {
    const { state, quotas } = fixture({ used: { operations: 20_000, bookings: 1_000 } });
    await check(quotas);
    await check(quotas);
    await Promise.resolve();
    expect(state.notices).toEqual([
      { tenantRef: 'acme', metric: 'operations', percent: 80, used: 20_000, quota: 25_000, periodStart: '2026-11-01' },
      { tenantRef: 'acme', metric: 'bookings', percent: 80, used: 1_000, quota: 1_000, periodStart: '2026-11-01' },
      { tenantRef: 'acme', metric: 'bookings', percent: 100, used: 1_000, quota: 1_000, periodStart: '2026-11-01' },
    ]);
    state.noticeFails = true;
    state.at += 30_000;
    state.used = { operations: 25_000, bookings: 1_000 };
    await check(quotas);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.errors).toHaveLength(1);
    state.noticeFails = false;
    await check(quotas);
    await Promise.resolve();
    expect(state.notices.at(-1)).toMatchObject({ metric: 'operations', percent: 100, used: 25_000 });
  });

  it('names each quota in the RateLimit fields, counting down to its stop', () => {
    const at = NOW;
    const { resetsAt } = slotlockQuotaPeriod(at);
    const fields = slotlockQuotaFields(
      [
        { metric: 'operations', quota: 500_000, stop: 550_000, used: 1_000, periodStart: '2026-11-01', resetsAt },
        { metric: 'bookings', quota: 25_000, stop: 27_500, used: 27_600, periodStart: '2026-11-01', resetsAt },
      ],
      at,
    );
    const seconds = (Date.parse('2026-12-01T00:00:00Z') - at) / 1_000;
    expect(fields).toEqual({
      rateLimit: [`"operations_month";r=549000;t=${seconds}`, `"bookings_month";r=0;t=${seconds}`],
      policy: ['"operations_month";q=550000;w=2592000', '"bookings_month";q=27500;w=2592000'],
      retryAfter: seconds,
    });
  });

  it('starts each month on its first day, UTC, across a year', () => {
    expect(slotlockQuotaPeriod(Date.parse('2026-12-31T23:59:59Z'))).toEqual({
      periodStart: '2026-12-01',
      resetsAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(slotlockQuotaPeriod(Date.parse('2027-02-01T00:00:00Z')).periodStart).toBe('2027-02-01');
  });
});
