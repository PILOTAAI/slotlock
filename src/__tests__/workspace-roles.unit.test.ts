// The roles and what each may do (workspace-roles.ts), held to the matrix the dashboard enforces, and
// every dashboard route held to a capability, so a route added without one is caught here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES,
  SLOTLOCK_DASHBOARD_POST_CAPABILITIES,
  SLOTLOCK_FRESH_CAPABILITIES,
  SLOTLOCK_ROLE_CAPABILITIES,
  SLOTLOCK_WORKSPACE_CAPABILITIES,
  SLOTLOCK_WORKSPACE_ROLES,
  slotlockRoleCan,
  slotlockRoleKeyScopes,
  slotlockRoleMayGrant,
} from '../workspace-roles.js';
import { SLOTLOCK_WORKSPACE_ROLE_VALUES } from '../ddl.js';

const dashboard = readFileSync(new URL('../dashboard.ts', import.meta.url), 'utf8');

describe('workspace roles', () => {
  it('gives the Owner everything, the Admin all but money and the workspace itself', () => {
    for (const capability of SLOTLOCK_WORKSPACE_CAPABILITIES) expect(slotlockRoleCan('owner', capability), capability).toBe(true);
    expect(slotlockRoleCan('admin', 'billing.manage')).toBe(false);
    expect(slotlockRoleCan('admin', 'workspace.own')).toBe(false);
    for (const capability of ['keys.full', 'webhooks.manage', 'members.manage', 'audit.read', 'contacts.forget'] as const) {
      expect(slotlockRoleCan('admin', capability), capability).toBe(true);
    }
  });

  it('lets a Developer hold credentials but not Full access, webhooks, people or money', () => {
    expect([...SLOTLOCK_ROLE_CAPABILITIES.developer].sort()).toEqual(
      ['account.use', 'assistant.chat', 'keys.manage_own', 'operations.run', 'resources.manage', 'sandbox.manage', 'usage.read', 'workspace.read'].sort(),
    );
    expect(slotlockRoleKeyScopes('developer')).toEqual(['read', 'write']);
    expect(slotlockRoleKeyScopes('admin')).toEqual(['read', 'write', 'admin']);
    expect(slotlockRoleKeyScopes('member')).toEqual([]);
  });

  it('keeps Member, Viewer and Billing to the least each needs', () => {
    expect(slotlockRoleCan('member', 'operations.run')).toBe(true);
    expect(slotlockRoleCan('member', 'keys.manage_own')).toBe(false);
    expect(slotlockRoleCan('viewer', 'operations.run')).toBe(false);
    expect(slotlockRoleCan('viewer', 'workspace.read')).toBe(true);
    expect([...SLOTLOCK_ROLE_CAPABILITIES.billing].sort()).toEqual(['account.use', 'billing.manage', 'usage.read']);
    expect(slotlockRoleCan(null, 'account.use')).toBe(false);
  });

  it('never lets anyone grant a power they lack', () => {
    expect(SLOTLOCK_WORKSPACE_ROLES.filter((role) => slotlockRoleMayGrant('admin', role))).toEqual([
      'admin',
      'developer',
      'member',
      'viewer',
    ]);
    expect(SLOTLOCK_WORKSPACE_ROLES.filter((role) => slotlockRoleMayGrant('owner', role))).toEqual([...SLOTLOCK_WORKSPACE_ROLES]);
    for (const role of ['developer', 'member', 'viewer', 'billing'] as const) {
      expect(SLOTLOCK_WORKSPACE_ROLES.some((granted) => slotlockRoleMayGrant(role, granted)), role).toBe(false);
    }
  });

  it('asks a fresh sign-in for credentials that reach everything, money, the workspace itself and its identity', () => {
    expect([...SLOTLOCK_FRESH_CAPABILITIES].sort()).toEqual(
      ['assistant.settings', 'billing.manage', 'identity.manage', 'keys.full', 'webhooks.manage', 'workspace.own'].sort(),
    );
    // A team's domains, and who joins through them, are its Owners' alone.
    expect(SLOTLOCK_WORKSPACE_ROLES.filter((role) => slotlockRoleCan(role, 'identity.manage'))).toEqual(['owner']);
  });

  it('names the same roles as the database allows', () => {
    expect([...SLOTLOCK_WORKSPACE_ROLE_VALUES]).toEqual([...SLOTLOCK_WORKSPACE_ROLES]);
  });
});

describe('every dashboard route needs a capability', () => {
  it('maps each POST route the dashboard accepts, and nothing else', () => {
    const block = /const POST_ROUTES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/.exec(dashboard)?.[1];
    expect(block, 'canary: POST_ROUTES').toBeDefined();
    const routes = [...(block ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
    expect(Object.keys(SLOTLOCK_DASHBOARD_POST_CAPABILITIES).sort()).toEqual(routes);
  });

  it('maps each page the dashboard serves to a signed-in person', () => {
    // The page routes of the GET switch, and the resource page.
    const pages = [...dashboard.matchAll(/authorizePage\(session, (?:'([^']+)'|route)\)/g)];
    expect(pages.length).toBeGreaterThan(5);
    for (const [, page] of pages) if (page) expect(SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[page], page).toBeDefined();
    // The GET switch's run of pages that fall through to one handler, ending at Settings.
    const listed = /(?:case '[^']+':\s*){8,}case '\/settings': \{/.exec(dashboard)?.[0] ?? '';
    expect(listed, 'canary: the pages of the GET switch').toContain("case '/plan':");
    for (const [, page] of listed.matchAll(/case '([^']+)':/g)) {
      expect(SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[page as string], page).toBeDefined();
    }
    for (const page of ['/', '/hours', '/closures', '/contacts', '/locations', '/resources/:id']) {
      expect(SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[page], page).toBeDefined();
    }
  });
});
