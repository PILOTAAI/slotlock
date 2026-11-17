// A team's directory (SCIM 2.0) as the dashboard and its SCIM endpoint reach it (teams phase
// 5.6–5.7): through the SECURITY DEFINER functions of ddl-scim.ts. Tokens are made here and shown
// once; only their SHA-256 reaches the database.
import { createHash, randomBytes } from 'node:crypto';
import type { SlotlockScimGroupAttributes, SlotlockScimUserAttributes } from './scim.js';
import type { SlotlockSql } from './store.js';

const TEAM = /^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A SCIM token: `slk_scim_` and 256 random bits in hex. */
export const SLOTLOCK_SCIM_TOKEN = /^slk_scim_[0-9a-f]{64}$/;

export type SlotlockScimRefusal =
  | 'not_found'
  | 'not_allowed'
  | 'not_enabled'
  | 'no_verified_domain'
  | 'key_policy'
  | 'token_limit'
  | 'bad_token'
  | 'wrong_workspace'
  | 'domain_not_verified'
  | 'uniqueness'
  | 'owner_protected'
  | 'invalid_member'
  | 'owner_not_mappable'
  | 'role_not_allowed';

/** A directory user as kept, with its id and times. */
export interface SlotlockScimUser extends SlotlockScimUserAttributes {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlotlockScimGroup extends SlotlockScimGroupAttributes {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  /** The role an Owner mapped the group to (reserved names map themselves), or null. Not part of SCIM. */
  role: string | null;
}

/** A filter as the endpoint passes it: one attribute (username, externalid, id, email / displayname). */
export type SlotlockScimLookup = { attribute: string; value: string } | null;

export interface SlotlockWorkspaceScim {
  enable(tenantRef: string, actor: string, keyPolicy: 'keep' | 'revoke'): Promise<SlotlockScimRefusal | null>;
  disable(tenantRef: string, actor: string): Promise<SlotlockScimRefusal | null>;
  /** A new token, shown once: the raw value, or why not. */
  createToken(tenantRef: string, actor: string): Promise<{ token: string; prefix: string } | { refusal: SlotlockScimRefusal }>;
  revokeToken(tenantRef: string, actor: string, id: string): Promise<SlotlockScimRefusal | null>;
  state(tenantRef: string): Promise<{
    enabled: boolean;
    keyPolicy: 'keep' | 'revoke' | null;
    tokens: { id: string; prefix: string; createdAt: Date; lastUsedAt: Date | null }[];
  }>;
  /** A request's token, for the team its address names. */
  authenticate(token: string, teamId: string): Promise<{ tenantRef: string; prefix: string; keyPolicy: 'keep' | 'revoke' } | { refusal: 'bad_token' | 'wrong_workspace'; tenantRef?: string; prefix?: string }>;
  putUser(tenantRef: string, id: string | null, newId: string, user: SlotlockScimUserAttributes): Promise<
    { id: string; membership: 'none' | 'deactivated' | 'activated'; person: string | null } | { refusal: SlotlockScimRefusal; person?: string | null }
  >;
  users(tenantRef: string, lookup: SlotlockScimLookup, startIndex: number, count: number, id?: string): Promise<{ users: SlotlockScimUser[]; total: number }>;
  deleteUser(tenantRef: string, id: string): Promise<{ refusal: SlotlockScimRefusal | null; person: string | null }>;
  putGroup(tenantRef: string, id: string | null, newId: string, group: SlotlockScimGroupAttributes): Promise<{ id: string } | { refusal: SlotlockScimRefusal }>;
  groups(tenantRef: string, lookup: SlotlockScimLookup, startIndex: number, count: number, id?: string): Promise<{ groups: SlotlockScimGroup[]; total: number }>;
  deleteGroup(tenantRef: string, id: string): Promise<SlotlockScimRefusal | null>;
  mapGroup(tenantRef: string, actor: string, id: string, role: string | null): Promise<SlotlockScimRefusal | null>;
  /**
   * A sign-in holding addresses the domain vouches for: the directory users at them bind to the
   * person. `freeCap` is the member cap of a team on the free plan, where plans apply, else null.
   */
  bind(person: string, emails: readonly string[], freeCap?: number | null): Promise<string[]>;
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const refusalOf = (value: string | null | undefined): SlotlockScimRefusal | null =>
  value === null || value === undefined ? null : (value as SlotlockScimRefusal);

/** Through the functions of ddl-scim.ts. */
export function createSlotlockWorkspaceScim(sql: SlotlockSql): SlotlockWorkspaceScim {
  return {
    async enable(tenantRef, actor, keyPolicy) {
      const [row] = await sql<{ refusal: string | null }[]>`SELECT slotlock.enable_scim(${tenantRef}::text, ${actor}::text, ${keyPolicy}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async disable(tenantRef, actor) {
      const [row] = await sql<{ refusal: string | null }[]>`SELECT slotlock.disable_scim(${tenantRef}::text, ${actor}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async createToken(tenantRef, actor) {
      const token = `slk_scim_${randomBytes(32).toString('hex')}`;
      const prefix = token.slice(0, 'slk_scim_'.length + 4);
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.create_scim_token(${tenantRef}::text, ${actor}::text, ${digest(token)}::bytea, ${prefix}::text) AS refusal`;
      return row?.refusal ? { refusal: refusalOf(row.refusal) ?? 'not_allowed' } : { token, prefix };
    },
    async revokeToken(tenantRef, actor, id) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`SELECT slotlock.revoke_scim_token(${tenantRef}::text, ${actor}::text, ${id}::uuid) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async state(tenantRef) {
      const rows = await sql<{ enabled: boolean; key_policy: 'keep' | 'revoke' | null; token_id: string | null; prefix: string | null; created_at: Date | null; last_used_at: Date | null }[]>`
        SELECT * FROM slotlock.scim_state(${tenantRef}::text)`;
      return {
        enabled: rows[0]?.enabled === true,
        keyPolicy: rows[0]?.key_policy ?? null,
        tokens: rows.flatMap((row) =>
          row.token_id && row.prefix && row.created_at ? [{ id: row.token_id, prefix: row.prefix, createdAt: row.created_at, lastUsedAt: row.last_used_at }] : [],
        ),
      };
    },
    async authenticate(token, teamId) {
      if (!SLOTLOCK_SCIM_TOKEN.test(token) || !UUID.test(teamId)) return { refusal: 'bad_token' };
      const [row] = await sql<{ team_ref: string | null; token_prefix: string | null; key_policy: 'keep' | 'revoke' | null; refusal: string | null }[]>`
        SELECT * FROM slotlock.scim_authenticate(${digest(token)}::bytea, ${`team:${teamId.toLowerCase()}`}::text)`;
      if (!row || row.refusal === 'bad_token' || (row.refusal === null && (!row.team_ref || !row.key_policy))) return { refusal: 'bad_token' };
      if (row.refusal === 'wrong_workspace') {
        return { refusal: 'wrong_workspace', ...(row.team_ref ? { tenantRef: row.team_ref } : {}), ...(row.token_prefix ? { prefix: row.token_prefix } : {}) };
      }
      return { tenantRef: row.team_ref as string, prefix: row.token_prefix as string, keyPolicy: row.key_policy as 'keep' | 'revoke' };
    },
    async putUser(tenantRef, id, newId, user) {
      if (!TEAM.test(tenantRef) || (id !== null && !UUID.test(id)) || !UUID.test(newId)) return { refusal: 'not_found' };
      const [row] = await sql<{ user_id: string | null; refusal: string | null; membership: string | null; person: string | null }[]>`
        SELECT * FROM slotlock.scim_put_user(${tenantRef}::text, ${id}::uuid, ${newId}::uuid, ${user.userName}::text,
          ${user.externalId}::text, ${user.active}::boolean, ${user.givenName}::text, ${user.familyName}::text,
          ${user.displayName}::text, ${user.workEmail}::text)`;
      if (!row || row.refusal) return { refusal: refusalOf(row?.refusal) ?? 'not_found', person: row?.person ?? null };
      return {
        id: row.user_id as string,
        membership: row.membership === 'deactivated' || row.membership === 'activated' ? row.membership : 'none',
        person: row.person,
      };
    },
    async users(tenantRef, lookup, startIndex, count, id) {
      if (!TEAM.test(tenantRef) || (id !== undefined && !UUID.test(id))) return { users: [], total: 0 };
      const rows = await sql<
        {
          user_id: string;
          user_name: string;
          external_id: string | null;
          active: boolean;
          given_name: string | null;
          family_name: string | null;
          display_name: string | null;
          work_email: string | null;
          created_at: Date;
          updated_at: Date;
          total: number;
        }[]
      >`SELECT * FROM slotlock.scim_users_list(${tenantRef}::text, ${lookup?.attribute ?? null}::text, ${lookup?.value ?? null}::text,
          ${startIndex}::integer, ${count}::integer, ${id ?? null}::uuid)`;
      // A page past the end (or count=0) has no rows to carry the total: one row from the start does.
      const total =
        rows[0]?.total ??
        (startIndex > 1 || count === 0
          ? ((
              await sql<{ total: number }[]>`SELECT total FROM slotlock.scim_users_list(${tenantRef}::text, ${lookup?.attribute ?? null}::text,
                ${lookup?.value ?? null}::text, 1, 1, ${id ?? null}::uuid)`
            )[0]?.total ?? 0)
          : 0);
      return {
        total: Number(total),
        users: rows.map((row) => ({
          id: row.user_id,
          userName: row.user_name,
          externalId: row.external_id,
          active: row.active,
          givenName: row.given_name,
          familyName: row.family_name,
          displayName: row.display_name,
          workEmail: row.work_email,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      };
    },
    async deleteUser(tenantRef, id) {
      if (!UUID.test(id)) return { refusal: 'not_found', person: null };
      const [row] = await sql<{ refusal: string | null; person: string | null }[]>`SELECT * FROM slotlock.scim_delete_user(${tenantRef}::text, ${id}::uuid)`;
      return { refusal: refusalOf(row?.refusal), person: row?.person ?? null };
    },
    async putGroup(tenantRef, id, newId, group) {
      if (!TEAM.test(tenantRef) || (id !== null && !UUID.test(id)) || !UUID.test(newId)) return { refusal: 'not_found' };
      if (!group.members.every((member) => UUID.test(member))) return { refusal: 'invalid_member' };
      const [row] = await sql<{ group_id: string | null; refusal: string | null }[]>`
        SELECT * FROM slotlock.scim_put_group(${tenantRef}::text, ${id}::uuid, ${newId}::uuid, ${group.displayName}::text,
          ${group.externalId}::text, ${group.members}::uuid[])`;
      return row?.group_id && !row.refusal ? { id: row.group_id } : { refusal: refusalOf(row?.refusal) ?? 'not_found' };
    },
    async groups(tenantRef, lookup, startIndex, count, id) {
      if (!TEAM.test(tenantRef) || (id !== undefined && !UUID.test(id))) return { groups: [], total: 0 };
      const rows = await sql<
        { group_id: string; display_name: string; external_id: string | null; members: string[]; created_at: Date; updated_at: Date; total: number; mapped_role: string | null }[]
      >`SELECT * FROM slotlock.scim_groups_list(${tenantRef}::text, ${lookup?.attribute ?? null}::text, ${lookup?.value ?? null}::text,
          ${startIndex}::integer, ${count}::integer, ${id ?? null}::uuid)`;
      const total =
        rows[0]?.total ??
        (startIndex > 1 || count === 0
          ? ((
              await sql<{ total: number }[]>`SELECT total FROM slotlock.scim_groups_list(${tenantRef}::text, ${lookup?.attribute ?? null}::text,
                ${lookup?.value ?? null}::text, 1, 1, ${id ?? null}::uuid)`
            )[0]?.total ?? 0)
          : 0);
      return {
        total: Number(total),
        groups: rows.map((row) => ({
          id: row.group_id,
          displayName: row.display_name,
          externalId: row.external_id,
          members: row.members,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          role: row.mapped_role,
        })),
      };
    },
    async deleteGroup(tenantRef, id) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`SELECT slotlock.scim_delete_group(${tenantRef}::text, ${id}::uuid) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async mapGroup(tenantRef, actor, id, role) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.map_scim_group_role(${tenantRef}::text, ${actor}::text, ${id}::uuid, ${role}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async bind(person, emails, freeCap) {
      if (emails.length === 0) return [];
      const rows = await sql<{ team_ref: string }[]>`SELECT team_ref FROM slotlock.scim_bind(${person}::text, ${[...emails].slice(0, 10)}::text[], ${freeCap ?? null}::integer)`;
      return rows.map((row) => row.team_ref);
    },
  };
}
