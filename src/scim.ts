// SCIM 2.0 (RFC 7643, RFC 7644) as Okta and Microsoft Entra ID speak it (teams phase 5.6–5.7): the
// pure part, shared by both runtimes. Requests are normalised here before anything is applied, so
// the database sees one shape whichever provider sent it:
// - `op` in any case (Entra without `aadOptscim062020` sends "Replace");
// - booleans as JSON booleans or the strings "True"/"False" (Entra again);
// - a replace with no path whose value holds dotted or URN-qualified keys (Entra with the flag,
//   Okta's deactivation) expanded into one operation per attribute;
// - Okta's group rename, which carries the group's own id in its value, accepted;
// - Entra's member removal without the flag ({"op":"Remove","path":"members","value":[{value}]})
//   read as removing those members, never as clearing the list;
// - a remove with no path refused (400 noTarget), as RFC 7644 §3.5.2.2 says.
// Attributes Slotlock does not keep (Entra's enterprise extension, phone numbers, …) are ignored.

export const SLOTLOCK_SCIM_CONTENT_TYPE = 'application/scim+json';
export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
/** A page holds at most this many resources (ServiceProviderConfig's filter.maxResults). */
export const SLOTLOCK_SCIM_MAX_RESULTS = 100;

/** RFC 7644 §3.12's error types Slotlock answers with. */
export type SlotlockScimErrorType = 'invalidFilter' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue';

/** A request refused: its status and SCIM error type. */
export class SlotlockScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: SlotlockScimErrorType | null,
    message: string,
  ) {
    super(message);
    this.name = 'SlotlockScimError';
  }
}

/** An error body: `status` as a string, as RFC 7644 §3.12 has it. */
export function slotlockScimErrorBody(status: number, scimType: SlotlockScimErrorType | null, detail: string) {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail };
}

/** The user attributes Slotlock keeps. */
export interface SlotlockScimUserAttributes {
  /** As the provider sent it; matched case-insensitively. */
  userName: string;
  externalId: string | null;
  active: boolean;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  /** The work email: `emails[type eq "work"]`, else the primary one, else the first. */
  workEmail: string | null;
}

/** A group's attributes, its members by their SCIM ids. */
export interface SlotlockScimGroupAttributes {
  displayName: string;
  externalId: string | null;
  members: string[];
}

const invalid = (detail: string) => new SlotlockScimError(400, 'invalidValue', detail);
const textOf = (value: unknown, what: string, max = 254): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || /[\p{Cc}]/u.test(value)) throw invalid(`${what} must be text of at most ${max} characters`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** A SCIM boolean: true or false, or the strings Entra sends ("True", "False"). */
export function slotlockScimBoolean(value: unknown): boolean {
  if (value === true || value === false) return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  throw invalid('active must be true or false');
}

/** The work email of an `emails` value: type work, else primary, else the first. */
function workEmailOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw invalid('emails must be a list');
  const emails = value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  const chosen =
    emails.find((entry) => typeof entry.type === 'string' && entry.type.toLowerCase() === 'work') ??
    emails.find((entry) => entry.primary === true || entry.primary === 'true' || entry.primary === 'True') ??
    emails[0];
  const address = textOf(chosen?.value, 'An email');
  return address === null ? null : address.toLowerCase();
}

/** A user as a POST or PUT body gives it (RFC 7643 §4.1): what Slotlock keeps, the rest ignored. */
export function slotlockScimUserFromBody(body: unknown): SlotlockScimUserAttributes {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SlotlockScimError(400, 'invalidSyntax', 'A user is a JSON object');
  const user = body as Record<string, unknown>;
  const userName = textOf(user.userName, 'userName');
  if (userName === null) throw invalid('userName is required');
  const name = typeof user.name === 'object' && user.name !== null ? (user.name as Record<string, unknown>) : {};
  return {
    userName,
    externalId: textOf(user.externalId, 'externalId', 255),
    active: user.active === undefined ? true : slotlockScimBoolean(user.active),
    givenName: textOf(name.givenName, 'name.givenName', 100),
    familyName: textOf(name.familyName, 'name.familyName', 100),
    displayName: textOf(user.displayName, 'displayName', 200),
    workEmail: workEmailOf(user.emails),
  };
}

/** A group as a POST or PUT body gives it. */
export function slotlockScimGroupFromBody(body: unknown): SlotlockScimGroupAttributes {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SlotlockScimError(400, 'invalidSyntax', 'A group is a JSON object');
  const group = body as Record<string, unknown>;
  const displayName = textOf(group.displayName, 'displayName', 200);
  if (displayName === null) throw invalid('displayName is required');
  return { displayName, externalId: textOf(group.externalId, 'externalId', 255), members: membersOf(group.members) };
}

function membersOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('members must be a list');
  const ids: string[] = [];
  for (const entry of value) {
    const id = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).value : undefined;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw invalid('Each member is {"value": "<user id>"}');
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** One patch operation, as normalised: its op in lowercase, its path (null: the resource), its value. */
export interface SlotlockScimPatchOperation {
  op: 'add' | 'replace' | 'remove';
  path: string | null;
  value: unknown;
}

/** A PATCH body's operations, normalised (see the top of this file). */
export function slotlockScimPatchOperations(body: unknown): SlotlockScimPatchOperation[] {
  if (typeof body !== 'object' || body === null) throw new SlotlockScimError(400, 'invalidSyntax', 'A patch is a JSON object');
  const patch = body as Record<string, unknown>;
  const schemas = Array.isArray(patch.schemas) ? patch.schemas : [];
  if (!schemas.includes(SCIM_PATCH_SCHEMA)) throw new SlotlockScimError(400, 'invalidSyntax', `A patch names the schema ${SCIM_PATCH_SCHEMA}`);
  const operations = patch.Operations ?? patch.operations;
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) {
    throw new SlotlockScimError(400, 'invalidSyntax', 'A patch has 1 to 100 Operations');
  }
  return operations.map((operation) => {
    if (typeof operation !== 'object' || operation === null) throw new SlotlockScimError(400, 'invalidSyntax', 'Each operation is an object');
    const { op, path, value } = operation as Record<string, unknown>;
    const name = typeof op === 'string' ? op.toLowerCase() : '';
    if (name !== 'add' && name !== 'replace' && name !== 'remove') throw new SlotlockScimError(400, 'invalidSyntax', 'op is add, replace or remove');
    if (path !== undefined && path !== null && (typeof path !== 'string' || path.length > 200)) throw new SlotlockScimError(400, 'invalidPath', 'path is text');
    const target = typeof path === 'string' && path.trim() !== '' ? path.trim() : null;
    if (name === 'remove' && target === null) throw new SlotlockScimError(400, 'noTarget', 'A remove names its path');
    return { op: name, path: target, value };
  });
}

/** A path without the core schema's URN prefix, in lowercase; null for an extension's (ignored). */
function corePath(path: string, schema: string): string | null {
  const lower = path.toLowerCase();
  const prefix = `${schema.toLowerCase()}:`;
  if (lower.startsWith(prefix)) return lower.slice(prefix.length);
  if (lower.startsWith('urn:')) return null;
  return lower;
}

/** Each attribute a path-less add or replace sets: its keys as paths (dotted or URN-qualified). */
function expand(operation: SlotlockScimPatchOperation): SlotlockScimPatchOperation[] {
  if (operation.path !== null) return [operation];
  if (typeof operation.value !== 'object' || operation.value === null || Array.isArray(operation.value)) {
    throw invalid('An add or replace without a path holds an object of attributes');
  }
  return Object.entries(operation.value as Record<string, unknown>).map(([key, value]) => ({ op: operation.op, path: key, value }));
}

/** A user changed by a patch, all of it or none (RFC 7644 §3.5.2: a patch is atomic). */
export function slotlockScimPatchUser(current: SlotlockScimUserAttributes, id: string, operations: readonly SlotlockScimPatchOperation[]): SlotlockScimUserAttributes {
  const next = { ...current };
  for (const operation of operations.flatMap(expand)) {
    const path = corePath(operation.path as string, SCIM_USER_SCHEMA);
    if (path === null || path === 'schemas' || path === 'meta') continue;
    const removing = operation.op === 'remove';
    const value = removing ? null : operation.value;
    switch (path) {
      case 'id':
        if (value !== id) throw new SlotlockScimError(400, 'mutability', 'id is read-only');
        break;
      case 'active':
        if (removing) throw invalid('active cannot be removed');
        next.active = slotlockScimBoolean(value);
        break;
      case 'username': {
        const userName = textOf(value, 'userName');
        if (userName === null) throw invalid('userName is required');
        next.userName = userName;
        break;
      }
      case 'externalid':
        next.externalId = textOf(value, 'externalId', 255);
        break;
      case 'displayname':
        next.displayName = textOf(value, 'displayName', 200);
        break;
      case 'name.givenname':
        next.givenName = textOf(value, 'name.givenName', 100);
        break;
      case 'name.familyname':
        next.familyName = textOf(value, 'name.familyName', 100);
        break;
      case 'name': {
        const name = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
        next.givenName = removing ? null : textOf(name.givenName, 'name.givenName', 100);
        next.familyName = removing ? null : textOf(name.familyName, 'name.familyName', 100);
        break;
      }
      case 'emails':
        next.workEmail = removing ? null : workEmailOf(value);
        break;
      case 'emails[type eq "work"].value':
      case 'emails[type eq "work"]': {
        const address = path.endsWith('.value') ? textOf(value, 'An email') : workEmailOf(value === null ? null : [value]);
        next.workEmail = address === null ? null : address.toLowerCase();
        break;
      }
      default:
        // Kept nowhere in Slotlock (title, phone numbers, addresses, locale, …): ignored.
        break;
    }
  }
  return next;
}

