// The admin console's schema (RFC 0006): what its role may run, what each function checks and
// records, and what none of them may return. The integration suite runs the same rules against
// PostgreSQL (staff.integration.test.ts).
import { describe, expect, it } from 'vitest';
import { POST_SLUG } from '../../site/src/lib/post-format.js';
import { SLOTLOCK_MAX_TENANT_EXPORTS } from '../store.js';
import {
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_DEFINER_FUNCTIONS,
  SLOTLOCK_DEFINER_TABLES,
  SLOTLOCK_OPERATOR_FUNCTIONS,
  SLOTLOCK_TENANT_TABLES,
  createSlotlockApplicationRoleGrantsDdl,
} from '../ddl.js';
import {
  SLOTLOCK_ADMIN_FUNCTIONS,
  SLOTLOCK_CONTENT_STEPS,
  SLOTLOCK_POST_SLUG_PATTERN,
  SLOTLOCK_STAFF_CAPABILITIES,
  SLOTLOCK_STAFF_DDL,
  SLOTLOCK_STAFF_OPERATOR_FUNCTIONS,
  SLOTLOCK_STAFF_ROLES,
  SLOTLOCK_STAFF_TABLES,
  createSlotlockAdminRoleGrantsDdl,
  slotlockStaffMay,
} from '../staff-ddl.js';

/** Each function the staff DDL defines: name, parameter list, header and body. */
const functions = [
  ...SLOTLOCK_STAFF_DDL.matchAll(
    /CREATE OR REPLACE FUNCTION (slotlock\.\w+)\(([^)]*)\)([\s\S]*?)\bAS (\$\w+\$)([\s\S]*?)\4/g,
  ),
].map(([, name, parameters, header, , body]) => ({
  name: name as string,
  types: (parameters ?? '')
    .split(',')
    .map((parameter) => parameter.trim().split(/\s+/).slice(1).join(' '))
    .filter(Boolean)
    .join(', '),
  header: header as string,
  body: body as string,
}));
const named = (signature: string) => functions.find((f) => f.name === signature.slice(0, signature.indexOf('(')));

