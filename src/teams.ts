// Teams on Cloud (RFC 0003, "Later"): GitHub organizations whose owners turn Slotlock on for them
// from the dashboard, kept in slotlock.dashboard_organizations, rather than a list in
// SLOTLOCK_DASHBOARD_ORGS. With SLOTLOCK_DASHBOARD_ORGS=enabled, every person signs in to their own
// tenant (`github:<id>`) and may switch to any organization they belong to that is turned on
// (`github-org:<id>`); an owner of one turns it on or off. Its keys work while it is on.
import type { SlotlockSql } from './store.js';

/** What the dashboard reads and changes of the organizations turned on (SLOTLOCK_DASHBOARD_ORGS=enabled). */
export interface SlotlockDashboardTeams {
  /** Of these organization ids, the ones turned on. */
  enabled(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** Turn Slotlock on for an organization, by an owner of it (`github:<id>`). True when it was off. */
  enable(org: { id: string; login: string }, by: string): Promise<boolean>;
  /** Turn it off: its keys stop at once, and its data stay. True when it was on. */
  disable(id: string, by: string): Promise<boolean>;
}

const ORGANIZATION_ID = /^[1-9]\d{0,19}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const PERSON = /^github:[1-9]\d{0,19}$/;

function refuse(message: string): never {
  throw Object.assign(new Error(`Slotlock organizations: ${message}`), { code: 'invalid_organization' as const });
}

/** The organizations turned on, through slotlock.enabled_organizations and its two writers. */
export function createSlotlockDashboardTeams(sql: SlotlockSql): SlotlockDashboardTeams {
  return {
    async enabled(ids) {
      const valid = ids.filter((id) => ORGANIZATION_ID.test(id));
      if (valid.length === 0) return new Set();
      const rows = await sql<{ org_id: string }[]>`
        SELECT org_id FROM slotlock.enabled_organizations(${valid.join(',')}::text) AS org_id`;
      return new Set(rows.map((row) => row.org_id));
    },
    async enable(org, by) {
      if (!ORGANIZATION_ID.test(org.id) || !GITHUB_LOGIN.test(org.login) || !PERSON.test(by)) {
        refuse('needs an organization id, its login and the person turning it on');
      }
      const [row] = await sql<{ changed: boolean }[]>`
        SELECT slotlock.enable_organization(${org.id}::text, ${org.login}::text, ${by}::text) AS changed`;
      return row?.changed === true;
    },
    async disable(id, by) {
      if (!ORGANIZATION_ID.test(id) || !PERSON.test(by)) refuse('needs an organization id and the person turning it off');
      const [row] = await sql<{ changed: boolean | null }[]>`
        SELECT slotlock.disable_organization(${id}::text, ${by}::text) AS changed`;
      return row?.changed === true;
    },
  };
}

/**
 * Whether an organization is turned on, for `serve`'s keys with SLOTLOCK_DASHBOARD_ORGS=enabled:
 * read through slotlock.enabled_organizations and kept for `ttlMs` (30 seconds), so turning one off
 * stops its keys on every server within that, without a query per request.
 */
export function createSlotlockOrganizationCheck(
  sql: SlotlockSql,
  options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
): (orgId: string) => Promise<boolean> {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const known = new Map<string, { at: number; enabled: Promise<boolean> }>();
  const teams = createSlotlockDashboardTeams(sql);
  return (orgId) => {
    if (!ORGANIZATION_ID.test(orgId)) return Promise.resolve(false);
    const cached = known.get(orgId);
    if (cached && now() - cached.at < ttlMs) return cached.enabled;
    const enabled = teams.enabled([orgId]).then(
      (found) => found.has(orgId),
      (error: unknown) => {
        // A failed read is not remembered: the next request asks again.
        known.delete(orgId);
        throw error;
      },
    );
    known.delete(orgId);
    known.set(orgId, { at: now(), enabled });
    if (known.size > maxEntries) known.delete(known.keys().next().value as string);
    return enabled;
  };
}
