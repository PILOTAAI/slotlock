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
