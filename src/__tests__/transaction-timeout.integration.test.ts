// The README's production checklist advises a `transaction_timeout` on the serving role (PostgreSQL
// 17+): a caller's transaction that a store call runs inside cannot hold its locks and snapshot for
// longer. This pins that the setting ends such a transaction, and that a store call inside one that
// is still in time works. On PostgreSQL 16 the setting does not exist. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('transaction_timeout (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let version = 0;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 2, onnotice: () => {} });
    const [row] = await sql<{ version: number }[]>`
      SELECT current_setting('server_version_num')::int AS version`;
    version = row?.version ?? 0;
    expect(version).toBeGreaterThan(100_000);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('ends a transaction that runs past it, on PostgreSQL 17 and later', async () => {
    if (version < 170_000) {
      // Not a setting before 17: a role cannot be given it.
      await expect(sql`SET transaction_timeout = '1s'`).rejects.toMatchObject({ code: '42704' });
      return;
    }
    const scoped = postgres(url as string, {
      max: 1,
      onnotice: () => {},
      connection: { transaction_timeout: 300 },
    });
    try {
      // In time: the transaction commits.
      await scoped.begin(async (tx) => tx`SELECT 1`);
      // Past it: PostgreSQL ends it, and the session with it (a pool opens another). One message,
      // so nothing is sent on the connection after it is gone.
      // postgres.js reports the closed connection (CONNECTION_CLOSED) rather than the server's
      // "terminating connection due to transaction timeout", depending on which it reads first.
      await expect(scoped.unsafe('BEGIN; SELECT pg_sleep(1); COMMIT')).rejects.toThrow(
        /transaction timeout|CONNECTION_CLOSED/i,
      );
      // The pool connects again for the next one.
      expect(await scoped`SELECT 1 AS one`).toEqual([{ one: 1 }]);
    } finally {
      await scoped.end({ timeout: 0 }).catch(() => undefined);
    }
  });
});
