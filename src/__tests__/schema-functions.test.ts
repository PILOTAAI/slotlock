// A newer dashboard on an older schema must not call functions the schema lacks: through Hyperdrive a
// failed call, even caught, cost the dashboard Worker's requests their connection ("Network
// connection lost", 14 November 2026). The workspaces store asks first, once, and calls only what
// is there.
import { describe, expect, it } from 'vitest';
import { createSlotlockSchemaFunctions } from '../schema-functions.js';
import { createSlotlockDashboardWorkspaces } from '../workspaces.js';
import type { SlotlockSql } from '../store.js';

/** A stand-in client: records each statement's text, answers the probe with `present`. */
function fakeSql(present: string[], failing = false) {
  const statements: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('$');
      statements.push(text);
      if (text.includes('to_regprocedure')) {
        if (failing) return Promise.reject(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
        const asked = values[0] as string[];
        return Promise.resolve(asked.filter((signature) => present.includes(signature)).map((signature) => ({ signature })));
      }
      if (text.includes('tenant_suspension_notice')) return Promise.resolve([]);
      if (text.includes('tenant_dashboard_notices')) return Promise.resolve([{ notices: { announcements: [], flags: {} } }]);
      return Promise.resolve([]);
    },
    { array: (values: unknown[]) => values, json: (value: unknown) => value },
  );
  return { sql: sql as unknown as SlotlockSql, statements };
}

const calls = (statements: string[], name: string) => statements.filter((text) => text.includes(`slotlock.${name}(`)).length;

describe('functions a schema from an earlier release lacks', () => {
  it('are never called by the dashboard, which shows no notice instead', async () => {
    const { sql, statements } = fakeSql([]);
    const workspaces = createSlotlockDashboardWorkspaces(sql);
    await expect(workspaces.suspension?.('github:1')).resolves.toBeNull();
    await workspaces.notices?.('github:1');
    await workspaces.notices?.('github:2');
    expect(calls(statements, 'tenant_suspension_notice')).toBe(0);
    expect(calls(statements, 'tenant_dashboard_notices')).toBe(0);
    // One question for both, not one per call.
    expect(statements.filter((text) => text.includes('to_regprocedure'))).toHaveLength(1);
  });

  it('are called once the schema has them', async () => {
    const { sql, statements } = fakeSql(['slotlock.tenant_suspension_notice(text)', 'slotlock.tenant_dashboard_notices(text)']);
    const workspaces = createSlotlockDashboardWorkspaces(sql);
    await workspaces.suspension?.('github:1');
    await workspaces.notices?.('github:1');
    expect(calls(statements, 'tenant_suspension_notice')).toBe(1);
    expect(calls(statements, 'tenant_dashboard_notices')).toBe(1);
  });

  it('include the one step a sign-in through a team provider alone is recorded in: without it, nothing is called', async () => {
    const connection = '00000000-0000-4000-8000-000000000001';
    const without = fakeSql([]);
    const earlier = createSlotlockDashboardWorkspaces(without.sql).sso;
    await expect(earlier?.startScoped('sid', 'github:1', connection, 1, new Date(), {})).resolves.toBeNull();
    expect(calls(without.statements, 'sso_session_started')).toBe(0);
    const present = fakeSql(['slotlock.sso_session_started(text, bytea, timestamptz, text, text, uuid, integer)']);
    await createSlotlockDashboardWorkspaces(present.sql).sso?.startScoped('sid', 'github:1', connection, 1, new Date(), {});
    expect(calls(present.statements, 'sso_session_started')).toBe(1);
  });

  it('are taken as missing when the question itself fails, and asked again after a minute', async () => {
    let clock = 0;
    const failing = fakeSql([], true);
    const has = createSlotlockSchemaFunctions(failing.sql, ['slotlock.x(text)'], () => clock);
    await expect(has('slotlock.x(text)')).resolves.toBe(false);
    await expect(has('slotlock.x(text)')).resolves.toBe(false);
    expect(failing.statements).toHaveLength(1);
    clock = 61_000;
    await has('slotlock.x(text)');
    expect(failing.statements).toHaveLength(2);
  });
});
