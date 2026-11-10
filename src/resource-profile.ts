// A resource's profile (RFC 0003 G1): how people and agents tell resources apart and find them,
// whatever they are (a person, a room, a vehicle, a machine). Every field is optional, and none
// changes how a resource is booked: `kind` is a hint for filtering and `capacity` is informational,
// as SPEC.md requires ("no semantic rule assumes a particular industry"). Names and descriptions are
// calendar content: the feed says which profile fields changed, never their values.

/** What a resource is, as a hint for filtering and display; `other` when not said. */
export const SLOTLOCK_RESOURCE_KINDS = Object.freeze([
  'person',
  'room',
  'desk',
  'space',
  'vehicle',
  'machine',
  'equipment',
  'service',
  'other',
] as const);

export type SlotlockResourceKind = (typeof SLOTLOCK_RESOURCE_KINDS)[number];

/** The profile's bounds, which the database also holds (ddl.ts). */
export const SLOTLOCK_RESOURCE_PROFILE_LIMITS = Object.freeze({
  /** Characters in a name. */
  name: 200,
  /** Characters in a description. */
  description: 2_000,
  /** The most people or seats a resource is said to hold. */
  capacity: 100_000,
  /** Labels on one resource. */
  labels: 20,
  /** Keys in its attributes. */
  attributes: 50,
  /** Characters in an attribute's key. */
  attributeKey: 64,
  /** Characters in an attribute's text value. */
  attributeValue: 1_000,
  /** Bytes of its attributes as compact JSON. */
  attributeBytes: 4_096,
});

/** A label: lower case letters, digits, `.`, `_` and `-`, starting with a letter or digit, 1-64. */
export const SLOTLOCK_RESOURCE_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What an integrator keeps on a resource and wants back: text, numbers and true or false. */
export type SlotlockResourceAttributes = Record<string, string | number | boolean>;

/**
 * A resource's profile as it is set: a field left out is kept as it is. `null` clears a name, a
 * description or a capacity; `labels: []` and `attributes: {}` clear those, and `kind: 'other'`
 * says nothing about what it is.
 */
export interface SlotlockResourceProfileInput {
  name?: string | null;
  description?: string | null;
  kind?: SlotlockResourceKind;
  capacity?: number | null;
  labels?: readonly string[];
  attributes?: Readonly<SlotlockResourceAttributes>;
}

/** A profile input that passed its checks: names trimmed, labels sorted without repeats. */
export interface SlotlockResourceProfileChange {
  name?: string | null;
  description?: string | null;
  kind?: SlotlockResourceKind;
  capacity?: number | null;
  labels?: string[];
  attributes?: SlotlockResourceAttributes;
}

/** The profile fields, as the feed and the API name them. */
export const SLOTLOCK_RESOURCE_PROFILE_FIELDS = Object.freeze([
  'name',
  'description',
  'kind',
  'capacity',
  'labels',
  'attributes',
] as const);

type InvalidProfile = Error & { code: 'invalid_resource_profile'; field: string };

function invalid(field: string, message: string): InvalidProfile {
  return Object.assign(new Error(`Slotlock resource ${field} ${message}`), {
    code: 'invalid_resource_profile' as const,
    field,
  });
}

// C0 and C1 control characters, which no name shows; a description may still break lines.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** Characters as PostgreSQL's char_length counts them: code points, not UTF-16 units. */
const characters = (value: string) => [...value].length;

function text(field: string, value: unknown, max: number, lines: boolean): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(field, 'must be text or null');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(field, 'must not be empty: send null to clear it');
  if (characters(trimmed) > max) throw invalid(field, `must be at most ${max} characters`);
  if ((lines ? CONTROL_BUT_LINES : CONTROL).test(trimmed)) {
    throw invalid(field, 'must not contain control characters');
  }
  return trimmed;
}

/**
 * Check a profile change and put it in the form it is stored in: refused with
 * `invalid_resource_profile`, naming the field, when a field is outside its bounds.
 */
