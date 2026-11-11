// Who belongs to which workspace, and as what (workspace-roles.ts), as the dashboard asks on every
// request: from slotlock.workspace_memberships and slotlock.dashboard_people, through their
// functions, never from the session cookie. A person's own workspace has no row: they are its
// Owner. GitHub organizations' members are recorded at each sign-in from what GitHub lists.
import type { SlotlockSql } from './store.js';
import { type SlotlockWorkspaceRole, isSlotlockWorkspaceRole } from './workspace-roles.js';

/** A person as the dashboard knows them: `github:<id>` or `google:<subject>`, never an email. */
const PERSON = /^(github:[1-9]\d{0,19}|google:[A-Za-z0-9._-]{1,255})$/;
const ORGANIZATION_ID = /^[1-9]\d{0,19}$/;

/** A GitHub organization the person is an active owner (`admin`) or member of, as GitHub lists it. */
export interface SlotlockGitHubMembership {
  id: string;
  role: 'admin' | 'member';
}

/** A person's standing in one workspace now. */
export interface SlotlockWorkspaceStanding {
  /** Their role, or null when they do not belong to it (any longer). */
  role: SlotlockWorkspaceRole | null;
  /**
   * The epoch their sessions must carry, or null when the person has no record (never signed in
   * with this store, or erased): then no session passes. "Sign out everywhere" draws a new one.
   */
  sessionEpoch: number | null;
}

/** What the dashboard reads and records of people and their memberships. */
export interface SlotlockDashboardWorkspaces {
  /**
   * Record a sign-in, returning the epoch to seal into the session. Signing in with GitHub, pass
   * the organizations GitHub lists the person in: they become memberships (owners Owner, members
   * Developer), and one GitHub no longer lists ends.
   */
  signedIn(person: string, githubOrganizations?: readonly SlotlockGitHubMembership[]): Promise<number>;
  /** The person's role in a tenant (its test environment is its live tenant's) and their epoch. */
  standing(tenantRef: string, person: string): Promise<SlotlockWorkspaceStanding>;
  /** End every session of the person: a new epoch is drawn, and those sealed under the old are refused. */
  signOutEverywhere(person: string): Promise<number>;
}

function refuse(message: string): never {
  throw Object.assign(new Error(`Slotlock workspaces: ${message}`), { code: 'invalid_person' as const });
}

function checkMemberships(organizations: readonly SlotlockGitHubMembership[] | undefined): void {
  if (organizations === undefined) return;
  if (organizations.length > 100) refuse('at most 100 organizations');
  for (const org of organizations) {
    if (!ORGANIZATION_ID.test(org.id) || (org.role !== 'admin' && org.role !== 'member')) {
      refuse('an organization needs its id and the role admin or member');
    }
  }
}

/** Through slotlock.dashboard_sign_in, dashboard_standing and dashboard_sign_out_everywhere. */
export function createSlotlockDashboardWorkspaces(sql: SlotlockSql): SlotlockDashboardWorkspaces {
  return {
    async signedIn(person, githubOrganizations) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      if (githubOrganizations !== undefined && !person.startsWith('github:')) refuse('only a GitHub person has organizations');
      checkMemberships(githubOrganizations);
      const listed =
        githubOrganizations === undefined
          ? null
          : JSON.stringify(githubOrganizations.map((org) => ({ id: org.id, role: org.role })));
      const [row] = await sql<{ epoch: number }[]>`
        SELECT slotlock.dashboard_sign_in(${person}::text, ${listed}::text) AS epoch`;
      return Number(row?.epoch ?? 0);
    },
    async standing(tenantRef, person) {
      if (!PERSON.test(person)) return { role: null, sessionEpoch: null };
      const [row] = await sql<{ role: string | null; session_epoch: number | null }[]>`
        SELECT role, session_epoch FROM slotlock.dashboard_standing(${tenantRef}::text, ${person}::text)`;
      const role = row?.role ?? null;
      const epoch = row?.session_epoch;
      return {
        role: isSlotlockWorkspaceRole(role) ? role : null,
        sessionEpoch: epoch === null || epoch === undefined ? null : Number(epoch),
      };
    },
    async signOutEverywhere(person) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      const [row] = await sql<{ epoch: number }[]>`
        SELECT slotlock.dashboard_sign_out_everywhere(${person}::text) AS epoch`;
      return Number(row?.epoch ?? 0);
    },
  };
}

/**
 * The same in memory, for tests and for a library deployment with a single server. `setRole` and
 * `remove` stand in for what the Members page will do.
 */
export function createSlotlockMemoryDashboardWorkspaces(): SlotlockDashboardWorkspaces & {
  setRole(tenantRef: string, person: string, role: SlotlockWorkspaceRole, source?: 'github_org' | 'invitation' | 'created'): void;
  remove(tenantRef: string, person: string): void;
} {
  const live = (tenantRef: string) => tenantRef.replace(/~test$/, '');
  const memberships = new Map<string, { role: SlotlockWorkspaceRole; source: string; active: boolean }>();
  const epochs = new Map<string, number>();
  /** A new epoch, never the one it replaces. */
  const draw = (old?: number) => {
    let next = old ?? 0;
    while (next === old || next === 0) next = 1 + Math.floor(Math.random() * 2_147_483_646);
    return next;
  };
  const key = (tenantRef: string, person: string) => `${live(tenantRef)}\n${person}`;
  return {
    async signedIn(person, githubOrganizations) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      checkMemberships(githubOrganizations);
      if (githubOrganizations !== undefined) {
        const listed = new Set(githubOrganizations.map((org) => `github-org:${org.id}`));
        for (const org of githubOrganizations) {
          const found = memberships.get(key(`github-org:${org.id}`, person));
          if (found && found.source !== 'github_org') continue;
          memberships.set(key(`github-org:${org.id}`, person), {
            role: org.role === 'admin' ? 'owner' : 'developer',
            source: 'github_org',
            active: true,
          });
        }
        for (const [at, membership] of memberships) {
          const [tenant, who] = at.split('\n');
          if (who === person && membership.source === 'github_org' && !listed.has(tenant as string)) membership.active = false;
        }
      }
      if (!epochs.has(person)) epochs.set(person, draw());
      return epochs.get(person) as number;
    },
    async standing(tenantRef, person) {
      const sessionEpoch = epochs.get(person) ?? null;
      if (live(tenantRef) === person) return { role: 'owner', sessionEpoch };
      const found = memberships.get(key(tenantRef, person));
      return { role: found?.active ? found.role : null, sessionEpoch };
    },
    async signOutEverywhere(person) {
      const next = draw(epochs.get(person));
      epochs.set(person, next);
      return next;
    },
    setRole(tenantRef, person, role, source = 'created') {
      memberships.set(key(tenantRef, person), { role, source, active: true });
    },
    remove(tenantRef, person) {
      // A removal made in Slotlock is Slotlock's: signing in again never undoes it.
      const found = memberships.get(key(tenantRef, person));
      if (found) {
        found.active = false;
        found.source = 'created';
      }
    },
  };
}
