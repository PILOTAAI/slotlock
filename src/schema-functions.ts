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
 * Every function code calls on a schema that may lack it, so asks about first. Only these can be
 * asked about. CI (src/__tests__/dashboard-schema.unit.test.ts) refuses a function the dashboard
 * Worker's code calls that is neither in the latest release's schema (the hosted database's,
 * workers/dashboard/released-schema-functions.json) nor listed here.
 */
export const SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS = [
  'slotlock.note_billing_event(text,text,text,jsonb)',
  'slotlock.set_tenant_plan_overage(text,text,boolean)',
  'slotlock.sso_session_started(text, bytea, timestamptz, text, text, uuid, integer)',
  'slotlock.tenant_dashboard_notices(text)',
  'slotlock.tenant_plan_overage(text)',
  'slotlock.tenant_suspension_notice(text)',
] as const;

export type SlotlockOptionalSchemaFunction = (typeof SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS)[number];

/**
 * Asks once per client, and again after a minute, which of `signatures` (such as
 * `slotlock.tenant_dashboard_notices(text)`) the schema has and this role may execute. The query
 * itself cannot fail on a missing function: to_regprocedure answers NULL for one. A failed ask
 * answers false for every signature, so nothing that might fail is called.
 */
export function createSlotlockSchemaFunctions(
  sql: SlotlockSql,
  signatures: readonly SlotlockOptionalSchemaFunction[],
  now = () => Date.now(),
) {
  let asked: { at: number; answer: Promise<ReadonlySet<string>> } | null = null;
  return async (signature: SlotlockOptionalSchemaFunction): Promise<boolean> => {
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