export function parseSlotlockResourceProfile(input: SlotlockResourceProfileInput): SlotlockResourceProfileChange {
  const limits = SLOTLOCK_RESOURCE_PROFILE_LIMITS;
  const change: SlotlockResourceProfileChange = {};
  if (input.name !== undefined) change.name = text('name', input.name, limits.name, false);
  if (input.description !== undefined) {
    change.description = text('description', input.description, limits.description, true);
  }
  if (input.kind !== undefined) {
    if (!(SLOTLOCK_RESOURCE_KINDS as readonly unknown[]).includes(input.kind)) {
      throw invalid('kind', `must be one of ${SLOTLOCK_RESOURCE_KINDS.join(', ')}`);
    }
    change.kind = input.kind;
  }
  if (input.capacity !== undefined) {
    if (
      input.capacity !== null &&
      !(Number.isSafeInteger(input.capacity) && input.capacity >= 1 && input.capacity <= limits.capacity)
    ) {
      throw invalid('capacity', `must be a whole number from 1 to ${limits.capacity}, or null`);
    }
    change.capacity = input.capacity;
  }
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels)) throw invalid('labels', 'must be a list');
    const labels = [...new Set(input.labels as unknown[])];
    if (labels.length > limits.labels) throw invalid('labels', `must be at most ${limits.labels}`);
    for (const label of labels) {
      if (typeof label !== 'string' || !SLOTLOCK_RESOURCE_LABEL.test(label)) {
        throw invalid(
          'labels',
          'must each be 1-64 of a-z, 0-9, ".", "_" and "-", starting with a letter or digit',
        );
      }
    }
    change.labels = (labels as string[]).sort();
  }
  if (input.attributes !== undefined) {
    const given = input.attributes as unknown;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) {
      throw invalid('attributes', 'must be an object');
    }
    const entries = Object.entries(given as Record<string, unknown>);
    if (entries.length > limits.attributes) {
      throw invalid('attributes', `must have at most ${limits.attributes} keys`);
    }
    const attributes: SlotlockResourceAttributes = {};
    for (const [key, value] of entries) {
      if (key.length === 0 || characters(key) > limits.attributeKey || CONTROL.test(key)) {
        throw invalid('attributes', `keys must be 1-${limits.attributeKey} characters without control characters`);
      }
      if (typeof value === 'string') {
        if (characters(value) > limits.attributeValue) {
          throw invalid('attributes', `text values must be at most ${limits.attributeValue} characters`);
        }
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalid('attributes', 'numbers must be finite');
      } else if (typeof value !== 'boolean') {
        throw invalid('attributes', 'values must be text, numbers, or true or false');
      }
      attributes[key] = value as string | number | boolean;
    }
    if (Buffer.byteLength(JSON.stringify(attributes), 'utf8') > limits.attributeBytes) {
      throw invalid('attributes', `must be at most ${limits.attributeBytes} bytes as JSON`);
    }
    change.attributes = attributes;
  }
  return change;
}

/** Whether a resource's labels include every one of `wanted`. */
export function slotlockResourceHasLabels(labels: readonly string[] | undefined, wanted: readonly string[]): boolean {
  return wanted.every((label) => labels?.includes(label) === true);
}

// Where a resource is, and the sets it is in (RFC 0003 G2, G3): a location is a place in a tree of
// the tenant's own (one a resource), a group any set the tenant wants (many a resource). Neither
// changes how a resource is booked; a pool does that.

/** Locations a tenant may have. */
export const SLOTLOCK_MAX_LOCATIONS = 1_000;
/** Levels a location tree may have: a region, a site, a building, a floor, a zone. */
export const SLOTLOCK_MAX_LOCATION_DEPTH = 5;
/** Groups a tenant may have. */
export const SLOTLOCK_MAX_RESOURCE_GROUPS = 500;
/** Groups one resource may be in. */
export const SLOTLOCK_MAX_GROUPS_PER_RESOURCE = 20;
/** A location's or a group's reference, as a pool's: 1-100 of a-z, 0-9, `.`, `_` and `-`. */
export const SLOTLOCK_GROUPING_REF = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** A place a tenant's resources are at. */
export interface SlotlockLocation {
  ref: string;
  name: string;
  /** The location it is in; null at the top. */
  parentRef: string | null;
  /** The time zone a resource created here without its own takes; null to take its parent's. */
  timezone: string | null;
  /** How many resources are at it (not counting those below it). */
  resources: number;
}

/** A set of a tenant's resources. */
export interface SlotlockResourceGroup {
  ref: string;
  name: string;
  description: string | null;
  /** How many resources are in it. */
  members: number;
}

function invalidGrouping(code: 'invalid_location' | 'invalid_group', field: string, message: string) {
  return Object.assign(new Error(`Slotlock ${code === 'invalid_location' ? 'location' : 'group'} ${field} ${message}`), {
    code,
    field,
  });
}

