// A team's SCIM 2.0 endpoint (teams phase 5.6–5.7): `<root>/scim/v2/<team id>/…`, on the dashboard's
// Worker and on the Node server alike. The token decides the team, and must be the one the address
// names; session cookies never work here, nor SCIM tokens on the dashboard. Requests are parsed and
// normalised by scim.ts, kept through workspace-scim.ts, and each write is one event in the team's
// audit log, as its token's (never a body: Okta sends a placeholder password).
import { randomUUID } from 'node:crypto';
import {
  SLOTLOCK_SCIM_CONTENT_TYPE,
  SlotlockScimError,
  type SlotlockScimErrorType,
  slotlockScimErrorBody,
  slotlockScimFilter,
  slotlockScimGroupFromBody,
  slotlockScimGroupResource,
  slotlockScimList,
  slotlockScimPage,
  slotlockScimPatchGroup,
  slotlockScimPatchOperations,
  slotlockScimPatchUser,
  slotlockScimResourceTypes,
  slotlockScimSchemas,
  slotlockScimServiceProviderConfig,
  slotlockScimUserFromBody,
  slotlockScimUserResource,
} from './scim.js';
import type { SlotlockAuditEventInput } from './store.js';
import type { SlotlockScimLookup, SlotlockScimRefusal, SlotlockWorkspaceScim } from './workspace-scim.js';

/** What the endpoint needs from its host. */
export interface SlotlockScimServerOptions {
  scim: SlotlockWorkspaceScim;
  /** Where `scim/v2` lives: the dashboard's public root. */
  publicRoot: string;
  documentationUri: string;
  /** Records an event in a team's audit log. */
  record?: (tenantRef: string, event: SlotlockAuditEventInput) => Promise<void>;
  /** A person's membership ended by the directory: their keys go where the team chose. */
  deactivated?: (tenantRef: string, person: string, keyPolicy: 'keep' | 'revoke') => Promise<number>;
  newId?: () => string;
}

const USER_FILTERS = ['username', 'externalid', 'id', 'emails[type eq "work"].value', 'emails.value'];
const GROUP_FILTERS = ['displayname', 'externalid', 'id'];
const MAX_BODY_BYTES = 262_144;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': `${SLOTLOCK_SCIM_CONTENT_TYPE}; charset=utf-8`, 'cache-control': 'no-store', ...headers },
  });
const failure = (status: number, scimType: SlotlockScimErrorType | null, detail: string) => json(status, slotlockScimErrorBody(status, scimType, detail));

/** How a refusal from the database answers. */
function refused(refusal: SlotlockScimRefusal): Response {
  switch (refusal) {
    case 'uniqueness':
      return failure(409, 'uniqueness', 'A resource with that name exists');
    case 'domain_not_verified':
      return failure(400, 'invalidValue', 'The address is not at a domain this team has verified');
    case 'owner_protected':
      return failure(400, 'mutability', 'Owners are managed in Slotlock, not by the directory');
    case 'invalid_member':
      return failure(400, 'invalidValue', 'A member is not one of this team’s users');
    case 'not_found':
      return failure(404, null, 'Not found');
    default:
      return failure(400, 'invalidValue', refusal);
  }
}

/** The lookup a filter asks for, as workspace-scim.ts takes it. */
function lookupOf(query: URLSearchParams, allowed: readonly string[]): SlotlockScimLookup {
  const filter = query.get('filter');
  if (filter === null || filter.trim() === '') return null;
  const [first, ...rest] = slotlockScimFilter(filter, allowed);
  if (!first || rest.length > 0) throw new SlotlockScimError(400, 'invalidFilter', 'Slotlock filters by one attribute');
  const attribute = first.attribute.startsWith('emails') ? 'email' : first.attribute;
  return { attribute, value: first.value };
}

async function bodyOf(request: Request): Promise<unknown> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== SLOTLOCK_SCIM_CONTENT_TYPE && type !== 'application/json') throw new SlotlockScimError(415, null, 'Send application/scim+json');
  // Counted in bytes as it arrives, never read past the cap: a token's holder cannot make the server
  // buffer an endless body.
  const tooLarge = () => new SlotlockScimError(413, null, 'The request is too large');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SlotlockScimError(400, 'invalidSyntax', 'The body is not UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SlotlockScimError(400, 'invalidSyntax', 'The body is not JSON');
  }
}

