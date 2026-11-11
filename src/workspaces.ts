// Who belongs to which workspace, and as what (workspace-roles.ts), as the dashboard asks on every
// request: from slotlock.workspace_memberships and slotlock.dashboard_people, through their
// functions, never from the session cookie. A person's own workspace has no row: they are its
// Owner. GitHub organizations' members are recorded at each sign-in from what GitHub lists.
import { createHash } from 'node:crypto';
import type { SlotlockSql } from './store.js';
import { type SlotlockWorkspaceDomains, createSlotlockWorkspaceDomains } from './workspace-domains.js';
import { type SlotlockWorkspaceSso, createSlotlockWorkspaceSso } from './workspace-sso.js';
import { type SlotlockWorkspaceScim, createSlotlockWorkspaceScim } from './workspace-scim.js';
import { type SlotlockWorkspaceRole, isSlotlockWorkspaceRole } from './workspace-roles.js';
import { type SlotlockResourceScope, isSlotlockResourceScope } from './resource-profile.js';

/**
 * A person as the dashboard knows them: `github:<id>`, `google:<subject>`, or `sso:<uuid>` (one a
 * team's identity provider signed in, ddl-sso.ts), never an email.
 */
const PERSON = /^(github:[1-9]\d{0,19}|google:[A-Za-z0-9._-]{1,255}|sso:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
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
  /**
   * Why there is no role though the person is a member: the team requires single sign-on and this
   * session holds no recent proof (`sso_required`), or the session was signed in through another
   * team's provider alone (`sso_scope`). Null otherwise.
   */
  refusal?: 'sso_required' | 'sso_scope' | null;
  /** With sso_required: whether this person (an Owner who signs in with GitHub or Google) may bypass. */
  mayBypass?: boolean;
}

/** What the dashboard reads and records of people and their memberships. */
export interface SlotlockDashboardWorkspaces {
  /**
   * Record a sign-in, returning the epoch to seal into the session. Signing in with GitHub, pass
   * the organizations GitHub lists the person in: they become memberships (owners Owner, members
   * Developer), and one GitHub no longer lists ends.
   */
  signedIn(person: string, githubOrganizations?: readonly SlotlockGitHubMembership[]): Promise<number>;
  /**
   * The person's role in a tenant (its test environment is its live tenant's) and their epoch, for
   * this session (its id, as the cookie holds it, or null where there is none): a team that requires
   * single sign-on gives a session without a recent proof no role, and a session scoped to a team's
   * provider has none elsewhere. Required, so no caller with a session leaves its scope unchecked.
   */
  standing(tenantRef: string, person: string, sid: string | null): Promise<SlotlockWorkspaceStanding>;
  /**
   * The locations and groups the person is limited to in the tenant (RFC 0004 D1), or null for all
   * of it. An Owner is never limited.
   */
  scope?(tenantRef: string, person: string): Promise<SlotlockResourceScope | null>;
  /** End every session of the person: a new epoch is drawn, and those sealed under the old are refused. */
  signOutEverywhere(person: string): Promise<number>;
  /** Team workspaces, their members and invitations: only with the database (createSlotlockDashboardWorkspaces). */
  teams?: SlotlockWorkspaceTeams;
  /** Each session a person signed in with, to list and sign out one by one: only with the database. */
  sessions?: SlotlockDashboardSessions;
  /**
   * The tenant's suspension, as its dashboard tells it (RFC 0006): since when, and the message
   * staff left. Null while it is not suspended. Only with the database.
   */
  suspension?(tenantRef: string): Promise<SlotlockSuspensionNotice | null>;
  /** Teams' verified domains and requests to join through them (workspace-domains.ts): only with the database. */
  domains?: SlotlockWorkspaceDomains;
  /** Teams' single sign-on (workspace-sso.ts): only with the database. */
  sso?: SlotlockWorkspaceSso;
  /** Teams' SCIM provisioning (workspace-scim.ts): only with the database. */
  scim?: SlotlockWorkspaceScim;
}