describe('the admin console schema', () => {
  it('is part of the schema every migration applies', () => {
    expect(SLOTLOCK_CORE_DDL).toContain(SLOTLOCK_STAFF_DDL);
    for (const table of SLOTLOCK_STAFF_TABLES) {
      expect(SLOTLOCK_DEFINER_TABLES).toContain(table);
      expect(SLOTLOCK_TENANT_TABLES).not.toContain(table);
      expect(SLOTLOCK_STAFF_DDL).toContain(`ALTER TABLE slotlock.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(SLOTLOCK_STAFF_DDL).toContain(`REVOKE ALL ON slotlock.${table} FROM PUBLIC;`);
    }
  });

  it('defines every admin function as SECURITY DEFINER with the signature the grants name', () => {
    for (const signature of SLOTLOCK_ADMIN_FUNCTIONS) {
      const found = named(signature);
      expect(found, signature).toBeDefined();
      expect(`${found?.name}(${found?.types})`).toBe(signature);
      expect(found?.header).toContain('SECURITY DEFINER');
      expect(found?.header).toContain('SET search_path = pg_catalog, slotlock, pg_temp');
      expect(SLOTLOCK_STAFF_DDL).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    }
    // No other function in it runs as its owner.
    const definers = functions.filter((f) => f.header.includes('SECURITY DEFINER')).map((f) => f.name);
    expect(definers.sort()).toEqual(SLOTLOCK_ADMIN_FUNCTIONS.map((s) => s.slice(0, s.indexOf('('))).sort());
  });

  it('checks the staff role first in every admin function but sign-in', () => {
    for (const signature of SLOTLOCK_ADMIN_FUNCTIONS) {
      if (signature.startsWith('slotlock.admin_sign_in(')) continue;
      const body = named(signature)?.body ?? '';
      const check = body.indexOf('PERFORM slotlock.staff_require(actor, ');
      expect(check, signature).toBeGreaterThan(-1);
      // Nothing is read or written before the check.
      const before = body.slice(0, check);
      expect(before, signature).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|set_config)\b/);
    }
  });

  it('records every call in the staff log, except the reads the log itself and sign-in need', () => {
    // The log's own reads, sign-in's passkey list, and the provider cache (the page using it is logged).
    const silent = ['slotlock.admin_staff_log(', 'slotlock.admin_passkeys(', 'slotlock.admin_cache_read(', 'slotlock.admin_cache_write('];
    for (const signature of SLOTLOCK_ADMIN_FUNCTIONS) {
      if (silent.some((prefix) => signature.startsWith(prefix))) continue;
      expect(named(signature)?.body, signature).toContain('slotlock.staff_log(');
    }
  });

  it('returns no booking content: no titles, descriptions, attendees or contacts', () => {
    for (const signature of SLOTLOCK_ADMIN_FUNCTIONS) {
      const body = named(signature)?.body ?? '';
      expect(body, signature).not.toMatch(/\b(title|description|attendees?|contacts?|ip_address|user_agent|secret_hash)\b/i);
    }
  });

  it('resets the tenant setting after reading an account under its row security', () => {
    for (const f of functions) {
      const sets = f.body.match(/set_config\('slotlock\.tenant_ref', (account|requested), true\)/g) ?? [];
      const resets = f.body.match(/set_config\('slotlock\.tenant_ref', coalesce\(previous, ''\), true\)/g) ?? [];
      expect(resets.length, f.name).toBe(sets.length);
    }
  });

  it('keeps the database role map and the console role map the same', () => {
    expect([...SLOTLOCK_STAFF_ROLES]).toEqual(['owner', 'support', 'billing', 'editor', 'viewer']);
    const require = functions.find((f) => f.name === 'slotlock.staff_require')?.body ?? '';
    for (const role of SLOTLOCK_STAFF_ROLES) {
      const list = SLOTLOCK_STAFF_CAPABILITIES[role].map((c) => `'${c}'`).join(', ');
      expect(require).toContain(`WHEN '${role}' THEN ARRAY[${list}]::text[]`);
    }
    expect(slotlockStaffMay('owner', 'staff.log')).toBe(true);
    expect(slotlockStaffMay('support', 'accounts.read')).toBe(true);
    expect(slotlockStaffMay('support', 'staff.read')).toBe(false);
    expect(slotlockStaffMay('editor', 'accounts.read')).toBe(false);
    expect(slotlockStaffMay('viewer', 'accounts.read')).toBe(false);
    // Support actions (Phase 2): the Owner and Support, never Billing, an Editor or a Viewer.
    for (const capability of ['accounts.act', 'safety.act'] as const) {
      expect(slotlockStaffMay('owner', capability)).toBe(true);
      expect(slotlockStaffMay('support', capability)).toBe(true);
      expect(slotlockStaffMay('billing', capability)).toBe(false);
      expect(slotlockStaffMay('editor', capability)).toBe(false);
      expect(slotlockStaffMay('viewer', capability)).toBe(false);
    }
    // The CMS (Phase 4): the Owner and an Editor write posts; only the Owner publishes them (E5).
    expect(SLOTLOCK_STAFF_ROLES.filter((role) => slotlockStaffMay(role, 'content.write'))).toEqual(['owner', 'editor']);
    expect(SLOTLOCK_STAFF_ROLES.filter((role) => slotlockStaffMay(role, 'content.publish'))).toEqual(['owner']);
  });

  it('gives privacy requests to the Owner and Support, and an erasure to Owners only', () => {
    expect(SLOTLOCK_STAFF_ROLES.filter((role) => slotlockStaffMay(role, 'privacy.act'))).toEqual(['owner', 'support']);
    expect(SLOTLOCK_STAFF_ROLES.filter((role) => slotlockStaffMay(role, 'privacy.erase'))).toEqual(['owner']);
  });

  it('erases only in the checklist’s order, and keeps no account reference in a receipt', () => {
    const body = functions.find((f) => f.name === 'slotlock.admin_privacy_erase')?.body ?? '';
    const steps = [
      "PERFORM slotlock.staff_require(actor, 'privacy.erase')",
      'asked.verified_at IS NULL',
      'asked.erasure_approved_at IS NULL',
      'held.stripe_subscription IS NOT NULL',
      'slotlock.erase_tenant(asked.account_ref)',
      'INSERT INTO slotlock.privacy_erasure_receipts',
      'UPDATE slotlock.privacy_requests other',
    ].map((step) => body.indexOf(step));
    for (const [index, at] of steps.entries()) expect(at, String(index)).toBeGreaterThan(index === 0 ? -1 : (steps[index - 1] as number));
    const receipts = /CREATE TABLE IF NOT EXISTS slotlock\.privacy_erasure_receipts \(([\s\S]*?)\n\);/.exec(SLOTLOCK_STAFF_DDL)?.[1] ?? '';
    expect(receipts).toContain('account_digest');
    expect(receipts).not.toMatch(/\baccount_ref\b/);
    // The export limit is the store's (createTenantExport).
    expect(functions.find((f) => f.name === 'slotlock.admin_privacy_export')?.body).toContain(`kept < ${SLOTLOCK_MAX_TENANT_EXPORTS}`);
  });

  it('records a CMS step only for its role, and names the post by a slug the site reads', () => {
    const body = functions.find((f) => f.name === 'slotlock.admin_content_record')?.body ?? '';
    expect(body).toContain(`IF happened IN (${SLOTLOCK_CONTENT_STEPS.publish.map((s) => `'${s}'`).join(', ')}) THEN\n    PERFORM slotlock.staff_require(actor, 'content.publish');`);
    expect(body).toContain(`NOT IN (${SLOTLOCK_CONTENT_STEPS.write.map((s) => `'${s}'`).join(', ')})`);
    expect(String(POST_SLUG.source)).toBe(SLOTLOCK_POST_SLUG_PATTERN);
  });

  it('gives every action on an account a reason, and records it in the account\'s own audit log too', () => {
    for (const name of ['admin_suspend', 'admin_unsuspend', 'admin_revoke_key', 'admin_end_sessions']) {
      const body = functions.find((f) => f.name === `slotlock.${name}`)?.body ?? '';
      expect(body, name).toContain('PERFORM slotlock.staff_reason_valid(why);');
      expect(body, name).toContain('PERFORM slotlock.staff_customer_audit(actor, account, ');
      // The staff log first, then the customer's log, in the same transaction.
      expect(body.indexOf('slotlock.staff_log('), name).toBeLessThan(body.indexOf('slotlock.staff_customer_audit('));
    }
    // A note's text never reaches a log.
    const note = functions.find((f) => f.name === 'slotlock.admin_add_note')?.body ?? '';
    expect(note).toMatch(/staff_log\(actor, 'account\.note_added', account, 'note:' \|\| added, NULL,/);
    // The customer's log names staff by role, never by who they are.
    const audit = functions.find((f) => f.name === 'slotlock.staff_customer_audit')?.body ?? '';
    expect(audit).toContain("'system', 'slotlock-staff:' || coalesce(label, 'staff')");
  });

  it('grants the console role the admin functions and nothing else, and the serving role none of them', () => {
    const grants = createSlotlockAdminRoleGrantsDdl('slotlock_admin_app');
    expect(grants).toBe(
      `GRANT USAGE ON SCHEMA slotlock TO "slotlock_admin_app";\nGRANT EXECUTE ON FUNCTION ${SLOTLOCK_ADMIN_FUNCTIONS.join(', ')} TO "slotlock_admin_app";\n`,
    );
    expect(grants).not.toMatch(/ON slotlock\.\w+ TO|SELECT|INSERT|UPDATE|DELETE|ALL/);
    const serving = createSlotlockApplicationRoleGrantsDdl('slotlock_app');
    for (const signature of SLOTLOCK_ADMIN_FUNCTIONS) {
      expect(serving).not.toContain(signature.slice(0, signature.indexOf('(')));
      expect(SLOTLOCK_DEFINER_FUNCTIONS).not.toContain(signature);
    }
    for (const table of SLOTLOCK_STAFF_TABLES) expect(serving).not.toContain(`slotlock.${table}`);
    expect(() => createSlotlockAdminRoleGrantsDdl('PUBLIC')).toThrow();
    expect(() => createSlotlockAdminRoleGrantsDdl('public')).toThrow();
    expect(() => createSlotlockAdminRoleGrantsDdl('pg_read_all_data')).toThrow();
  });

  it('leaves adding, changing and removing staff to the deployment role', () => {
    const grants = createSlotlockAdminRoleGrantsDdl('slotlock_admin_app');
    for (const signature of SLOTLOCK_STAFF_OPERATOR_FUNCTIONS) {
      expect(SLOTLOCK_OPERATOR_FUNCTIONS).toContain(signature);
      const found = named(signature);
      expect(`${found?.name}(${found?.types})`).toBe(signature);
      expect(found?.header).not.toContain('SECURITY DEFINER');
      expect(SLOTLOCK_STAFF_DDL).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
      expect(grants).not.toContain(signature.slice(0, signature.indexOf('(')));
    }
  });

  it('keeps the staff log out of every erasure: it has no tenant column, and only grows', () => {
    const table = SLOTLOCK_STAFF_DDL.slice(
      SLOTLOCK_STAFF_DDL.indexOf('CREATE TABLE IF NOT EXISTS slotlock.staff_audit_events ('),
    );
    expect(table.slice(0, table.indexOf('\n);'))).not.toContain('tenant_ref');
    expect(SLOTLOCK_STAFF_DDL).toContain('BEFORE UPDATE OR DELETE ON slotlock.staff_audit_events');
    expect(SLOTLOCK_STAFF_DDL).toContain("RAISE EXCEPTION 'the staff audit log only grows'");
  });
});
