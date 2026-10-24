// applySchema validates the constraints an upgrade added NOT VALID in a transaction of its own,
// after the DDL's commits. Inside the DDL's transaction every slotlock table it altered stays under
// ACCESS EXCLUSIVE until commit (PostgreSQL holds a lock to the end of its transaction), so a scan
// there blocks every serving query; on its own, each VALIDATE holds only SHARE UPDATE EXCLUSIVE,
// which no read or row write waits for. A stand-in client records which statements ran in which
// transaction; schema-version.integration runs the validation itself on a real database.
import type { TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';

/** A client whose transactions answer applySchema's own queries, recording each one's statements. */
function recordingClient() {
  const transactions: string[][] = [];
  const answer = (text: string): unknown[] => {
    if (text.includes("current_setting('search_path')")) return [{ path: 'public' }];
    if (text.includes("current_setting('lock_timeout')")) return [{ lock: '0', statement: '0' }];
    if (text.includes('has_table_privilege')) return [{ versioned: false, lifted: false }];
    if (text.includes('AS digest')) return [{ digest: 'digest' }];
    return [];
  };
  const client = {
    begin: async (
      mode: string | ((tx: TransactionSql) => Promise<unknown>),
      maybe?: (tx: TransactionSql) => Promise<unknown>,
    ) => {
      const callback = typeof mode === 'function' ? mode : maybe;
      const statements: string[] = [];
      transactions.push(statements);
      const tx = Object.assign(
        async (strings: TemplateStringsArray) => {
          const text = strings.join('?');
          statements.push(text);
          return answer(text);
        },
        {
          unsafe: async (text: string) => {
            statements.push(text);
            return [];
          },
        },
      ) as unknown as TransactionSql;
      return callback?.(tx);
    },
  };
  return { client: client as never, transactions };
}

describe('applySchema', () => {
  it('validates NOT VALID constraints in a transaction after the one that altered the tables', async () => {
    const { client, transactions } = recordingClient();
    await createSlotlockStore(client).applySchema();
    const altering = transactions.findIndex((statements) =>
      statements.some((text) => text.includes('CREATE TABLE IF NOT EXISTS slotlock.reservations')),
    );
    const validating = transactions.findIndex((statements) =>
      statements.some((text) => text.includes('VALIDATE CONSTRAINT')),
    );
    expect(altering).toBeGreaterThanOrEqual(0);
    expect(validating).toBeGreaterThan(altering);
    // The digest that lets the next migration skip everything is recorded after validation, which
    // it reads (whether each constraint is validated).
    const recorded = transactions.findIndex((statements) =>
      statements.some((text) => text.includes('SET ddl_sha256')),
    );
    expect(recorded).toBe(validating);
  });
});