/** A suspended workspace's notice: never the internal reason. */
export interface SlotlockSuspensionNotice {
  since: Date | null;
  message: string | null;
}

/** A session a person signed in with, as their Account page lists it. */
export interface SlotlockDashboardSession {
  /** The SHA-256 of the session's id, in hex: names it without revealing it. */
  id: string;
  startedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

/** Sessions by person (slotlock.dashboard_sessions): only a digest of each session's id is kept. */
export interface SlotlockDashboardSessions {
  started(person: string, sid: string, expiresAt: Date, from: { userAgent?: string; ipAddress?: string }): Promise<void>;
  /** Whether the session may go on: false once signed out from another device. Notes it seen. */
  seen(person: string, sid: string): Promise<boolean>;
  list(person: string): Promise<SlotlockDashboardSession[]>;
  /** Sign out one session by its id (SlotlockDashboardSession.id), or every one with null. */
  end(person: string, id: string | null): Promise<boolean>;
  /** The id a session is listed under. */
  idOf(sid: string): string;
}

/** A team workspace (team:<uuid>) as a person sees it in their list. */
export interface SlotlockTeamWorkspace {
  tenantRef: string;
  handle: string;
  name: string;
  role: SlotlockWorkspaceRole;
}

/** An active member of a workspace. */
export interface SlotlockWorkspaceMember {
  person: string;
  role: SlotlockWorkspaceRole;
  source: 'github_org' | 'invitation' | 'created';
  /** Their GitHub login or verified Google email as they last signed in; null before they have. */
  display: string | null;
  joinedAt: Date;
}

/** An invitation not accepted or revoked: pending, or expired in the last 30 days. */
export interface SlotlockWorkspaceInvitation {
  id: string;
  email: string | null;
  githubLogin: string | null;
  role: SlotlockWorkspaceRole;
  inviterDisplay: string;
  sentAt: Date;
  expiresAt: Date;
}

/** What the holder of an invitation's link sees before joining. */
export interface SlotlockInvitationPreview {
  id: string;
  tenantRef: string;
  workspaceName: string;
  workspaceHandle: string;
  inviterDisplay: string;
  role: SlotlockWorkspaceRole;
  email: string | null;
  githubRef: string | null;
  githubLogin: string | null;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** Why a team change was refused. */
export type SlotlockTeamRefusal =
  | 'invalid_handle'
  | 'invalid_name'
  | 'handle_taken'
  | 'team_limit'
  | 'not_found'
  | 'not_allowed'
  | 'already_member'
  | 'invitation_limit'
  /** The address was sent SLOTLOCK_INVITATIONS_PER_ADDRESS invitations in the last day. */
  | 'recipient_limit'
  | 'member_cap'
  | 'revoked'
  | 'accepted'
  | 'expired'
  | 'not_for_you'
  | 'last_owner'
  | 'sso_owner'
  | 'confirm'
  | 'subscription_live'
  | 'domain_restricted'
  /** An Owner reaches the whole workspace: never limited. */
  | 'owner';

/**
 * Team workspaces through their SECURITY DEFINER functions: each checks the actor's role and
 * ceiling, keeps an Owner, and serialises changes to one workspace's people.
 */
export interface SlotlockWorkspaceTeams {
  /** How the person is shown to others: their GitHub login or verified Google email. */
  setDisplay(person: string, display: string | null): Promise<void>;
  /** A new team workspace with the person its Owner; `cap` free team workspaces a person may create. */
  create(person: string, name: string, handle: string, cap: number | null): Promise<{ tenantRef: string } | { refusal: SlotlockTeamRefusal }>;
  info(tenantRef: string): Promise<{ handle: string; name: string } | null>;
  /** The team workspaces the person is an active member of. */
  workspacesOf(person: string): Promise<SlotlockTeamWorkspace[]>;
  members(tenantRef: string): Promise<SlotlockWorkspaceMember[]>;
  invitations(tenantRef: string): Promise<SlotlockWorkspaceInvitation[]>;
  invite(params: {
    tenantRef: string;
    inviter: string;
    to: { email: string } | { github: string; login: string };
    role: SlotlockWorkspaceRole;
    /** SHA-256 of the token; the token itself is never given. */
    tokenSha256: Buffer;
    days: number;
    dailyLimit: number | null;
    memberCap: number | null;
  }): Promise<{ id: string } | { refusal: SlotlockTeamRefusal }>;
  preview(tokenSha256: Buffer): Promise<SlotlockInvitationPreview | null>;
  /** Accept by the token's digest or, one found for the person, by id. `emails` are those the person holds verified. */
  accept(params: {
    tokenSha256?: Buffer;
    id?: string;
    person: string;
    emails: readonly string[];
    memberCap: number | null;
  }): Promise<{ tenantRef: string } | { refusal: SlotlockTeamRefusal }>;
  revoke(tenantRef: string, actor: string, id: string): Promise<boolean>;
  /** Send again with a new token (the old stops working), held to the limits a new one is. */
  resend(
    tenantRef: string,
    actor: string,
    id: string,
    tokenSha256: Buffer,
    days: number,
    dailyLimit: number | null,
    memberCap: number | null,
  ): Promise<SlotlockTeamRefusal | null>;
  changeRole(tenantRef: string, actor: string, person: string, role: SlotlockWorkspaceRole): Promise<SlotlockTeamRefusal | null>;
  /**
   * Limit a member to locations and groups, or give them the whole workspace again (null): by an
   * Owner or Admin not limited themselves, of a member not an Owner (`owner`) whose role they may
   * grant.
   */
  setScope(tenantRef: string, actor: string, person: string, scope: SlotlockResourceScope | null): Promise<SlotlockTeamRefusal | null>;
  /** Each member limited to part of the workspace, by person, with what they are limited to. */
  scopes(tenantRef: string): Promise<ReadonlyMap<string, SlotlockResourceScope>>;
  /** Remove a member; the actor removing themselves leaves. */
  remove(tenantRef: string, actor: string, person: string): Promise<SlotlockTeamRefusal | null>;
  /** Pending invitations meant for the person (their GitHub account, or an email they hold verified). */
  pendingFor(person: string, emails: readonly string[]): Promise<
    { id: string; tenantRef: string; workspaceName: string; workspaceHandle: string; inviterDisplay: string; role: SlotlockWorkspaceRole }[]
  >;
  /** Whether a team workspace exists and serves its keys. */
  isActive(tenantRef: string): Promise<boolean>;
  /** Delete invitations finished more than 30 days ago; how many went. */
  prune(): Promise<number>;
  /** Delete the team in seven days, by an Owner who typed its handle; its keys stop at once. */
  scheduleDeletion(tenantRef: string, actor: string, handle: string): Promise<SlotlockTeamRefusal | null>;
  /** Keep a team being deleted, by any of its Owners. */
  cancelDeletion(tenantRef: string, actor: string): Promise<SlotlockTeamRefusal | null>;
  /** When a team being deleted goes, or null. */
  deleteAfter(tenantRef: string): Promise<Date | null>;
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
    async scope(tenantRef, person) {
      if (!PERSON.test(person)) return null;
      const [row] = await sql<{ scope: unknown }[]>`
        SELECT slotlock.member_scope(${tenantRef}::text, ${person}::text) AS scope`;
      return scopeOf(row?.scope);
    },
    async standing(tenantRef, person, sid) {
      if (!PERSON.test(person)) return { role: null, sessionEpoch: null };
      const digest = sid === null ? null : sessionDigest(sid);
      const [row] = await sql<{ role: string | null; session_epoch: number | null; refusal: string | null; may_bypass: boolean }[]>`
        SELECT role, session_epoch, refusal, may_bypass
          FROM slotlock.dashboard_standing(${tenantRef}::text, ${person}::text, ${digest}::bytea)`;
      const role = row?.role ?? null;
      const epoch = row?.session_epoch;
      const refusal = row?.refusal === 'sso_required' || row?.refusal === 'sso_scope' ? row.refusal : null;
      return {
        role: isSlotlockWorkspaceRole(role) ? role : null,
        sessionEpoch: epoch === null || epoch === undefined ? null : Number(epoch),
        refusal,
        mayBypass: row?.may_bypass === true,
      };
    },
    async signOutEverywhere(person) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      const [row] = await sql<{ epoch: number }[]>`
        SELECT slotlock.dashboard_sign_out_everywhere(${person}::text) AS epoch`;
      return Number(row?.epoch ?? 0);
    },
    teams: createTeams(sql),
    sessions: createSessions(sql),
    async suspension(tenantRef) {
      try {
        const [row] = await sql<{ suspended_at: Date | null; message: string | null }[]>`
          SELECT suspended_at, message FROM slotlock.tenant_suspension_notice(${tenantRef}::text)`;
        return row ? { since: row.suspended_at, message: row.message } : null;
      } catch (error) {
        // A schema or grants from before this release: no notice, as before; the store still
        // refuses a suspended tenant's writes.
        const code = (error as { code?: unknown } | null)?.code;
        if (code === '42883' || code === '42501') return null;
        throw error;
      }
    },
    domains: createSlotlockWorkspaceDomains(sql),
    sso: createSlotlockWorkspaceSso(sql),
    scim: createSlotlockWorkspaceScim(sql),
  };
}

