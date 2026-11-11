// A team's single sign-on as the dashboard reaches it (teams phase 5.3–5.5): through the SECURITY
// DEFINER functions of ddl-sso.ts, which check the actor's role, lock the team and decide whom a
// provider's sign-in is. Tokens are checked before (oidc.ts); secrets are sealed before (oidc.ts
// createSlotlockSecretBox), so only a sealed secret ever reaches the database.
import { createHash } from 'node:crypto';
import type { SlotlockOidcAlgorithm } from './oidc.js';
import type { SlotlockSql } from './store.js';
import { type SlotlockWorkspaceRole, isSlotlockWorkspaceRole } from './workspace-roles.js';

const TEAM = /^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The providers a team may connect: their own rules apply (oidc.ts, dashboard). */
export type SlotlockSsoKind = 'okta' | 'entra' | 'google_workspace' | 'oidc';

/** Why a change to a team's single sign-on, or a sign-in through it, was refused. */
export type SlotlockSsoRefusal =
  | 'not_found'
  | 'not_allowed'
  | 'no_verified_domain'
  | 'secret_required'
  | 'conflict'
  | 'stale_config'
  | 'untested'
  | 'no_breakglass_owner'
  | 'role_not_allowed'
  | 'owner_not_mappable'
  | 'invalid_value'
  | 'mapping_limit'
  | 'connection_inactive'
  | 'guest_refused'
  | 'not_member'
  | 'identity_taken'
  | 'identity_untrusted'
  | 'hd_mismatch'
  | 'member_cap'
  | 'invalid_max_age'
  | 'no_active_connection'
  | 'stale_sso_proof';

/** A team's connection, as saved. */
export interface SlotlockSsoConnection {
  id: string;
  kind: SlotlockSsoKind;
  status: 'draft' | 'tested' | 'active' | 'disabled';
  issuer: string;
  clientId: string;
  /** The client secret as sealed (null for Google Workspace, which uses Slotlock's own client). */
  secretSealed: string | null;
  secretLast4: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  algorithms: SlotlockOidcAlgorithm[];
  issParameter: boolean;
  entraTenant: string | null;
  groupsClaim: string;
  jitEnabled: boolean;
  defaultRole: 'viewer' | 'member' | 'developer';
  configVersion: number;
  testedVersion: number | null;
  lastTestedAt: Date | null;
  lastTestClaims: Record<string, unknown> | null;
  requireSso: boolean;
  maxAgeHours: number;
}

/** A connection as its callback reads it: with its team. */
export interface SlotlockSsoConnectionForSignIn {
  id: string;
  tenantRef: string;
  handle: string;
  name: string;
  kind: SlotlockSsoKind;
  status: SlotlockSsoConnection['status'];
  issuer: string;
  clientId: string;
  secretSealed: string | null;
  tokenEndpoint: string;
  jwksUri: string;
  algorithms: SlotlockOidcAlgorithm[];
  issParameter: boolean;
  entraTenant: string | null;
  groupsClaim: string;
  configVersion: number;
}

/** What a sign-in through a team's provider gave: who, and what happened. */
export interface SlotlockSsoSignIn {
  person: string | null;
  /** `joined`, `signed_in`, `role_changed` (alone); `linked`, `proof` (signed in already). */
  outcome: 'joined' | 'signed_in' | 'role_changed' | 'linked' | 'proof' | null;
  refusal: SlotlockSsoRefusal | null;
  role: SlotlockWorkspaceRole | null;
}

const sessionDigest = (sid: string) => createHash('sha256').update(sid, 'utf8').digest();
const refusalOf = (value: string | null | undefined): SlotlockSsoRefusal | null =>
  value === null || value === undefined ? null : (value as SlotlockSsoRefusal);

export interface SlotlockWorkspaceSso {
  connection(tenantRef: string): Promise<SlotlockSsoConnection | null>;
  connectionById(id: string): Promise<SlotlockSsoConnectionForSignIn | null>;
  /** A team's active connection, by its handle or a domain it holds verified. */
  route(by: { handle?: string; domain?: string }): Promise<{
    id: string;
    tenantRef: string;
    handle: string;
    name: string;
    authorizationEndpoint: string;
    clientId: string;
    kind: SlotlockSsoKind;
    entraTenant: string | null;
  } | null>;
  save(params: {
    tenantRef: string;
    actor: string;
    id: string;
    kind: SlotlockSsoKind;
    issuer: string;
    clientId: string;
    secretSealed: string | null;
    secretLast4: string | null;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    algorithms: readonly SlotlockOidcAlgorithm[];
    issParameter: boolean;
    entraTenant: string | null;
  }): Promise<{ id: string; enforcementOff: boolean } | { refusal: SlotlockSsoRefusal; id?: string }>;
  recordTest(tenantRef: string, actor: string, id: string, version: number, claims: Record<string, unknown>): Promise<SlotlockSsoRefusal | null>;
  setStatus(tenantRef: string, actor: string, id: string, status: 'active' | 'disabled'): Promise<SlotlockSsoRefusal | null>;
  remove(tenantRef: string, actor: string, id: string): Promise<SlotlockSsoRefusal | null>;
  setProvisioning(tenantRef: string, actor: string, jit: boolean, defaultRole: string, groupsClaim: string): Promise<SlotlockSsoRefusal | null>;
  setMapping(tenantRef: string, actor: string, value: string, role: string | null): Promise<SlotlockSsoRefusal | null>;
  mappings(tenantRef: string): Promise<{ value: string; role: SlotlockWorkspaceRole }[]>;
  signIn(params: {
    connectionId: string;
    issuer: string;
    subject: string;
    entraTid: string | null;
    entraOid: string | null;
    email: string | null;
    emailOk: boolean;
    groups: readonly string[];
    overage: boolean;
    guest: boolean;
    sessionPerson: string | null;
    memberCap: number | null;
  }): Promise<SlotlockSsoSignIn>;
  /** A session's proof from the connection, now; `scoped` for a session begun through it alone. */
  /** `configVersion`: the connection's configuration the sign-in went through, where known. */
  recordProof(sid: string, person: string, connectionId: string, scoped: boolean, configVersion?: number): Promise<boolean>;
  requireSso(tenantRef: string, actor: string, sid: string, on: boolean, maxAgeHours: number): Promise<SlotlockSsoRefusal | null>;
  bypass(tenantRef: string, person: string, sid: string): Promise<SlotlockSsoRefusal | null>;
  prune(): Promise<number>;
}

