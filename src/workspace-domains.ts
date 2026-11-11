// A team's verified domains and the requests to join that come through them (teams phase 5), as
// the dashboard and the daily check reach them: through the SECURITY DEFINER functions of
// ddl-identity.ts, which check the actor's role and lock the team themselves. The DNS side, and
// the normaliser every domain and address goes through, is domains.ts.
import {
  type SlotlockDnsResolver,
  type SlotlockDomainCheck,
  checkSlotlockDomain,
  normalizeSlotlockDomain,
  slotlockDomainToken,
  slotlockEmailDomain,
} from './domains.js';
import type { SlotlockAuditEventInput, SlotlockSql } from './store.js';
import { type SlotlockWorkspaceRole, isSlotlockWorkspaceRole } from './workspace-roles.js';

const PERSON = /^(github:[1-9]\d{0,19}|google:[A-Za-z0-9._-]{1,255})$/;
const TEAM = /^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a change to a team's domains, or a request to join, was refused. */
export type SlotlockDomainChangeRefusal =
  | 'invalid_domain'
  | 'public_suffix'
  | 'consumer_domain'
  | 'not_found'
  | 'not_allowed'
  | 'already_claimed'
  | 'domain_taken'
  | 'domain_limit'
  | 'too_soon'
  | 'expired'
  | 'restricted'
  | 'no_verified_domain'
  | 'already_member'
  | 'pending'
  | 'request_limit'
  | 'member_cap'
  | 'role_not_allowed'
  | 'domain_not_verified';

/** What a domain lets the people whose verified address is at it do. */
export type SlotlockDomainJoinPolicy = 'off' | 'request' | 'auto';

/** A team's domain as its Identity page shows it. */
export interface SlotlockWorkspaceDomain {
  id: string;
  ascii: string;
  unicode: string;
  /** `pending` (with `expired` past its seven days), `verified`, or `lapsing` (its record has gone). */
  status: 'pending' | 'verified' | 'lapsing';
  expired: boolean;
  /** The token the record must hold: public, since it is published. */
  token: string;
  joinPolicy: SlotlockDomainJoinPolicy;
  createdAt: Date;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  missingSince: Date | null;
  errorSince: Date | null;
  lapseAfter: Date | null;
}

/** A team a person may ask to join, or join, through a verified address. */
export interface SlotlockDiscoverableWorkspace {
  tenantRef: string;
  handle: string;
  name: string;
  /** As people read it. */
  domain: string;
  /** As addresses are matched on it (ASCII). */
  domainKey: string;
  joinPolicy: 'request' | 'auto';
  requested: boolean;
}

/** A request waiting on a team. */
export interface SlotlockJoinRequest {
  id: string;
  person: string;
  display: string | null;
  email: string;
  domain: string;
  createdAt: Date;
  expiresAt: Date;
}

/** What one claim's check did, for the audit log and the people told. */
export interface SlotlockDomainCheckOutcome {
  domainId: string;
  tenantRef: string | null;
  domain: string | null;
  /**
   * `verified`, `restored` (a lapsing domain's new record found), `seen` (still there), `missing`
   * (gone once), `lapsing` (gone a day: a new token issued), `lapsed`, `absent` (a pending claim's
   * record not there yet), `unchanged`, `error`; or a refusal: `domain_taken`, `too_soon`,
   * `expired`, `not_found`, `not_allowed`.
   */
  outcome: string;
  check: SlotlockDomainCheck | null;
}