/**
 * One SCIM request. `path` is what follows `scim/v2/`: `<team id>/<resource>[/<id>]`. Answers 401
 * without a token for the team the address names.
 */
export async function handleSlotlockScimRequest(request: Request, path: string, options: SlotlockScimServerOptions): Promise<Response> {
  const [teamId = '', resource = '', id, ...extra] = path.split('/');
  const authorization = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? '';
  const authenticated = await options.scim.authenticate(token, teamId);
  if ('refusal' in authenticated) {
    // Another team's token at this address: a security event, in the token's own team's log.
    if (authenticated.refusal === 'wrong_workspace' && authenticated.tenantRef && options.record) {
      await options.record(authenticated.tenantRef, {
        action: 'scim.token_refused',
        actorType: 'system',
        actorRef: `scim_token:${authenticated.prefix ?? 'unknown'}`,
        outcome: 'denied',
        reason: 'wrong_workspace',
      }).catch(() => undefined);
    }
    return json(401, slotlockScimErrorBody(401, null, 'A SCIM token for this team is needed'), { 'www-authenticate': 'Bearer' });
  }
  const { tenantRef, prefix, keyPolicy } = authenticated;
  const base = `${options.publicRoot}/scim/v2/${teamId.toLowerCase()}`;
  const actor = { actorType: 'system' as const, actorRef: `scim_token:${prefix}` };
  const record = async (event: Omit<SlotlockAuditEventInput, 'actorType' | 'actorRef'>) => {
    await options.record?.(tenantRef, { ...event, ...actor }).catch(() => undefined);
  };
  const newId = options.newId ?? randomUUID;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (extra.length > 0) return failure(404, null, 'Not found');
  try {
    if (resource === 'ServiceProviderConfig' && method === 'GET') return json(200, slotlockScimServiceProviderConfig(options.documentationUri));
    if (resource === 'ResourceTypes' && method === 'GET') return json(200, slotlockScimResourceTypes(base));
    if (resource === 'Schemas' && method === 'GET') return json(200, slotlockScimSchemas(base));

    if (resource === 'Users') {
      const meta = (user: { id: string; createdAt: Date; updatedAt: Date }) => ({ created: user.createdAt, lastModified: user.updatedAt, location: `${base}/Users/${user.id}` });
      const one = async (userId: string) => (await options.scim.users(tenantRef, null, 1, 1, userId)).users[0];
      if (id === undefined && method === 'GET') {
        const { startIndex, count } = slotlockScimPage(url.searchParams);
        const found = await options.scim.users(tenantRef, lookupOf(url.searchParams, USER_FILTERS), startIndex, count);
        return json(200, slotlockScimList(found.users.map((user) => slotlockScimUserResource(user.id, user, meta(user))), found.total, startIndex));
      }
      if (id === undefined && method === 'POST') {
        const user = slotlockScimUserFromBody(await bodyOf(request));
        const saved = await options.scim.putUser(tenantRef, null, newId(), user);
        if ('refusal' in saved) return refused(saved.refusal);
        await record({ action: 'scim.user_created', targetType: 'scim_user', targetRef: saved.id });
        const made = await one(saved.id);
        return made ? json(201, slotlockScimUserResource(made.id, made, meta(made)), { location: `${base}/Users/${made.id}` }) : failure(404, null, 'Not found');
      }
      if (id === undefined) return failure(405, null, 'Not allowed');
      const current = await one(id);
      if (!current) return failure(404, null, 'Not found');
      if (method === 'GET') return json(200, slotlockScimUserResource(current.id, current, meta(current)));
      if (method === 'DELETE') {
        const deleted = await options.scim.deleteUser(tenantRef, id);
        if (deleted.refusal) return refused(deleted.refusal);
        await record({ action: 'scim.user_deleted', targetType: 'scim_user', targetRef: id });
        if (deleted.person) await options.deactivated?.(tenantRef, deleted.person, keyPolicy);
        return json(204, null);
      }
      if (method === 'PUT' || method === 'PATCH') {
        const user =
          method === 'PUT'
            ? slotlockScimUserFromBody(await bodyOf(request))
            : slotlockScimPatchUser(current, current.id, slotlockScimPatchOperations(await bodyOf(request)));
        const saved = await options.scim.putUser(tenantRef, id, newId(), user);
        if ('refusal' in saved) {
          if (saved.refusal === 'owner_protected') {
            await record({ action: 'scim.user_refused', targetType: 'scim_user', targetRef: id, outcome: 'denied', reason: 'owner_protected' });
          }
          return refused(saved.refusal);
        }
        if (saved.membership === 'deactivated' && saved.person) {
          const revoked = (await options.deactivated?.(tenantRef, saved.person, keyPolicy)) ?? 0;
          await record({ action: 'scim.user_deactivated', targetType: 'person', targetRef: saved.person, metadata: { keys: keyPolicy, revoked } });
        } else if (saved.membership === 'activated' && saved.person) {
          await record({ action: 'scim.user_reactivated', targetType: 'person', targetRef: saved.person });
        } else {
          await record({ action: 'scim.user_updated', targetType: 'scim_user', targetRef: id });
        }
        const updated = await one(id);
        return updated ? json(200, slotlockScimUserResource(updated.id, updated, meta(updated))) : failure(404, null, 'Not found');
      }
      return failure(405, null, 'Not allowed');
    }

    if (resource === 'Groups') {
      const meta = (group: { id: string; createdAt: Date; updatedAt: Date }) => ({ created: group.createdAt, lastModified: group.updatedAt, location: `${base}/Groups/${group.id}` });
      const withMembers = !/\bmembers\b/i.test(url.searchParams.get('excludedAttributes') ?? '');
      const one = async (groupId: string) => (await options.scim.groups(tenantRef, null, 1, 1, groupId)).groups[0];
      if (id === undefined && method === 'GET') {
        const { startIndex, count } = slotlockScimPage(url.searchParams);
        const found = await options.scim.groups(tenantRef, lookupOf(url.searchParams, GROUP_FILTERS), startIndex, count);
        return json(200, slotlockScimList(found.groups.map((group) => slotlockScimGroupResource(group.id, group, meta(group), withMembers)), found.total, startIndex));
      }
      if (id === undefined && method === 'POST') {
        const group = slotlockScimGroupFromBody(await bodyOf(request));
        const saved = await options.scim.putGroup(tenantRef, null, newId(), group);
        if ('refusal' in saved) return refused(saved.refusal);
        await record({ action: 'scim.group_created', targetType: 'scim_group', targetRef: saved.id, metadata: { members: group.members.length } });
        const made = await one(saved.id);
        return made ? json(201, slotlockScimGroupResource(made.id, made, meta(made)), { location: `${base}/Groups/${made.id}` }) : failure(404, null, 'Not found');
      }
      if (id === undefined) return failure(405, null, 'Not allowed');
      const current = await one(id);
      if (!current) return failure(404, null, 'Not found');
      if (method === 'GET') return json(200, slotlockScimGroupResource(current.id, current, meta(current), withMembers));
      if (method === 'DELETE') {
        const refusal = await options.scim.deleteGroup(tenantRef, id);
        if (refusal) return refused(refusal);
        await record({ action: 'scim.group_deleted', targetType: 'scim_group', targetRef: id });
        return json(204, null);
      }
      if (method === 'PUT' || method === 'PATCH') {
        const group =
          method === 'PUT'
            ? slotlockScimGroupFromBody(await bodyOf(request))
            : slotlockScimPatchGroup(current, current.id, slotlockScimPatchOperations(await bodyOf(request)));
        const saved = await options.scim.putGroup(tenantRef, id, newId(), group);
        if ('refusal' in saved) return refused(saved.refusal);
        await record({ action: 'scim.group_updated', targetType: 'scim_group', targetRef: id, metadata: { members: group.members.length } });
        const updated = await one(id);
        return updated ? json(200, slotlockScimGroupResource(updated.id, updated, meta(updated), withMembers)) : failure(404, null, 'Not found');
      }
      return failure(405, null, 'Not allowed');
    }
    return failure(404, null, 'Not found');
  } catch (error) {
    if (error instanceof SlotlockScimError) return failure(error.status, error.scimType, error.message);
    throw error;
  }
}
