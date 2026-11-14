// Upgrading a database shaped as 0.11.0 left it to this release's billing: the plan's end date and
// trial, a refund alert, and the admin function whose results grew (dropped and made again, since
// CREATE OR REPLACE cannot change what a function returns). In a database of its own; needs a role
// that creates databases and roles, skipped without DATABASE_URL.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';
import { staffSession } from './helpers/admin-browser.js';

const url = process.env.DATABASE_URL?.trim();

/** Puts back what 0.11.0 had in place of this release's columns, checks and functions. */
async function shapeAsRelease0110(sql: postgres.Sql) {
  await sql.unsafe(`
    ALTER TABLE slotlock.tenant_plans DROP COLUMN ends_at, DROP COLUMN trialing;
    DROP INDEX slotlock.slotlock_tenant_plans_customer_idx;
    ALTER TABLE slotlock.billing_alerts DROP CONSTRAINT slotlock_billing_alerts_valid;
    ALTER TABLE slotlock.billing_alerts ADD CONSTRAINT slotlock_billing_alerts_valid CHECK (
      kind IN ('payment_failed', 'duplicate_subscription')
      AND octet_length(tenant_ref) BETWEEN 1 AND 500
      AND stripe_ref ~ '^(in|sub)_[A-Za-z0-9]{1,250}$'
      AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048
      AND (resolved_at IS NULL) = (resolved_by IS NULL)
      AND (resolved_by IS NULL OR octet_length(resolved_by) BETWEEN 1 AND 100));
    DROP FUNCTION slotlock.set_tenant_plan_renewal(text, text, timestamptz, boolean);
    DROP FUNCTION slotlock.tenant_plans_of_customer(text);
    DROP FUNCTION slotlock.staff_subscribed_plans();
    DROP FUNCTION slotlock.admin_accounts(text, text, text, text, text, integer);
    CREATE FUNCTION slotlock.admin_accounts(actor text, query text, plan_filter text, status_filter text, after text, page_size integer)
      RETURNS TABLE (account_ref text, kind text, name text, created_at timestamptz, last_active date,
                     plan text, plan_status text, suspended boolean, stripe_customer text,
                     operations_month bigint, bookings_month bigint)
      LANGUAGE sql AS $$ SELECT NULL, NULL, NULL, NULL::timestamptz, NULL::date, NULL, NULL, NULL::boolean, NULL, NULL::bigint, NULL::bigint WHERE false $$;
  `);
}

describe.skipIf(!url)('upgrading a 0.11.0 database to the console’s billing figures', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_figures_up_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let sql: postgres.Sql;
  let adminSql: postgres.Sql;

  const columns = async (table: string) =>
    (await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'slotlock' AND table_name = ${table}`).map(
      (row) => row.column_name,
    );
  const resultColumns = async (signature: string) =>
    (await sql<{ names: string[] | null }[]>`SELECT proargnames AS names FROM pg_proc WHERE oid = to_regprocedure(${signature})`)[0]?.names ?? null;
  const oidOf = async (signature: string) => (await sql<{ oid: string | null }[]>`SELECT to_regprocedure(${signature})::oid::text AS oid`)[0]?.oid ?? null;

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    sql = postgres(target.href, { max: 2, onnotice: () => undefined });
    await createSlotlockStore(sql).applySchema();
    await shapeAsRelease0110(sql);
    // What 0.11.0 wrote: a paying plan, a person with their display, staff, and a payment alert.
    await sql`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
                                         stripe_customer, stripe_subscription)
      VALUES ('github:7001', 'developer', 'active', 100, 100, 10, 'cus_Up1', 'sub_Up1')`;
    await sql`INSERT INTO slotlock.dashboard_people (person_ref, display) VALUES ('github:7001', '@upgraded')`;
    await sql`INSERT INTO slotlock.staff_members (staff_ref, role, added_by) VALUES ('github:7101', 'owner', 'cli:ops')`;
    await sql`INSERT INTO slotlock.billing_alerts (kind, tenant_ref, stripe_ref) VALUES ('payment_failed', 'github:7001', 'in_Up1')`;
    adminSql = postgres(Object.assign(new URL(target.href), { username: adminRole, password }).href, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await sql?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await root?.unsafe(`DROP ROLE IF EXISTS ${adminRole}`);
    await root?.end();
  });

  it('adds the columns, widens the alert check, and gives the functions their new shape, keeping every row', async () => {
    expect(await columns('tenant_plans')).not.toContain('ends_at');
    expect(await resultColumns('slotlock.admin_accounts(text, text, text, text, text, integer)')).not.toContain('plan_ends_at');

    const store = createSlotlockStore(sql);
    await store.applySchema();
    await store.grantAdminRole(adminRole);

    // A plan from before: renews (no end date), out of any trial, until the webhook says otherwise.
    expect(await sql`SELECT ends_at, trialing FROM slotlock.tenant_plans WHERE tenant_ref = 'github:7001'`).toEqual([{ ends_at: null, trialing: false }]);

    // The wider check holds every alert from before, and takes a refund's, validated after the migration.
    await sql`INSERT INTO slotlock.billing_alerts (kind, tenant_ref, stripe_ref) VALUES ('refunded_plan_active', 'github:7001', 'ch_Up1')`;
    expect((await sql`SELECT kind FROM slotlock.billing_alerts ORDER BY id`).map((row) => row.kind)).toEqual(['payment_failed', 'refunded_plan_active']);
    const unchecked = await sql`
      SELECT conname FROM pg_constraint WHERE connamespace = 'slotlock'::regnamespace AND NOT convalidated
         AND conname = 'slotlock_billing_alerts_valid'`;
    expect(unchecked).toEqual([]);

    // The function whose results grew, made again with its new column, and the new ones.
    expect(await resultColumns('slotlock.admin_accounts(text, text, text, text, text, integer)')).toContain('plan_ends_at');
    for (const signature of [
      'slotlock.set_tenant_plan_renewal(text, text, timestamptz, boolean)',
      'slotlock.tenant_plans_of_customer(text)',
      'slotlock.staff_subscribed_plans()',
    ]) {
      expect(await oidOf(signature), signature).not.toBeNull();
    }

    // The console's role runs them again once its grants are rerun, as `slotlock migrate` does.
    const session = await staffSession(sql, 'github:7101');
    const listed = await adminSql<{ account_ref: string; plan_ends_at: Date | null }[]>`
      SELECT account_ref, plan_ends_at FROM slotlock.admin_accounts(${session}, 'github:7001', NULL, NULL, NULL, 10)`;
    expect(listed).toEqual([{ account_ref: 'github:7001', plan_ends_at: null }]);
  });

  it('changes nothing when it runs again: no function is dropped and made again', async () => {
    const signatures = ['slotlock.admin_accounts(text, text, text, text, text, integer)'];
    const before = await Promise.all(signatures.map(oidOf));
    await createSlotlockStore(sql).applySchema();
    expect(await Promise.all(signatures.map(oidOf))).toEqual(before);
    expect(await sql`SELECT ends_at, trialing FROM slotlock.tenant_plans WHERE tenant_ref = 'github:7001'`).toEqual([{ ends_at: null, trialing: false }]);
  });
});
