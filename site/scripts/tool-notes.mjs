// What /docs/tools/ says about each tool beyond its schema. scripts/tool-schemas.mjs reads names,
// types, bounds, defaults and examples from src/agent-server.ts; this file adds the words a schema
// cannot carry. scripts/sync-content.mjs fails the build when a note names a tool or field that no
// longer exists, when a tool has no summary, or when an error code is not a code in the source.
//
// Behaviour described here is the store backend's (src/agent-store-backend.ts), the one the
// `slotlock serve` command and the README's server example use.

/** One line per tool for the overview table, and the opening sentence of its section. */
export const SUMMARIES = {
  slotlock_list_resources:
    'List the resources this caller can book: vehicles, rooms, people, machines.',
  slotlock_get_free_busy:
    'Busy intervals for up to 100 resources in a window, and whether each answer is certain.',
  slotlock_find_next_available:
    'The earliest slot of a given length across resources, offered only when the answer is certain.',
  slotlock_create_event:
    'Book time on a resource. If the time is taken, the database refuses it with `overlap`.',
  slotlock_get_event: 'Read one event this caller created.',
  slotlock_list_events: 'List the events this caller created in a window, one page at a time.',
  slotlock_update_event: 'Change an event at the revision you last read.',
  slotlock_delete_event: 'Cancel an event at the revision you last read.',
};

/** A paragraph after the summary, where the schema alone would mislead. */
export const DETAILS = {
  slotlock_get_free_busy:
    'Busy time includes every booking on the resource, whoever made it. Intervals carry times only, never titles or attendees.',
  slotlock_find_next_available:
    'A slot is offered only inside the resource’s bookable hours, and only when the coverage of every resource asked about is `certain`. Otherwise `resource_id`, `start` and `end` are `null`: treat that as unknown, not as free.',
  slotlock_create_event:
    'An opaque event goes through the database’s overlap check; a transparent one stays visible and blocks nothing. A retry with the same `idempotency_key` and arguments returns the first result with `replayed: true`.',
  slotlock_get_event:
    'Only events this caller created are visible. Other bookings on the resource still count as busy time.',
  slotlock_list_events:
    'Only events this caller created are listed, ordered by start. Other bookings on the resource still count as busy time.',
  slotlock_update_event:
    'Send only the fields you change; the others keep their values. The result is the event at its new `revision`.',
  slotlock_delete_event: 'The event becomes a tombstone, so a delayed create cannot bring it back.',
};

/**
 * Field notes, keyed by field name for every tool, or by `tool.field` for one tool. Nested fields
 * of an unnamed object use `parent[].child`; fields of a named object use `OBJECT.field`.
 */
export const INPUT_NOTES = {
  cursor: 'The `next_cursor` of the previous page.',
  limit: 'Page size.',
  resource_ids: 'Resource `id`s from `slotlock_list_resources`.',
  start: 'Start of the window.',
  end: 'End of the window, exclusive.',
  duration_minutes: 'Length of the slot.',
  resource_id: 'An `id` from `slotlock_list_resources`.',
  starts_at: 'When the event starts.',
  ends_at: 'When the event ends, exclusive.',
  timezone: 'IANA time zone, for example `Europe/London`.',
  title: 'What people see. Without one the event is titled Busy.',
  transparency: '`opaque` occupies the time; `transparent` blocks nothing.',
  recurrence_rule:
    'An RFC 5545 RRULE, for example `FREQ=WEEKLY;COUNT=8`: its own parts only, each once (no `X-` parts).',
  recurrence_exceptions: 'Moved or cancelled occurrences of a recurring event.',
  idempotency_key:
    'Your key for this write. Retry with the same key and arguments; the same key with other arguments returns `idempotency_conflict`.',
  event_id: 'The `id` of an event this caller created.',
  expected_revision: 'The `revision` you last read; any other returns `revision_conflict`.',
  'slotlock_update_event.resource_id': 'Moves the event to this resource.',
  'slotlock_update_event.title': '`null` resets it to Busy.',
  'slotlock_update_event.description': '`null` clears it.',
  'slotlock_update_event.location': '`null` clears it.',
  'slotlock_update_event.organizer': '`null` clears it.',
  'slotlock_update_event.attendees': 'Replaces the list.',
  'slotlock_update_event.reminders': 'Replaces the list.',
  'slotlock_update_event.recurrence_rule': '`null` makes it a one-off event.',
  'slotlock_update_event.recurrence_exceptions':
    'Replaces the exceptions of a recurring event; ignored on a one-off event.',
  'RECURRENCE_EXCEPTION_INPUT.recurrence_id': 'The original start of the occurrence.',
  'RECURRENCE_EXCEPTION_INPUT.starts_at': 'New start, unless `cancelled`.',
  'RECURRENCE_EXCEPTION_INPUT.ends_at': 'New end, unless `cancelled`.',
  'REMINDER_INPUT.minutes_before': 'Minutes before the start.',
  'ATTENDEE_INPUT.rsvp': 'Whether a reply is requested.',
};

