// The README's production checklist advises a `transaction_timeout` on the serving role (PostgreSQL
// 17+): a caller's transaction that a store call runs inside cannot hold its locks and snapshot for
// longer. This pins that the setting ends such a transaction, and that a store call inside one that
// is still in time works. On PostgreSQL 16 the setting does not exist. Skipped without DATABASE_URL.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const run = promisify(execFile);

/** A transaction that sleeps past a 300 ms transaction_timeout; prints how it ended. */
const OVERRUN = `
import postgres from 'postgres';
const ended = (error) => {
  console.log('ended: ' + (error?.code ?? '') + ' ' + (error?.message ?? error));
  process.exit(0);
};
process.on('uncaughtException', ended);
process.on('unhandledRejection', ended);
const sql = postgres(process.env.SLOTLOCK_TIMEOUT_URL, {
  max: 1, onnotice: () => {}, connection: { transaction_timeout: 300 },
});
await sql.unsafe('BEGIN; SELECT pg_sleep(2); COMMIT').then(() => console.log('committed'), ended);
process.exit(0);
`;

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
      expect(await scoped.begin(async (tx) => tx`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
    } finally {
      await scoped.end({ timeout: 0 });
    }
    // Past it: PostgreSQL ends the transaction and the session with it. The driver reports that
    // as it reads it, a rejected query or an error on the socket, so it runs in its own process
    // and the test reads what that process saw.
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', OVERRUN], {
      cwd: process.cwd(),
      env: { ...process.env, SLOTLOCK_TIMEOUT_URL: url as string },
      timeout: 30_000,
    });
    expect(stdout).toMatch(/^ended: .*(transaction timeout|CONNECTION_CLOSED)/im);
  });
});
