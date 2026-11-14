// Upgrading a database shaped as 0.11.0 left it to this release's billing and names: the plan's end
// date and trial, a refund alert, a person's provider name, a staff member's login, and the admin
// functions whose results grew (dropped and made again, since CREATE OR REPLACE cannot change what a
// function returns). In a database of its own; needs a role that creates databases and roles,
// skipped without DATABASE_URL.
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
    ALTER TABLE slotlock.billing_alerts DROP CONSTRAINT slotlock_billing_alerts_once;
    ALTER TABLE slotlock.billing_alerts ADD CONSTRAINT slotlock_billing_alerts_once UNIQUE (kind, stripe_ref);
    ALTER TABLE slotlock.dashboard_people DROP COLUMN name;
    ALTER TABLE slotlock.staff_members DROP COLUMN login;
    DROP FUNCTION slotlock.set_tenant_plan_renewal(text, text, timestamptz, boolean);
    DROP FUNCTION slotlock.tenant_plans_of_customer(text);
    DROP FUNCTION slotlock.dashboard_name(text, text);
    DROP FUNCTION slotlock.admin_staff_login(text, text);
    DROP FUNCTION slotlock.admin_staff_logins(text, text[]);
    DROP FUNCTION slotlock.staff_subscribed_plans();
    DROP FUNCTION slotlock.admin_staff_log(text, bigint, integer, text, text, text, timestamptz, timestamptz, boolean);
    CREATE FUNCTION slotlock.admin_staff_log(actor text, before bigint, page_size integer)
      RETURNS TABLE (chain_index bigint, occurred_at timestamptz, staff_ref text, action text,
                     account_ref text, target text, reason text, metadata jsonb)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL, NULL::jsonb WHERE false $$;
    DROP FUNCTION slotlock.staff_directory();
    CREATE FUNCTION slotlock.staff_directory()
      RETURNS TABLE (account_ref text, kind text, name text, created_at timestamptz)
      LANGUAGE sql AS $$ SELECT NULL, NULL, NULL, NULL::timestamptz WHERE false $$;
    DROP FUNCTION slotlock.admin_accounts(text, text, text, text, text, integer);
    CREATE FUNCTION slotlock.admin_accounts(actor text, query text, plan_filter text, status_filter text, after text, page_size integer)
      RETURNS TABLE (account_ref text, kind text, name text, created_at timestamptz, last_active date,
                     plan text, plan_status text, suspended boolean, stripe_customer text,
                     operations_month bigint, bookings_month bigint)
      LANGUAGE sql AS $$ SELECT NULL, NULL, NULL, NULL::timestamptz, NULL::date, NULL, NULL, NULL::boolean, NULL, NULL::bigint, NULL::bigint WHERE false $$;
    DROP FUNCTION slotlock.admin_staff(text);
    CREATE FUNCTION slotlock.admin_staff(actor text)
      RETURNS TABLE (staff_ref text, role text, status text, added_by text, added_at timestamptz,
                     last_seen_at timestamptz, passkeys integer, enrolling boolean)
      LANGUAGE sql AS $$ SELECT NULL, NULL, NULL, NULL, NULL::timestamptz, NULL::timestamptz, NULL::integer, NULL::boolean WHERE false $$;
    DROP FUNCTION slotlock.admin_cases(text, text, text, bigint, integer);
    CREATE FUNCTION slotlock.admin_cases(actor text, status_filter text, account text, after bigint, page_size integer)
      RETURNS TABLE (id bigint, account_ref text, source text, summary text, policy_section text, action_taken text,
                     status text, opened_by text, opened_at timestamptz, updated_at timestamptz)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL::timestamptz, NULL::timestamptz WHERE false $$;
    DROP FUNCTION slotlock.admin_overrides(text);
    CREATE FUNCTION slotlock.admin_overrides(actor text)
      RETURNS TABLE (id bigint, account_ref text, plan text, starts_at timestamptz, ends_at timestamptz, reason text,
                     created_by text, approved_by text, state text)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL, NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL WHERE false $$;
    DROP FUNCTION slotlock.admin_billing_alerts(text, boolean, bigint, integer);
    CREATE FUNCTION slotlock.admin_billing_alerts(actor text, open_only boolean, after bigint, page_size integer)
      RETURNS TABLE (id bigint, kind text, account_ref text, stripe_ref text, detail jsonb, created_at timestamptz,
                     resolved_at timestamptz, resolved_by text)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL, NULL, NULL, NULL::jsonb, NULL::timestamptz, NULL::timestamptz, NULL WHERE false $$;
    DROP FUNCTION slotlock.admin_usage_accounts(text);
    CREATE FUNCTION slotlock.admin_usage_accounts(actor text)
      RETURNS TABLE (account_ref text, plan text, operations bigint, bookings bigint, quota_operations bigint,
                     quota_bookings bigint, quota_stop_percent integer)
      LANGUAGE sql AS $$ SELECT NULL, NULL, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::integer WHERE false $$;
    DROP FUNCTION slotlock.admin_privacy_requests(text, boolean, bigint, integer);
    CREATE FUNCTION slotlock.admin_privacy_requests(actor text, open_only boolean, before bigint, page_limit integer)
      RETURNS TABLE (id bigint, account_ref text, kind text, concerns text, received_on date, due_on date,
                     status text, verified boolean, exporting boolean, erasure_asked boolean, erasure_approved boolean,
                     opened_by text, opened_at timestamptz, closed_at timestamptz)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL, NULL, NULL, NULL::date, NULL::date, NULL, NULL::boolean, NULL::boolean,
                                NULL::boolean, NULL::boolean, NULL, NULL::timestamptz, NULL::timestamptz WHERE false $$;
    DROP FUNCTION slotlock.admin_announcements(text, boolean);
    CREATE FUNCTION slotlock.admin_announcements(actor text, ended_too boolean)
      RETURNS TABLE (id bigint, audience text, plan text, account_ref text, kind text, message text, link text,
                     starts_at timestamptz, ends_at timestamptz, created_by text, created_at timestamptz,
                     ended_by text, ended_at timestamptz, state text)
      LANGUAGE sql AS $$ SELECT NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL, NULL::timestamptz, NULL::timestamptz, NULL,
                                NULL::timestamptz, NULL, NULL::timestamptz, NULL WHERE false $$;
  `);
}

/** The functions that name the accounts in their results, and the column each gained. */
const NAMING = Object.freeze([
  ['slotlock.admin_cases(text, text, text, bigint, integer)', 'account_name'],
  ['slotlock.admin_overrides(text)', 'account_name'],
  ['slotlock.admin_billing_alerts(text, boolean, bigint, integer)', 'account_name'],
  ['slotlock.admin_usage_accounts(text)', 'name'],
  ['slotlock.admin_privacy_requests(text, boolean, bigint, integer)', 'account_name'],
  ['slotlock.admin_announcements(text, boolean)', 'account_name'],
  ['slotlock.admin_staff_log(text, bigint, integer, text, text, text, timestamptz, timestamptz, boolean)', 'account_name'],
] as const);

describe.skipIf(!url)('upgrading a 0.11.0 database to the console’s billing figures and names', () => {
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
    expect(await columns('dashboard_people')).toContain('name');
    expect(await columns('staff_members')).toContain('login');
    expect(await sql`SELECT display, name FROM slotlock.dashboard_people WHERE person_ref = 'github:7001'`).toEqual([{ display: '@upgraded', name: null }]);

    // The wider check holds every alert from before, and takes a refund's, validated after the migration.
    await sql`INSERT INTO slotlock.billing_alerts (kind, tenant_ref, stripe_ref) VALUES ('refunded_plan_active', 'github:7001', 'ch_Up1')`;
    expect((await sql`SELECT kind FROM slotlock.billing_alerts ORDER BY id`).map((row) => row.kind)).toEqual(['payment_failed', 'refunded_plan_active']);
    // One alert per account and Stripe object: one payment for two accounts tells both, once each.
    await sql`SELECT slotlock.note_billing_event('refunded_plan_active', 'github:7002', 'ch_Up1', '{}'::jsonb)`;
    await sql`SELECT slotlock.note_billing_event('refunded_plan_active', 'github:7002', 'ch_Up1', '{}'::jsonb)`;
    expect((await sql`SELECT tenant_ref FROM slotlock.billing_alerts WHERE stripe_ref = 'ch_Up1' ORDER BY tenant_ref`).map((row) => row.tenant_ref)).toEqual(['github:7001', 'github:7002']);
    const unchecked = await sql`
      SELECT conname FROM pg_constraint WHERE connamespace = 'slotlock'::regnamespace AND NOT convalidated
         AND conname IN ('slotlock_billing_alerts_valid', 'slotlock_dashboard_people_name_valid', 'slotlock_staff_members_login_valid')`;
    expect(unchecked).toEqual([]);
    await expect(sql`UPDATE slotlock.dashboard_people SET name = ${'Ada\u0007'} WHERE person_ref = 'github:7001'`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE slotlock.staff_members SET login = '<b>' WHERE staff_ref = 'github:7101'`).rejects.toMatchObject({ code: '23514' });

    // The functions whose results grew, made again with their new columns; the staff log's old form gone.
    expect(await resultColumns('slotlock.staff_directory()')).toContain('display');
    expect(await resultColumns('slotlock.admin_accounts(text, text, text, text, text, integer)')).toEqual(expect.arrayContaining(['display', 'plan_ends_at']));
    expect(await resultColumns('slotlock.admin_staff(text)')).toContain('login');
    expect(await oidOf('slotlock.admin_staff_log(text, bigint, integer)')).toBeNull();
    for (const [signature, column] of NAMING) {
      expect(await resultColumns(signature), signature).toContain(column);
    }
    for (const signature of [
      'slotlock.set_tenant_plan_renewal(text, text, timestamptz, boolean)',
      'slotlock.tenant_plans_of_customer(text)',
      'slotlock.dashboard_name(text, text)',
      'slotlock.staff_subscribed_plans()',
      'slotlock.admin_staff_log(text, bigint, integer, text, text, text, timestamptz, timestamptz, boolean)',
    ]) {
      expect(await oidOf(signature), signature).not.toBeNull();
    }

    // The console's role runs them again once its grants are rerun, as `slotlock migrate` does.
    const session = await staffSession(sql, 'github:7101');
    const listed = await adminSql<{ account_ref: string; display: string | null; plan_ends_at: Date | null }[]>`
      SELECT account_ref, display, plan_ends_at FROM slotlock.admin_accounts(${session}, '@upgraded', NULL, NULL, NULL, 10)`;
    expect(listed).toEqual([{ account_ref: 'github:7001', display: '@upgraded', plan_ends_at: null }]);
    expect(await adminSql`SELECT staff_ref, login FROM slotlock.admin_staff(${session})`).toEqual([{ staff_ref: 'github:7101', login: null }]);
    expect(await adminSql`SELECT account_ref, account_name, account_display FROM slotlock.admin_billing_alerts(${session}, true, NULL, 10) WHERE stripe_ref = 'in_Up1'`).toEqual([
      { account_ref: 'github:7001', account_name: null, account_display: '@upgraded' },
    ]);
  });

  it('clears a name kept under the earlier, looser check that the stricter one refuses, then validates it', async () => {
    // As the first form of this release's check left it: ASCII's controls only.
    await sql.unsafe(`
      ALTER TABLE slotlock.dashboard_people DROP CONSTRAINT slotlock_dashboard_people_name_valid;
      ALTER TABLE slotlock.dashboard_people ADD CONSTRAINT slotlock_dashboard_people_name_valid
        CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)
                                AND name !~ '[\\u0001-\\u001F\\u007F]'))`);
    await sql`INSERT INTO slotlock.dashboard_people (person_ref, display, name) VALUES
      ('github:7002', '@hidden', ${'Ada\u200BLovelace'}), ('github:7003', '@kept', 'Grace Hopper')`;
    await createSlotlockStore(sql).applySchema();
    expect(await sql`SELECT person_ref, name FROM slotlock.dashboard_people WHERE person_ref IN ('github:7002', 'github:7003') ORDER BY person_ref`).toEqual([
      { person_ref: 'github:7002', name: null },
      { person_ref: 'github:7003', name: 'Grace Hopper' },
    ]);
    const [check] = await sql<{ valid: boolean; definition: string }[]>`
      SELECT convalidated AS valid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'slotlock_dashboard_people_name_valid'`;
    expect(check?.valid).toBe(true);
    expect(check?.definition).toContain('getdatabaseencoding');
    await expect(sql`UPDATE slotlock.dashboard_people SET name = ${'Ada\u00ADLovelace'} WHERE person_ref = 'github:7003'`).rejects.toMatchObject({ code: '23514' });
  });

  it('changes nothing when it runs again: no function is dropped and made again', async () => {
    const signatures = [
      'slotlock.staff_directory()',
      'slotlock.admin_accounts(text, text, text, text, text, integer)',
      'slotlock.admin_staff(text)',
      ...NAMING.map(([signature]) => signature),
    ];
    const before = await Promise.all(signatures.map(oidOf));
    await createSlotlockStore(sql).applySchema();
    expect(await Promise.all(signatures.map(oidOf))).toEqual(before);
    expect(await sql`SELECT ends_at, trialing FROM slotlock.tenant_plans WHERE tenant_ref = 'github:7001'`).toEqual([{ ends_at: null, trialing: false }]);
  });
});