function groupingRef(code: 'invalid_location' | 'invalid_group', field: string, value: unknown): string {
  if (typeof value !== 'string' || !SLOTLOCK_GROUPING_REF.test(value)) {
    throw invalidGrouping(code, field, 'must be 1-100 of a-z, 0-9, ".", "_" and "-", starting with a letter or digit');
  }
  return value;
}

function groupingName(code: 'invalid_location' | 'invalid_group', value: unknown): string {
  try {
    const name = text('name', value, SLOTLOCK_RESOURCE_PROFILE_LIMITS.name, false);
    if (name === null) throw invalid('name', 'must be given');
    return name;
  } catch (error) {
    throw invalidGrouping(code, 'name', (error as Error).message.replace(/^Slotlock resource name /, ''));
  }
}

/** Check a location as it is to be stored: refused with `invalid_location`, naming the field. */
export function parseSlotlockLocation(input: {
  ref: string;
  name?: string;
  parentRef?: string | null;
  timezone?: string | null;
}): { ref: string; name?: string; parentRef?: string | null; timezone?: string | null } {
  const location: { ref: string; name?: string; parentRef?: string | null; timezone?: string | null } = {
    ref: groupingRef('invalid_location', 'ref', input.ref),
  };
  if (input.name !== undefined) location.name = groupingName('invalid_location', input.name);
  if (input.parentRef !== undefined) {
    location.parentRef = input.parentRef === null ? null : groupingRef('invalid_location', 'parent', input.parentRef);
    if (location.parentRef === location.ref) throw invalidGrouping('invalid_location', 'parent', 'must not be itself');
  }
  if (input.timezone !== undefined) {
    if (input.timezone !== null) {
      try {
        if (typeof input.timezone !== 'string' || input.timezone.length > 100) throw new Error('no');
        new Intl.DateTimeFormat('en-GB', { timeZone: input.timezone }).format(0);
      } catch {
        throw invalidGrouping('invalid_location', 'timezone', 'must be an IANA time zone, or null');
      }
    }
    location.timezone = input.timezone;
  }
  return location;
}

/** Check a group as it is to be stored: refused with `invalid_group`, naming the field. */
export function parseSlotlockResourceGroup(input: {
  ref: string;
  name: string;
  description?: string | null;
}): { ref: string; name: string; description: string | null } {
  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    try {
      description = text('description', input.description, SLOTLOCK_RESOURCE_PROFILE_LIMITS.description, true);
    } catch (error) {
      throw invalidGrouping('invalid_group', 'description', (error as Error).message.replace(/^Slotlock resource description /, ''));
    }
  }
  return {
    ref: groupingRef('invalid_group', 'ref', input.ref),
    name: groupingName('invalid_group', input.name),
    description,
  };
}

/** Check a location or group reference given to find one: refused as its own kind's. */
export function slotlockGroupingRef(code: 'invalid_location' | 'invalid_group', value: unknown): string {
  return groupingRef(code, 'ref', value);
}

/**
 * The order a pool booking tries a pool's members in (RFC 0003 G7): `stable`, by id (the default);
 * `least_booked`, fewest bookings made on each in the last 30 days first, to share them out;
 * `round_robin`, from the member after the one booked last.
 */
export const SLOTLOCK_POOL_ORDERS = Object.freeze(['stable', 'least_booked', 'round_robin'] as const);

/** Pools a tenant may set an order for (`pool_order_limit_reached` for one more). */
export const SLOTLOCK_MAX_POOL_SETTINGS = 1_000;

export type SlotlockPoolOrder = (typeof SLOTLOCK_POOL_ORDERS)[number];

/** Locations, and groups, a key limited to part of its tenant may name (RFC 0003 G6), each. */
export const SLOTLOCK_MAX_KEY_SCOPE_REFS = 20;

/** A key limited to part of its tenant (RFC 0003 G6): the locations and groups it reaches. */
export interface SlotlockResourceScope {
  locations: readonly string[];
  groups: readonly string[];
}

/** Whether `value` is a resource scope: location and group references, at least one, each list bounded. */
export function isSlotlockResourceScope(value: unknown): value is SlotlockResourceScope {
  const scope = value as SlotlockResourceScope | null;
  const refs = (list: unknown) =>
    Array.isArray(list) &&
    list.length <= SLOTLOCK_MAX_KEY_SCOPE_REFS &&
    list.every((ref) => typeof ref === 'string' && SLOTLOCK_GROUPING_REF.test(ref));
  return (
    typeof scope === 'object' &&
    scope !== null &&
    refs(scope.locations) &&
    refs(scope.groups) &&
    scope.locations.length + scope.groups.length > 0
  );
}
