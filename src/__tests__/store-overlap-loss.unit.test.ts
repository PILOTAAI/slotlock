// A write that loses to the exclusion arbiter is always answered as an overlap. After the loss the
// store rolls the resource's series in a transaction of its own, as upkeep; when that fails (here a
// stand-in client drops it), the answer must still be the structured loss, not the upkeep's error.
// The real database runs the losing writes in event-horizon.integration.
import type { TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';

/** A client whose first transaction loses to the arbiter (23P01) and whose second one fails. */
function losingClient() {
  let transactions = 0;
  const client = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      // overlapLoss looks the winner up on the client itself.
      if (text.includes('FROM slotlock.reservations')) return [];
      throw new Error(`unexpected query: ${text}`);
    },
    {
      begin: async (
        mode: string | ((tx: TransactionSql) => Promise<unknown>),
        callback?: (tx: TransactionSql) => Promise<unknown>,
      ) => {
        void mode;
        void callback;
        transactions += 1;
        if (transactions === 1) {
          throw Object.assign(new Error('conflicting key value violates exclusion constraint'), {
            code: '23P01',
          });
        }
        throw new Error('connection terminated while rolling series');
      },
    },
  );
  return { client: client as never, transactions: () => transactions };
}

describe('a write lost to the exclusion arbiter', () => {
  it('is answered as an overlap even when rolling the series after it fails', async () => {
    const { client, transactions } = losingClient();
    const store = createSlotlockStore(client);
    await expect(
      store.createExternalReservation({
        tenantRef: 'fleet',
        externalRef: 'booking-1',
        resourceId: '9b2f6a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
        start: new Date('2027-02-01T09:00:00Z'),
        end: new Date('2027-02-01T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      }),
    ).resolves.toEqual({ ok: false, code: 'overlap', conflictingReservationId: null });
    expect(transactions()).toBe(2);
  });
});
