// Whether this database's schema has the functions a newer feature calls, asked rather than tried.
//
// The dashboard Worker and `slotlock serve` can run a release ahead of the database: the Worker
// deploys from main on its own, and the server's release migrates the schema later. Calling a
// function the schema lacks fails, and catching that is not enough. Through Hyperdrive a failed
// query can cost the request its pooled connection, and the request's other queries then fail
// with "Network connection lost" (seen on 14 November 2026, when the dashboard's notice functions
// were missing). So code that must work on an earlier schema asks first and calls only what is
// there. The answer is kept for a minute per client, so a migration is seen without a restart.
import type { SlotlockSql } from './store.js';

const ASK_AGAIN_MS = 60_000;

/**
 * Asks once per client, and again after a minute, which of `signatures` (such as
 * `slotlock.tenant_dashboard_notices(text)`) the schema has and this role may execute. The query
 * itself cannot fail on a missing function: to_regprocedure answers NULL for one. A failed ask
 * answers false for every signature, so nothing that might fail is called.
 */
export function createSlotlockSchemaFunctions(sql: SlotlockSql, signatures: readonly string[], now = () => Date.now()) {
  let asked: { at: number; answer: Promise<ReadonlySet<string>> } | null = null;
  return async (signature: string): Promise<boolean> => {
    const at = now();
    if (!asked || at - asked.at > ASK_AGAIN_MS) {
      const answer = sql<{ signature: string }[]>`
        SELECT asked.signature
          FROM unnest(${sql.array([...signatures])}::text[]) AS asked(signature)
         WHERE COALESCE(pg_catalog.has_function_privilege(
                 pg_catalog.to_regprocedure(asked.signature), 'EXECUTE'), false)`
        .then((rows) => new Set(rows.map((row) => row.signature)) as ReadonlySet<string>)
        .catch(() => new Set<string>() as ReadonlySet<string>);
      asked = { at, answer };
    }
    return (await asked.answer).has(signature);
  };
}