export interface SlotlockWorkspaceDomains {
  /** Claim a domain for a team (its Owner), with a new token. The domain as typed: normalised here. */
  claim(tenantRef: string, actor: string, typed: string): Promise<{ id: string } | { refusal: SlotlockDomainChangeRefusal }>;
  list(tenantRef: string): Promise<SlotlockWorkspaceDomain[]>;
  /** An Owner's "Verify now": the record looked up and the outcome applied (at most once a minute). */
  verifyNow(tenantRef: string, actor: string, id: string, resolvers: readonly SlotlockDnsResolver[]): Promise<SlotlockDomainCheckOutcome>;
  /**
   * The daily check: up to `limit` claims due, each looked up and applied. `seen` is told each claim's
   * missing_since before its check (null when its record was there at the last one).
   */
  checkDue(
    resolvers: readonly SlotlockDnsResolver[],
    limit?: number,
    seen?: (id: string, missingSince: Date | null) => void,
  ): Promise<SlotlockDomainCheckOutcome[]>;
  release(tenantRef: string, actor: string, id: string): Promise<SlotlockDomainChangeRefusal | null>;
  restrictInvites(tenantRef: string, actor: string, on: boolean): Promise<SlotlockDomainChangeRefusal | null>;
  /** Whether a team's invitations are held to its verified domains. */
  invitesRestricted(tenantRef: string): Promise<boolean>;
  setJoinPolicy(tenantRef: string, actor: string, id: string, policy: SlotlockDomainJoinPolicy): Promise<SlotlockDomainChangeRefusal | null>;
  /** The teams a person's verified addresses let them ask to join. */
  discoverable(person: string, emails: readonly string[]): Promise<SlotlockDiscoverableWorkspace[]>;
  requestToJoin(
    tenantRef: string,
    person: string,
    emails: readonly string[],
    memberCap: number | null,
  ): Promise<{ outcome: 'joined' | 'requested' } | { refusal: SlotlockDomainChangeRefusal }>;
  requests(tenantRef: string): Promise<SlotlockJoinRequest[]>;
  decide(params: {
    tenantRef: string;
    actor: string;
    id: string;
    decision: 'approve' | 'decline';
    role: SlotlockWorkspaceRole | null;
    memberCap: number | null;
  }): Promise<{ person: string | null; refusal: SlotlockDomainChangeRefusal | null }>;
  /** Members a domain let in: with the domain, and whether the team still holds it. */
  domainMembers(tenantRef: string): Promise<Map<string, { domain: string; status: string }>>;
  prune(): Promise<number>;
}

const refusalOf = (value: string | null | undefined): SlotlockDomainChangeRefusal | null =>
  value === null || value === undefined ? null : (value as SlotlockDomainChangeRefusal);

/**
 * The addresses as matched: lowercase, the domain in its ASCII form, the domain claimable at all
 * (a consumer address matches no team). At most ten.
 */
export function slotlockMatchableEmails(emails: readonly string[]): string[] {
  const matchable: string[] = [];
  for (const email of emails.slice(0, 10)) {
    const at = email.lastIndexOf('@');
    const domain = slotlockEmailDomain(email);
    if (at < 1 || domain === null) continue;
    matchable.push(`${email.slice(0, at).toLowerCase()}@${domain}`);
  }
  return matchable;
}