/** A group changed by a patch, all of it or none. */
export function slotlockScimPatchGroup(current: SlotlockScimGroupAttributes, id: string, operations: readonly SlotlockScimPatchOperation[]): SlotlockScimGroupAttributes {
  const next = { ...current, members: [...current.members] };
  for (const operation of operations.flatMap(expand)) {
    const raw = operation.path as string;
    const path = corePath(raw, SCIM_GROUP_SCHEMA);
    if (path === null || path === 'schemas' || path === 'meta') continue;
    const member = /^members\[value eq "([^"\\]{1,64})"\]$/.exec(path)?.[1];
    if (member !== undefined) {
      if (operation.op !== 'remove') throw new SlotlockScimError(400, 'invalidPath', 'A member filter only removes');
      // The id as sent (ids are case-sensitive); the path was lowercased to match its shape only.
      const sent = /\[value eq "([^"\\]{1,64})"\]/i.exec(raw)?.[1] ?? member;
      next.members = next.members.filter((existing) => existing !== sent);
      continue;
    }
    switch (path) {
      case 'id':
        if (operation.value !== id) throw new SlotlockScimError(400, 'mutability', 'id is read-only');
        break;
      case 'displayname': {
        if (operation.op === 'remove') throw invalid('displayName cannot be removed');
        const displayName = textOf(operation.value, 'displayName', 200);
        if (displayName === null) throw invalid('displayName is required');
        next.displayName = displayName;
        break;
      }
      case 'externalid':
        next.externalId = operation.op === 'remove' ? null : textOf(operation.value, 'externalId', 255);
        break;
      case 'members': {
        if (operation.op === 'replace') {
          next.members = membersOf(operation.value);
        } else if (operation.op === 'add') {
          next.members = [...new Set([...next.members, ...membersOf(operation.value)])];
        } else if (operation.value === undefined || operation.value === null) {
          // RFC 7644: a remove of the whole attribute.
          next.members = [];
        } else {
          // Entra without the flag: the members named, not the list.
          const removed = new Set(membersOf(operation.value));
          next.members = next.members.filter((existing) => !removed.has(existing));
        }
        break;
      }
      default:
        break;
    }
  }
  return next;
}

/** A filter Slotlock answers: `attribute eq "value"`, joined by `and`; the attributes its caller allows. */
export interface SlotlockScimFilter {
  /** In lowercase, as the caller's allowed list names it. */
  attribute: string;
  value: string;
}

/**
 * A filter (RFC 7644 §3.4.2.2) as Okta and Entra send it: `eq` comparisons of the allowed
 * attributes, joined by `and`. Anything else is 400 invalidFilter.
 */
export function slotlockScimFilter(filter: string, allowed: readonly string[]): SlotlockScimFilter[] {
  if (filter.length > 500) throw new SlotlockScimError(400, 'invalidFilter', 'The filter is too long');
  const comparisons: SlotlockScimFilter[] = [];
  let rest = filter.trim();
  const comparison = /^([A-Za-z][A-Za-z0-9._:-]*(?:\[[A-Za-z]+ eq "[A-Za-z]+"\]\.[A-Za-z]+)?)\s+eq\s+"((?:[^"\\]|\\.){0,254})"/i;
  for (;;) {
    const match = comparison.exec(rest);
    if (!match) throw new SlotlockScimError(400, 'invalidFilter', 'Slotlock filters by eq, joined by and');
    const attribute = corePath(match[1] as string, SCIM_USER_SCHEMA) ?? '';
    if (!allowed.includes(attribute)) throw new SlotlockScimError(400, 'invalidFilter', `Slotlock does not filter by ${match[1] as string}`);
    let value: string;
    try {
      value = JSON.parse(`"${match[2] as string}"`) as string;
    } catch {
      throw new SlotlockScimError(400, 'invalidFilter', 'The filter value is not a valid string');
    }
    if (/\p{Cc}/u.test(value)) throw new SlotlockScimError(400, 'invalidFilter', 'The filter value holds a control character');
    comparisons.push({ attribute, value });
    rest = rest.slice(match[0].length).trim();
    if (rest === '') return comparisons;
    const and = /^and\s+/i.exec(rest);
    if (!and || comparisons.length >= 5) throw new SlotlockScimError(400, 'invalidFilter', 'Slotlock filters by eq, joined by and');
    rest = rest.slice(and[0].length);
  }
}