const sessionDigest = (sid: string) => createHash('sha256').update(sid, 'utf8').digest();
const SESSION_ID = /^[0-9a-f]{64}$/;

function createSessions(sql: SlotlockSql): SlotlockDashboardSessions {
  return {
    async started(person, sid, expiresAt, from) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      await sql`SELECT slotlock.dashboard_session_started(${person}::text, ${sessionDigest(sid)}::bytea,
        ${expiresAt}::timestamptz, ${from.userAgent?.slice(0, 256) ?? null}::text, ${from.ipAddress?.slice(0, 64) ?? null}::text)`;
    },
    async seen(person, sid) {
      if (!PERSON.test(person)) return false;
      const [row] = await sql<{ alive: boolean }[]>`
        SELECT slotlock.dashboard_session_seen(${person}::text, ${sessionDigest(sid)}::bytea) AS alive`;
      return row?.alive === true;
    },
    async list(person) {
      if (!PERSON.test(person)) return [];
      const rows = await sql<
        { sid_sha256: Buffer; started_at: Date; last_seen_at: Date; expires_at: Date; user_agent: string | null; ip_address: string | null }[]
      >`SELECT * FROM slotlock.dashboard_sessions_of(${person}::text)`;
      return rows.map((row) => ({
        id: row.sid_sha256.toString('hex'),
        startedAt: row.started_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
      }));
    },
    async end(person, id) {
      if (!PERSON.test(person) || (id !== null && !SESSION_ID.test(id))) return false;
      const [row] = await sql<{ ended: boolean }[]>`
        SELECT slotlock.dashboard_session_end(${person}::text, ${id === null ? null : Buffer.from(id, 'hex')}::bytea) AS ended`;
      return row?.ended === true;
    },
    idOf: (sid) => sessionDigest(sid).toString('hex'),
  };
}