/** Through the functions of ddl-identity.ts. */
export function createSlotlockWorkspaceDomains(sql: SlotlockSql): SlotlockWorkspaceDomains {
  async function list(tenantRef: string): Promise<SlotlockWorkspaceDomain[]> {
    if (!TEAM.test(tenantRef)) return [];
    const rows = await sql<
      {
        domain_id: string;
        domain_ascii: string;
        domain_unicode: string;
        status: SlotlockWorkspaceDomain['status'];
        token: string;
        join_policy: SlotlockDomainJoinPolicy;
        created_at: Date;
        verified_at: Date | null;
        last_checked_at: Date | null;
        missing_since: Date | null;
        error_since: Date | null;
        lapse_after: Date | null;
        expired: boolean;
      }[]
    >`SELECT * FROM slotlock.workspace_domains_list(${tenantRef}::text)`;
    return rows.map((row) => ({
      id: row.domain_id,
      ascii: row.domain_ascii,
      unicode: row.domain_unicode,
      status: row.status,
      expired: row.expired,
      token: row.token,
      joinPolicy: row.join_policy,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      lastCheckedAt: row.last_checked_at,
      missingSince: row.missing_since,
      errorSince: row.error_since,
      lapseAfter: row.lapse_after,
    }));
  }

  async function apply(
    id: string,
    actor: string | null,
    token: string,
    check: SlotlockDomainCheck,
  ): Promise<SlotlockDomainCheckOutcome> {
    const [row] = await sql<{ outcome: string; team_ref: string | null; domain_name: string | null }[]>`
      SELECT outcome, team_ref, domain_name FROM slotlock.record_domain_check(
        ${id}::uuid, ${actor}::text, ${token}::text, ${check.primary}::text, ${check.secondary}::text,
        ${slotlockDomainToken()}::text)`;
    return { domainId: id, tenantRef: row?.team_ref ?? null, domain: row?.domain_name ?? null, outcome: row?.outcome ?? 'not_found', check };
  }

  return {
    async claim(tenantRef, actor, typed) {
      if (!TEAM.test(tenantRef) || !PERSON.test(actor)) return { refusal: 'not_found' };
      const domain = normalizeSlotlockDomain(typed);
      if ('refusal' in domain) return { refusal: domain.refusal };
      const [row] = await sql<{ claimed_id: string | null; refusal: string | null }[]>`
        SELECT claimed_id, refusal FROM slotlock.claim_domain(
          ${tenantRef}::text, ${actor}::text, ${domain.ascii}::text, ${domain.unicode}::text, ${slotlockDomainToken()}::text)`;
      if (row?.refusal) return { refusal: refusalOf(row.refusal) ?? 'not_allowed' };
      return row?.claimed_id ? { id: row.claimed_id } : { refusal: 'not_allowed' };
    },
    list,
    async verifyNow(tenantRef, actor, id, resolvers) {
      const none = { domainId: id, tenantRef: null, domain: null, check: null };
      if (!TEAM.test(tenantRef) || !PERSON.test(actor) || !UUID.test(id)) return { ...none, outcome: 'not_found' };
      const claim = (await list(tenantRef)).find((domain) => domain.id === id);
      if (!claim) return { ...none, outcome: 'not_found' };
      if (claim.expired) return { ...none, outcome: 'expired' };
      if (claim.lastCheckedAt !== null && Date.now() - claim.lastCheckedAt.getTime() < 60_000) return { ...none, outcome: 'too_soon' };
      return apply(id, actor, claim.token, await checkSlotlockDomain(resolvers, claim.ascii, claim.token));
    },
    async checkDue(resolvers, limit = 50, seen) {
      const due = await sql<{ domain_id: string; domain_ascii: string; token: string; missing_since: Date | null }[]>`
        SELECT domain_id, domain_ascii, token, missing_since FROM slotlock.domains_due(${limit}::integer)`;
      const outcomes: SlotlockDomainCheckOutcome[] = [];
      for (const claim of due) {
        seen?.(claim.domain_id, claim.missing_since);
        outcomes.push(await apply(claim.domain_id, null, claim.token, await checkSlotlockDomain(resolvers, claim.domain_ascii, claim.token)));
      }
      return outcomes;
    },
    async release(tenantRef, actor, id) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.release_domain(${tenantRef}::text, ${actor}::text, ${id}::uuid) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async restrictInvites(tenantRef, actor, on) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_invite_domain_restriction(${tenantRef}::text, ${actor}::text, ${on}::boolean) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async invitesRestricted(tenantRef) {
      if (!TEAM.test(tenantRef)) return false;
      const [state] = await sql<{ restricted: boolean }[]>`
        SELECT slotlock.workspace_invites_restricted(${tenantRef}::text) AS restricted`;
      return state?.restricted === true;
    },
    async setJoinPolicy(tenantRef, actor, id, policy) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_domain_join_policy(${tenantRef}::text, ${actor}::text, ${id}::uuid, ${policy}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async discoverable(person, emails) {
      const matchable = slotlockMatchableEmails(emails);
      if (!PERSON.test(person) || matchable.length === 0) return [];
      const rows = await sql<
        { team_ref: string; handle: string; name: string; domain: string; domain_key: string; join_policy: 'request' | 'auto'; requested: boolean }[]
      >`SELECT team_ref, handle, name, domain, domain_key, join_policy, requested
          FROM slotlock.discoverable_workspaces(${person}::text, ${matchable}::text[])`;
      return rows.map((row) => ({
        tenantRef: row.team_ref,
        handle: row.handle,
        name: row.name,
        domain: row.domain,
        domainKey: row.domain_key,
        joinPolicy: row.join_policy,
        requested: row.requested,
      }));
    },
    async requestToJoin(tenantRef, person, emails, memberCap) {
      const matchable = slotlockMatchableEmails(emails);
      if (!TEAM.test(tenantRef) || !PERSON.test(person) || matchable.length === 0) return { refusal: 'not_found' };
      const [row] = await sql<{ outcome: 'joined' | 'requested' | null; refusal: string | null }[]>`
        SELECT outcome, refusal FROM slotlock.request_to_join(
          ${tenantRef}::text, ${person}::text, ${matchable}::text[], ${memberCap}::integer)`;
      return row?.outcome ? { outcome: row.outcome } : { refusal: refusalOf(row?.refusal) ?? 'not_found' };
    },
    async requests(tenantRef) {
      if (!TEAM.test(tenantRef)) return [];
      const rows = await sql<
        { request_id: string; person_ref: string; display: string | null; email: string; domain: string; created_at: Date; expires_at: Date }[]
      >`SELECT * FROM slotlock.workspace_join_requests_list(${tenantRef}::text)`;
      return rows.map((row) => ({
        id: row.request_id,
        person: row.person_ref,
        display: row.display,
        email: row.email,
        domain: row.domain,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
    },
    async decide({ tenantRef, actor, id, decision, role, memberCap }) {
      if (!UUID.test(id)) return { person: null, refusal: 'not_found' };
      const [row] = await sql<{ refusal: string | null; joined_person: string | null }[]>`
        SELECT refusal, joined_person FROM slotlock.decide_join_request(
          ${tenantRef}::text, ${actor}::text, ${id}::uuid, ${decision}::text, ${role}::text, ${memberCap}::integer)`;
      return { person: row?.joined_person ?? null, refusal: refusalOf(row?.refusal) };
    },
    async domainMembers(tenantRef) {
      const found = new Map<string, { domain: string; status: string }>();
      if (!TEAM.test(tenantRef)) return found;
      const rows = await sql<{ person_ref: string; domain: string; domain_status: string }[]>`
        SELECT person_ref, domain, domain_status FROM slotlock.workspace_domain_members(${tenantRef}::text)`;
      for (const row of rows) found.set(row.person_ref, { domain: row.domain, status: row.domain_status });
      return found;
    },
    async prune() {
      const [row] = await sql<{ pruned: number }[]>`SELECT slotlock.prune_workspace_domains() AS pruned`;
      return Number(row?.pruned ?? 0);
    },
  };
}

/** The role a request may be approved as: Viewer, Member or Developer. */
export function slotlockJoinRole(value: string | null): SlotlockWorkspaceRole | null {
  return isSlotlockWorkspaceRole(value) && (value === 'viewer' || value === 'member' || value === 'developer') ? value : null;
}

/** The audit log's actions for a team's domains (its Identity group). */
export const SLOTLOCK_DOMAIN_AUDIT_ACTIONS = Object.freeze([
  'domain.claimed',
  'domain.verified',
  'domain.record_missing',
  'domain.lapsing',
  'domain.restored',
  'domain.lapsed',
  'domain.released',
  'domain.join_policy_changed',
  'workspace.invites_restricted',
  'workspace.invites_unrestricted',
] as const);

/** The action a check's outcome records, or null for one that changed nothing. */
const CHECK_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  verified: 'domain.verified',
  restored: 'domain.restored',
  lapsing: 'domain.lapsing',
  lapsed: 'domain.lapsed',
});

/**
 * The audit event a check that changed something records: which domain, and what each resolver said
 * (public DNS data). A domain gone for the first time is recorded once (`missing` while it had been
 * seen); repeats and checks that changed nothing are not.
 */
export function slotlockDomainCheckEvent(
  found: SlotlockDomainCheckOutcome,
  firstMissing: boolean,
): { action: string; targetType: 'domain'; targetRef: string; metadata: Record<string, unknown> } | null {
  const action = CHECK_ACTIONS[found.outcome] ?? (found.outcome === 'missing' && firstMissing ? 'domain.record_missing' : null);
  if (action === null || found.domain === null) return null;
  return {
    action,
    targetType: 'domain',
    targetRef: found.domainId,
    metadata: {
      domain: found.domain,
      resolvers: (found.check?.detail ?? []).map((asked) => ({
        resolver: asked.resolver,
        verdict: asked.verdict,
        ad: asked.ad,
        ttl: asked.ttl,
        values: asked.values,
        ...(asked.reason !== null ? { reason: asked.reason } : {}),
      })),
    },
  };
}

/**
 * The daily check, from the server's maintenance: the claims due looked up and applied, each change
 * recorded in its team's audit log as Slotlock's. How many were checked.
 */
export async function runSlotlockDomainChecks(params: {
  domains: SlotlockWorkspaceDomains;
  resolvers: readonly SlotlockDnsResolver[];
  record?: (tenantRef: string, event: SlotlockAuditEventInput) => Promise<void>;
  limit?: number;
}): Promise<number> {
  const before = new Map<string, Date | null>();
  const outcomes = await params.domains.checkDue(params.resolvers, params.limit ?? 50, (id, missingSince) => {
    before.set(id, missingSince);
  });
  for (const found of outcomes) {
    const event = slotlockDomainCheckEvent(found, before.get(found.domainId) === null);
    if (event === null || found.tenantRef === null || !params.record) continue;
    await params.record(found.tenantRef, { ...event, actorType: 'system', actorRef: 'slotlock' }).catch(() => undefined);
  }
  return outcomes.length;
}