export const OUTPUT_NOTES = {
  next_cursor: 'Pass it as `cursor` for the next page; `null` on the last page.',
  replayed: '`true` when this call replayed an earlier one with the same `idempotency_key`.',
  event: 'The event as stored.',
  coverage: 'Whether the answer is certain.',
  'slotlock_list_resources.resources[].id': 'Pass it as `resource_id` or in `resource_ids`.',
  'slotlock_list_resources.resources[].external_ref':
    'Your own reference, for example `vehicle-42`.',
  'slotlock_list_resources.resources[].timezone':
    'IANA time zone of the resource’s bookable hours.',
  'slotlock_get_free_busy.resources[].busy': 'Busy time in the window.',
  'slotlock_find_next_available.resource_id':
    'The resource with the earliest slot; `null` when there is none or coverage is uncertain.',
  'slotlock_find_next_available.start': 'Start of the slot, or `null`.',
  'slotlock_find_next_available.end': 'End of the slot, or `null`.',
  'slotlock_list_events.events': 'Ordered by start.',
  'slotlock_delete_event.revision': 'The event’s revision after the delete.',
  'slotlock_delete_event.deleted': 'Always `true`.',
  'EVENT.id': 'Stable id; pass it as `event_id`.',
  'EVENT.revision': 'Pass it as `expected_revision` to update or delete.',
  'EVENT.sequence': 'The iCalendar `SEQUENCE`.',
  'EVENT.title': 'Busy when the event was created without one.',
  'COVERAGE.start': 'Start of the window assessed.',
  'COVERAGE.end': 'End of the window assessed.',
  'COVERAGE.certainty':
    '`certain` only when every source the resource depends on has been read for the whole window.',
  'COVERAGE.reason': '`coverage_incomplete` when uncertain, else `null`.',
  'INTERVAL.start': 'Inclusive.',
  'INTERVAL.end': 'Exclusive.',
  'REMINDER.minutes_before': 'Minutes before the start.',
  'ATTENDEE.rsvp': 'Whether a reply is requested.',
  'RECURRENCE_EXCEPTION.recurrence_id': 'The original start of the occurrence.',
};

/** Named objects, in the order the Objects section lists them. */
export const OBJECTS = {
  EVENT: { name: 'Event', role: 'output' },
  COVERAGE: { name: 'Coverage', role: 'output' },
  INTERVAL: { name: 'Interval', role: 'output' },
  ORGANIZER: { name: 'Organizer', role: 'output' },
  ATTENDEE: { name: 'Attendee', role: 'output' },
  REMINDER: { name: 'Reminder', role: 'output' },
  RECURRENCE_EXCEPTION: { name: 'Recurrence exception', role: 'output' },
  ORGANIZER_INPUT: { name: 'Organizer input', role: 'input' },
  ATTENDEE_INPUT: { name: 'Attendee input', role: 'input' },
  REMINDER_INPUT: { name: 'Reminder input', role: 'input' },
  RECURRENCE_EXCEPTION_INPUT: { name: 'Recurrence exception input', role: 'input' },
};

/** Codes a tool returns besides the ones every tool can (COMMON_ERRORS), most likely first. */
export const TOOL_ERRORS = {
  slotlock_list_resources: [],
  slotlock_get_free_busy: ['resource_not_found'],
  slotlock_find_next_available: ['resource_not_found'],
  slotlock_create_event: [
    'overlap',
    'idempotency_conflict',
    'resource_not_found',
    'invalid_event',
    'owner_event_quota_exceeded',
    'owner_command_quota_exceeded',
    'event_cancelled',
    'revision_conflict',
    'store_inconsistent',
  ],
  slotlock_get_event: ['event_not_found'],
  slotlock_list_events: ['resource_not_found', 'invalid_cursor'],
  slotlock_update_event: [
    'revision_conflict',
    'overlap',
    'idempotency_conflict',
    'event_not_found',
    'resource_not_found',
    'invalid_event',
    'owner_command_quota_exceeded',
    'store_inconsistent',
  ],
  slotlock_delete_event: [
    'revision_conflict',
    'idempotency_conflict',
    'event_not_found',
    'owner_command_quota_exceeded',
  ],
};

/** Every tool: schema validation, `authorize`, `consumeRateLimit`, a request that went away. */
export const COMMON_ERRORS = ['invalid_arguments', 'forbidden', 'rate_limited', 'request_aborted'];

/** Write tools, when the server asks a person to confirm them (`confirmation`). */
export const CONFIRMATION_ERRORS = [
  'confirmation_required',
  'confirmation_declined',
  'confirmation_cancelled',
];

/**
 * Sentences for the `.refine(…)` rules in the registry, matched on the rule's source text. A rule
 * no entry matches fails the build, so a new rule gets a sentence before it ships.
 */
export const REFINEMENTS = [
  {
    matches: (text) => text === 'boundedAgentWindow',
    note: (facts) => `\`end\` must be after \`start\`, at most ${facts.horizonDays} days later.`,
  },
  {
    matches: (text) => text.includes('boundedEventSpan') && text.includes('=== undefined ||'),
    note: (facts) =>
      `If you send both \`starts_at\` and \`ends_at\`, the end must be after the start, at most ${facts.maxEventDaysText} days later.`,
  },
  {
    matches: (text) => text.includes('boundedEventSpan'),
    note: (facts) =>
      `\`ends_at\` must be after \`starts_at\`, at most ${facts.maxEventDaysText} days later.`,
  },
  {
    matches: (text) => text.includes('!== undefined ||'),
    note: () =>
      'Send at least one field to change besides `event_id`, `expected_revision` and `idempotency_key`.',
  },
  {
    matches: (text) => text.includes('value.cancelled ||'),
    note: () =>
      'Unless `cancelled` is `true`, send `starts_at` and `ends_at`, with the end after the start.',
  },
  {
    matches: (text) => /Date\.parse\(value\.end\) > Date\.parse\(value\.start\)/.test(text),
    note: () => '`end` is after `start`.',
  },
];