interface ConnectionRow {
  connection_id: string;
  kind: SlotlockSsoKind;
  status: SlotlockSsoConnection['status'];
  issuer: string;
  client_id: string;
  secret_sealed: string | null;
  secret_last4: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  algorithms: SlotlockOidcAlgorithm[];
  iss_parameter: boolean;
  entra_tenant: string | null;
  groups_claim: string;
  jit_enabled: boolean;
  default_role: SlotlockSsoConnection['defaultRole'];
  config_version: number;
  tested_version: number | null;
  last_tested_at: Date | null;
  last_test_claims: Record<string, unknown> | null;
  require_sso: boolean;
  sso_max_age_hours: number;
}

/** Through the functions of ddl-sso.ts. */
export function createSlotlockWorkspaceSso(sql: SlotlockSql): SlotlockWorkspaceSso {
  return {
    async connection(tenantRef) {
      if (!TEAM.test(tenantRef)) return null;
      const [row] = await sql<ConnectionRow[]>`SELECT * FROM slotlock.sso_connection_of(${tenantRef}::text)`;
      if (!row) return null;
      return {
        id: row.connection_id,
        kind: row.kind,
        status: row.status,
        issuer: row.issuer,
        clientId: row.client_id,
        secretSealed: row.secret_sealed,
        secretLast4: row.secret_last4,
        authorizationEndpoint: row.authorization_endpoint,
        tokenEndpoint: row.token_endpoint,
        jwksUri: row.jwks_uri,
        algorithms: row.algorithms,
        issParameter: row.iss_parameter,
        entraTenant: row.entra_tenant,
        groupsClaim: row.groups_claim,
        jitEnabled: row.jit_enabled,
        defaultRole: row.default_role,
        configVersion: Number(row.config_version),
        testedVersion: row.tested_version === null ? null : Number(row.tested_version),
        lastTestedAt: row.last_tested_at,
        lastTestClaims: row.last_test_claims,
        requireSso: row.require_sso,
        maxAgeHours: Number(row.sso_max_age_hours),
      };
    },
    async connectionById(id) {
      if (!UUID.test(id)) return null;
      const [row] = await sql<
        {
          team_ref: string;
          handle: string;
          name: string;
          kind: SlotlockSsoKind;
          status: SlotlockSsoConnection['status'];
          issuer: string;
          client_id: string;
          secret_sealed: string | null;
          token_endpoint: string;
          jwks_uri: string;
          algorithms: SlotlockOidcAlgorithm[];
          iss_parameter: boolean;
          entra_tenant: string | null;
          groups_claim: string;
          config_version: number;
        }[]
      >`SELECT * FROM slotlock.sso_connection_by_id(${id}::uuid)`;
      if (!row) return null;
      return {
        id,
        tenantRef: row.team_ref,
        handle: row.handle,
        name: row.name,
        kind: row.kind,
        status: row.status,
        issuer: row.issuer,
        clientId: row.client_id,
        secretSealed: row.secret_sealed,
        tokenEndpoint: row.token_endpoint,
        jwksUri: row.jwks_uri,
        algorithms: row.algorithms,
        issParameter: row.iss_parameter,
        entraTenant: row.entra_tenant,
        groupsClaim: row.groups_claim,
        configVersion: Number(row.config_version),
      };
    },
    async route(by) {
      const handle = by.handle?.trim().toLowerCase() || null;
      const domain = by.domain?.trim().toLowerCase() || null;
      if (handle === null && domain === null) return null;
      const [row] = await sql<
        {
          connection_id: string;
          team_ref: string;
          handle: string;
          name: string;
          authorization_endpoint: string;
          client_id: string;
          kind: SlotlockSsoKind;
          entra_tenant: string | null;
        }[]
      >`SELECT * FROM slotlock.sso_connection_route(${handle}::text, ${domain}::text)`;
      return row
        ? {
            id: row.connection_id,
            tenantRef: row.team_ref,
            handle: row.handle,
            name: row.name,
            authorizationEndpoint: row.authorization_endpoint,
            clientId: row.client_id,
            kind: row.kind,
            entraTenant: row.entra_tenant,
          }
        : null;
    },
    async save(params) {
      if (!TEAM.test(params.tenantRef) || !UUID.test(params.id)) return { refusal: 'not_found' };
      const [row] = await sql<{ connection_id: string | null; refusal: string | null; enforcement_off: boolean }[]>`
        SELECT connection_id, refusal, enforcement_off FROM slotlock.save_sso_connection(
          ${params.tenantRef}::text, ${params.actor}::text, ${params.id}::uuid, ${params.kind}::text, ${params.issuer}::text,
          ${params.clientId}::text, ${params.secretSealed}::text, ${params.secretLast4}::text,
          ${params.authorizationEndpoint}::text, ${params.tokenEndpoint}::text, ${params.jwksUri}::text,
          ${[...params.algorithms]}::text[], ${params.issParameter}::boolean, ${params.entraTenant}::text)`;
      if (row?.refusal) return { refusal: refusalOf(row.refusal) ?? 'not_allowed', ...(row.connection_id ? { id: row.connection_id } : {}) };
      return row?.connection_id ? { id: row.connection_id, enforcementOff: row.enforcement_off } : { refusal: 'not_allowed' };
    },
    async recordTest(tenantRef, actor, id, version, claims) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.record_sso_test(${tenantRef}::text, ${actor}::text, ${id}::uuid, ${version}::integer,
          ${JSON.stringify(claims)}::text::jsonb) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async setStatus(tenantRef, actor, id, status) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_sso_connection_status(${tenantRef}::text, ${actor}::text, ${id}::uuid, ${status}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async remove(tenantRef, actor, id) {
      if (!UUID.test(id)) return 'not_found';
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.delete_sso_connection(${tenantRef}::text, ${actor}::text, ${id}::uuid) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async setProvisioning(tenantRef, actor, jit, defaultRole, groupsClaim) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_sso_provisioning(${tenantRef}::text, ${actor}::text, ${jit}::boolean, ${defaultRole}::text,
          ${groupsClaim}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async setMapping(tenantRef, actor, value, role) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_sso_role_mapping(${tenantRef}::text, ${actor}::text, ${value}::text, ${role}::text) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async mappings(tenantRef) {
      if (!TEAM.test(tenantRef)) return [];
      const rows = await sql<{ idp_value: string; role: string }[]>`SELECT * FROM slotlock.sso_role_mappings_of(${tenantRef}::text)`;
      return rows.flatMap((row) => (isSlotlockWorkspaceRole(row.role) ? [{ value: row.idp_value, role: row.role }] : []));
    },
    async signIn(params) {
      if (!UUID.test(params.connectionId)) return { person: null, outcome: null, refusal: 'connection_inactive', role: null };
      const [row] = await sql<{ person: string | null; outcome: SlotlockSsoSignIn['outcome']; refusal: string | null; member_role: string | null }[]>`
        SELECT person, outcome, refusal, member_role FROM slotlock.sso_sign_in(
          ${params.connectionId}::uuid, ${params.issuer}::text, ${params.subject}::text, ${params.entraTid}::text,
          ${params.entraOid}::text, ${params.email}::text, ${params.emailOk}::boolean, ${[...params.groups].slice(0, 200)}::text[],
          ${params.overage}::boolean, ${params.guest}::boolean, ${params.sessionPerson}::text, ${params.memberCap}::integer)`;
      return {
        person: row?.person ?? null,
        outcome: row?.outcome ?? null,
        refusal: refusalOf(row?.refusal),
        role: isSlotlockWorkspaceRole(row?.member_role) ? (row?.member_role as SlotlockWorkspaceRole) : null,
      };
    },
    async recordProof(sid, person, connectionId, scoped, configVersion) {
      if (!UUID.test(connectionId)) return false;
      const [row] = await sql<{ recorded: boolean }[]>`
        SELECT slotlock.record_sso_proof(${sessionDigest(sid)}::bytea, ${person}::text, ${connectionId}::uuid, ${scoped}::boolean,
          ${configVersion ?? null}::integer) AS recorded`;
      return row?.recorded === true;
    },
    async requireSso(tenantRef, actor, sid, on, maxAgeHours) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.set_require_sso(${tenantRef}::text, ${actor}::text, ${sessionDigest(sid)}::bytea, ${on}::boolean,
          ${maxAgeHours}::integer) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async bypass(tenantRef, person, sid) {
      const [row] = await sql<{ refusal: string | null }[]>`
        SELECT slotlock.sso_owner_bypass(${tenantRef}::text, ${person}::text, ${sessionDigest(sid)}::bytea) AS refusal`;
      return refusalOf(row?.refusal);
    },
    async prune() {
      const [row] = await sql<{ pruned: number }[]>`SELECT slotlock.prune_sso() AS pruned`;
      return Number(row?.pruned ?? 0);
    },
  };
}