const TEAM = /^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A member's scope as kept, or null for none. One that is not a scope never reads as none: that
 * would give the whole workspace to someone limited, so it is refused (the database's check keeps
 * such a value out).
 */
function scopeOf(value: unknown): SlotlockResourceScope | null {
  if (value === null || value === undefined) return null;
  if (!isSlotlockResourceScope(value)) throw new Error('Slotlock read a member scope that is not one');
  return value;
}

const refusalOf = (value: string | null | undefined): SlotlockTeamRefusal | null =>
  value === null || value === undefined ? null : (value as SlotlockTeamRefusal);
const roleOf = (value: string): SlotlockWorkspaceRole => {
  if (!isSlotlockWorkspaceRole(value)) throw new Error(`Slotlock workspaces: unknown role ${value}`);
  return value;
};
const digest = (token: Buffer) => {
  if (token.length !== 32) refuse('a token digest is 32 bytes');
  return token;
};

function createTeams(sql: SlotlockSql): SlotlockWorkspaceTeams {
  return {
    async setDisplay(person, display) {
      if (!PERSON.test(person)) return;
      const shown = display === null ? null : display.slice(0, 254);
      await sql`SELECT slotlock.dashboard_display(${person}::text, ${shown}::text)`;
    },
    async create(person, name, handle, cap) {
      if (!PERSON.test(person)) refuse('needs github:<id> or google:<subject>');
      const [row] = await sql<{ tenant_ref: string | null; refusal: string | null }[]>`
        SELECT tenant_ref, refusal FROM slotlock.create_team(${person}::text, ${name}::text, ${handle}::text, ${cap}::integer)`;
      return row?.tenant_ref ? { tenantRef: row.tenant_ref } : { refusal: refusalOf(row?.refusal) ?? 'not_allowed' };
    },
    async info(tenantRef) {
      const [row] = await sql<{ handle: string; name: string }[]>`
        SELECT handle, name FROM slotlock.workspace_info(${tenantRef}::text)`;
      return row ? { handle: row.handle, name: row.name } : null;
    },
    async workspacesOf(person) {
      if (!PERSON.test(person)) return [];
      const rows = await sql<{ tenant_ref: string; handle: string; name: string; role: string }[]>`
        SELECT tenant_ref, handle, name, role FROM slotlock.person_workspaces(${person}::text)`;
      return rows.map((row) => ({ tenantRef: row.tenant_ref, handle: row.handle, name: row.name, role: roleOf(row.role) }));
    },
    async members(tenantRef) {
      if (!TEAM.test(tenantRef.replace(/~test$/, ''))) return [];
      const rows = await sql<{ person_ref: string; role: string; source: SlotlockWorkspaceMember['source']; display: string | null; joined_at: Date }[]>`
        SELECT person_ref, role, source, display, joined_at FROM slotlock.workspace_members(${tenantRef}::text)`;
      return rows.map((row) => ({ person: row.person_ref, role: roleOf(row.role), source: row.source, display: row.display, joinedAt: row.joined_at }));
    },
    async invitations(tenantRef) {
      if (!TEAM.test(tenantRef.replace(/~test$/, ''))) return [];
      const rows = await sql<
        { id: string; email: string | null; github_login: string | null; role: string; inviter_display: string; sent_at: Date; expires_at: Date }[]
      >`SELECT id, email, github_login, role, inviter_display, sent_at, expires_at
          FROM slotlock.workspace_invitations_list(${tenantRef}::text)`;
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        githubLogin: row.github_login,
        role: roleOf(row.role),
        inviterDisplay: row.inviter_display,
        sentAt: row.sent_at,
        expiresAt: row.expires_at,
      }));
    },
    async invite(params) {
      if (!TEAM.test(params.tenantRef) || !PERSON.test(params.inviter)) refuse('needs a team workspace and the inviter');
      const email = 'email' in params.to ? params.to.email : null;
      const github = 'github' in params.to ? params.to.github : null;
      const login = 'github' in params.to ? params.to.login : null;
      const [row] = await sql<{ invitation_id: string | null; refusal: string | null }[]>`
        SELECT invitation_id, refusal FROM slotlock.invite_member(
          ${params.tenantRef}::text, ${params.inviter}::text, ${email}::text, ${github}::text, ${login}::text,
          ${params.role}::text, ${digest(params.tokenSha256)}::bytea, ${params.days}::integer,
          ${params.dailyLimit}::integer, ${params.memberCap}::integer)`;
      return row?.invitation_id ? { id: row.invitation_id } : { refusal: refusalOf(row?.refusal) ?? 'not_allowed' };
    },
    async preview(tokenSha256) {
      const [row] = await sql<
        {
          invitation_id: string;
          tenant_ref: string;
          workspace_name: string;
          workspace_handle: string;
          inviter_display: string;
          role: string;
          email: string | null;
          github_ref: string | null;
          github_login: string | null;
          state: SlotlockInvitationPreview['state'];
        }[]
      >`SELECT * FROM slotlock.invitation_preview(${digest(tokenSha256)}::bytea)`;
      if (!row) return null;
      return {
        id: row.invitation_id,
        tenantRef: row.tenant_ref,
        workspaceName: row.workspace_name,
        workspaceHandle: row.workspace_handle,
        inviterDisplay: row.inviter_display,
        role: roleOf(row.role),
        email: row.email,
        githubRef: row.github_ref,
        githubLogin: row.github_login,
        state: row.state,
      };
    },
    async accept(params) {
      if (!PERSON.test(params.person)) refuse('needs github:<id> or google:<subject>');
      if ((params.tokenSha256 === undefined) === (params.id === undefined)) refuse('accept by the token or by id');
      if (params.id !== undefined && !UUID.test(params.id)) return { refusal: 'not_found' };
      const token = params.tokenSha256 === undefined ? null : digest(params.tokenSha256);
      const [row] = await sql<{ tenant_ref: string | null; refusal: string | null }[]>`
        SELECT tenant_ref, refusal FROM slotlock.accept_invitation(
          ${token}::bytea, ${params.id ?? null}::uuid, ${params.person}::text,
          ${[...params.emails].slice(0, 20)}::text[], ${params.memberCap}::integer)`;
      return row?.tenant_ref ? { tenantRef: row.tenant_ref } : { refusal: refusalOf(row?.refusal) ?? 'not_found' };
    },
    async revoke(tenantRef, actor, id) {
      if (!UUID.test(id)) return false;
      const [row] = await sql<{ revoked: boolean }[]>`
        SELECT slotlock.revoke_invitation(${tenantRef}::text, ${actor}::text, ${id}::uuid) AS revoked`;
      return row?.revoked === true;
    },
    async resend(tenantRef, actor, id, tokenSha256, days, dailyLimit, memberCap) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.resend_invitation(${tenantRef}::text, ${actor}::text, ${id}::uuid,
          ${digest(tokenSha256)}::bytea, ${days}::integer, ${dailyLimit}::integer, ${memberCap}::integer) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async changeRole(tenantRef, actor, person, role) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.change_member_role(${tenantRef}::text, ${actor}::text, ${person}::text, ${role}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async scopes(tenantRef) {
      if (!TEAM.test(tenantRef.replace(/~test$/, ''))) return new Map();
      const rows = await sql<{ person_ref: string; resource_scope: unknown }[]>`
        SELECT person_ref, resource_scope FROM slotlock.member_scopes(${tenantRef}::text)`;
      return new Map(rows.map((row) => [row.person_ref, scopeOf(row.resource_scope) as SlotlockResourceScope] as const));
    },
    async setScope(tenantRef, actor, person, scope) {
      if (scope !== null && !isSlotlockResourceScope(scope)) refuse('a scope names locations or groups');
      const kept = scope === null ? null : { locations: [...scope.locations], groups: [...scope.groups] };
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_member_scope(${tenantRef}::text, ${actor}::text, ${person}::text,
          ${kept === null ? null : sql.json(kept as never)}::jsonb) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async remove(tenantRef, actor, person) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.remove_member(${tenantRef}::text, ${actor}::text, ${person}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async pendingFor(person, emails) {
      if (!PERSON.test(person)) return [];
      const rows = await sql<
        { invitation_id: string; tenant_ref: string; workspace_name: string; workspace_handle: string; inviter_display: string; role: string }[]
      >`SELECT * FROM slotlock.pending_invitations_for(${person}::text, ${[...emails].slice(0, 20)}::text[])`;
      return rows.map((row) => ({
        id: row.invitation_id,
        tenantRef: row.tenant_ref,
        workspaceName: row.workspace_name,
        workspaceHandle: row.workspace_handle,
        inviterDisplay: row.inviter_display,
        role: roleOf(row.role),
      }));
    },
    async isActive(tenantRef) {
      if (!TEAM.test(tenantRef.replace(/~test$/, ''))) return false;
      const [row] = await sql<{ active: boolean }[]>`SELECT slotlock.workspace_active(${tenantRef}::text) AS active`;
      return row?.active === true;
    },
    async prune() {
      const [row] = await sql<{ pruned: number }[]>`SELECT slotlock.prune_workspace_invitations() AS pruned`;
      return Number(row?.pruned ?? 0);
    },
    async scheduleDeletion(tenantRef, actor, handle) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.schedule_team_deletion(${tenantRef}::text, ${actor}::text, ${handle}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async cancelDeletion(tenantRef, actor) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.cancel_team_deletion(${tenantRef}::text, ${actor}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async deleteAfter(tenantRef) {
      if (!TEAM.test(tenantRef.replace(/~test$/, ''))) return null;
      const [row] = await sql<{ after: Date | null }[]>`SELECT slotlock.workspace_delete_after(${tenantRef}::text) AS after`;
      return row?.after ?? null;
    },
  };
}

/**
 * Whether a team workspace serves its keys, for `serve`: read through slotlock.workspace_active and
 * kept for `ttlMs` (30 seconds), so deleting one stops its keys on every server within that.
 */
export function createSlotlockWorkspaceCheck(
  sql: SlotlockSql,
  options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
): (tenantRef: string) => Promise<boolean> {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const known = new Map<string, { at: number; active: Promise<boolean> }>();
  const teams = createTeams(sql);
  return (tenantRef) => {
    const live = tenantRef.replace(/~test$/, '');
    if (!TEAM.test(live)) return Promise.resolve(false);
    const cached = known.get(live);
    if (cached && now() - cached.at < ttlMs) return cached.active;
    const active = teams.isActive(live).then(
      (found) => found,
      (error: unknown) => {
        known.delete(live);
        throw error;
      },
    );
    known.delete(live);
    known.set(live, { at: now(), active });
    if (known.size > maxEntries) known.delete(known.keys().next().value as string);
    return active;
  };
}

/**
 * The same in memory, for tests and for a library deployment with a single server. `setRole` and
 * `remove` stand in for what the Members page will do.
 */
export function createSlotlockMemoryDashboardWorkspaces(): SlotlockDashboardWorkspaces & {
  setRole(tenantRef: string, person: string, role: SlotlockWorkspaceRole, source?: 'github_org' | 'invitation' | 'created'): void;
  remove(tenantRef: string, person: string): void;
  /** Limit a member to locations and groups, or (null) give them all of the workspace again. */
  limit(tenantRef: string, person: string, scope: SlotlockResourceScope | null): void;
} {
  const live = (tenantRef: string) => tenantRef.replace(/~test$/, '');
  const memberships = new Map<string, { role: SlotlockWorkspaceRole; source: string; active: boolean; scope?: SlotlockResourceScope }>();
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
    async scope(tenantRef, person) {
      const found = memberships.get(key(tenantRef, person));
      return found?.active && found.role !== 'owner' ? (found.scope ?? null) : null;
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
    limit(tenantRef, person, scope) {
      const found = memberships.get(key(tenantRef, person));
      if (!found) throw new Error('Slotlock limits only a member');
      if (scope === null) delete found.scope;
      else found.scope = { locations: [...scope.locations], groups: [...scope.groups] };
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