/** Where a resource lives, for its meta. */
export interface SlotlockScimMeta {
  created: Date;
  lastModified: Date;
  location: string;
}

/** A user as SCIM answers it: every attribute Slotlock keeps, so a GET then PUT loses nothing. */
export function slotlockScimUserResource(id: string, user: SlotlockScimUserAttributes, meta: SlotlockScimMeta) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id,
    ...(user.externalId !== null ? { externalId: user.externalId } : {}),
    userName: user.userName,
    active: user.active,
    ...(user.givenName !== null || user.familyName !== null
      ? { name: { ...(user.givenName !== null ? { givenName: user.givenName } : {}), ...(user.familyName !== null ? { familyName: user.familyName } : {}) } }
      : {}),
    ...(user.displayName !== null ? { displayName: user.displayName } : {}),
    ...(user.workEmail !== null ? { emails: [{ value: user.workEmail, type: 'work', primary: true }] } : {}),
    meta: { resourceType: 'User', created: meta.created.toISOString(), lastModified: meta.lastModified.toISOString(), location: meta.location },
  };
}

/** A group as SCIM answers it, with its members unless asked not to. */
export function slotlockScimGroupResource(id: string, group: SlotlockScimGroupAttributes, meta: SlotlockScimMeta, withMembers = true) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id,
    displayName: group.displayName,
    ...(group.externalId !== null ? { externalId: group.externalId } : {}),
    ...(withMembers ? { members: group.members.map((member) => ({ value: member })) } : {}),
    meta: { resourceType: 'Group', created: meta.created.toISOString(), lastModified: meta.lastModified.toISOString(), location: meta.location },
  };
}

/** A list response; an empty one too (Entra needs it), with integer counts. */
export function slotlockScimList(resources: readonly unknown[], totalResults: number, startIndex: number) {
  return { schemas: [SCIM_LIST_SCHEMA], totalResults, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** startIndex and count as a page: startIndex below 1 read as 1, count clamped to 0–100. */
export function slotlockScimPage(query: URLSearchParams): { startIndex: number; count: number } {
  const start = Number.parseInt(query.get('startIndex') ?? '1', 10);
  const count = Number.parseInt(query.get('count') ?? String(SLOTLOCK_SCIM_MAX_RESULTS), 10);
  return {
    // Within PostgreSQL's integer: past the end answers an empty page, never an error.
    startIndex: Number.isFinite(start) && start >= 1 ? Math.min(start, 2_000_000_000) : 1,
    count: Number.isFinite(count) ? Math.min(Math.max(count, 0), SLOTLOCK_SCIM_MAX_RESULTS) : SLOTLOCK_SCIM_MAX_RESULTS,
  };
}

/** What Slotlock supports (RFC 7643 §5): PATCH, filters up to 100 results; no bulk, sort or ETags. */
export function slotlockScimServiceProviderConfig(documentationUri: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SLOTLOCK_SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token from the team’s Identity settings', primary: true },
    ],
    meta: { resourceType: 'ServiceProviderConfig' },
  };
}

/** The resource types Slotlock serves, as a list. */
export function slotlockScimResourceTypes(base: string) {
  const types = [
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP_SCHEMA, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
  ];
  return slotlockScimList(types, types.length, 1);
}

const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

/** The schemas of what Slotlock keeps, as a list. */
export function slotlockScimSchemas(base: string) {
  const schemas = [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: SCIM_USER_SCHEMA,
      name: 'User',
      attributes: [
        attribute('userName', 'string', { required: true, uniqueness: 'server' }),
        attribute('externalId', 'string', { caseExact: true }),
        attribute('active', 'boolean'),
        attribute('displayName', 'string'),
        attribute('name', 'complex', { subAttributes: [attribute('givenName', 'string'), attribute('familyName', 'string')] }),
        attribute('emails', 'complex', { multiValued: true, subAttributes: [attribute('value', 'string'), attribute('type', 'string'), attribute('primary', 'boolean')] }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM_USER_SCHEMA}` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: SCIM_GROUP_SCHEMA,
      name: 'Group',
      attributes: [
        attribute('displayName', 'string', { required: true, uniqueness: 'server' }),
        attribute('externalId', 'string', { caseExact: true }),
        attribute('members', 'complex', { multiValued: true, subAttributes: [attribute('value', 'string', { mutability: 'immutable' })] }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM_GROUP_SCHEMA}` },
    },
  ];
  return slotlockScimList(schemas, schemas.length, 1);
}
