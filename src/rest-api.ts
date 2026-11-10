// The REST API over the operation registries: each agent route is one tool (reads and DELETE take
// query input, POST/PUT/PATCH a JSON body, ids from the path), and application operations are
// routes of the same shape. The OpenAPI 3.1 document is built from the operations' own schemas, so
// the two cannot disagree.
import type { SlotlockAgentOperation } from './agent-server.js';
import {
  SLOTLOCK_APPLICATION_OPERATIONS,
  SLOTLOCK_APPLICATION_SCOPE,
  type SlotlockApplicationOperation,
} from './application-api.js';

export interface SlotlockRestRoute<Operation extends string = SlotlockAgentOperation> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the server's base URL; `{name}` is one path segment. */
  path: string;
  operation: Operation;
  /**
   * Store refusals the route can answer beyond the common ones: 404 (missing or another tenant's)
   * and 409 (a conflict with what is stored). Declared in OpenAPI so generated clients type them.
   */
  refusals?: readonly (404 | 409)[];
}

export const SLOTLOCK_REST_ROUTES: readonly SlotlockRestRoute[] = Object.freeze([
  { method: 'GET', path: '/v1/resources', operation: 'slotlock_list_resources' },
  { method: 'GET', path: '/v1/free-busy', operation: 'slotlock_get_free_busy', refusals: [404] },
  {
    method: 'GET',
    path: '/v1/next-available',
    operation: 'slotlock_find_next_available',
    refusals: [404],
  },
  {
    method: 'GET',
    path: '/v1/available-slots',
    operation: 'slotlock_find_available_slots',
    refusals: [404],
  },
  { method: 'POST', path: '/v1/slot-holds', operation: 'slotlock_hold_slots', refusals: [409] },
  { method: 'POST', path: '/v1/bundles', operation: 'slotlock_book_together', refusals: [404, 409] },
  { method: 'POST', path: '/v1/pool-bookings', operation: 'slotlock_book_pool', refusals: [404, 409] },
  {
    method: 'GET',
    path: '/v1/pool-availability',
    operation: 'slotlock_get_pool_availability',
    refusals: [404, 409],
  },
  {
    method: 'DELETE',
    path: '/v1/slot-holds/{hold_id}',
    operation: 'slotlock_release_slots',
    refusals: [409],
  },
  {
    method: 'POST',
    path: '/v1/slot-holds/{hold_id}/confirm',
    operation: 'slotlock_confirm_slot',
    refusals: [404, 409],
  },
  { method: 'GET', path: '/v1/events', operation: 'slotlock_list_events', refusals: [404] },
  { method: 'POST', path: '/v1/events', operation: 'slotlock_create_event', refusals: [404, 409] },
  { method: 'GET', path: '/v1/events/{event_id}', operation: 'slotlock_get_event', refusals: [404] },
  {
    method: 'PATCH',
    path: '/v1/events/{event_id}',
    operation: 'slotlock_update_event',
    refusals: [404, 409],
  },
  {
    method: 'DELETE',
    path: '/v1/events/{event_id}',
    operation: 'slotlock_delete_event',
    refusals: [404, 409],
  },
  {
    method: 'POST',
    path: '/v1/events/{event_id}/reschedule',
    operation: 'slotlock_reschedule',
    refusals: [404, 409],
  },
  {
    method: 'POST',
    path: '/v1/events/{event_id}/cancel',
    operation: 'slotlock_cancel',
    refusals: [404, 409],
  },
]);

/** The application operations' routes, served when the server has an application backend. */
export const SLOTLOCK_APPLICATION_REST_ROUTES: readonly SlotlockRestRoute<SlotlockApplicationOperation>[] =
  Object.freeze(
    SLOTLOCK_APPLICATION_OPERATIONS.map(({ method, path, name }) => ({
      method,
      path,
      operation: name,
    })),
  );

/** Where every REST refusal's documentation is: the Link header's `describedby` target. */
export const SLOTLOCK_PROBLEM_DOCS = 'https://slotlock.pylota.io/docs/api/#errors';

/** A problem type's identifier: a tag URI (RFC 4151), stable, one per code, not a locator. */
export function slotlockProblemType(code: string): string {
  return `tag:slotlock.pylota.io,2026:problem:${code}`;
}

const PROBLEM_TITLES: Readonly<Record<string, string>> = Object.freeze({
  overlap: 'The time is taken',
  idempotency_conflict: 'Idempotency-Key is already used',
  idempotency_key_required: 'Idempotency-Key is missing',
  idempotency_key_not_supported: 'Idempotency-Key is not taken here',
  revision_conflict: 'The revision is stale',
  confirmation_required: 'A person must confirm this write',
  rate_limited: 'Too many requests',
  quota_exceeded: 'The monthly quota is used up',
  authentication_required: 'Authentication required',
  forbidden: 'Not allowed',
  invalid_arguments: 'The arguments are not valid',
});

const STATUS_TITLES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
});

/**
 * A REST refusal as RFC 9457 problem details: `type` and `title` name the problem, `code` is
 * Slotlock's code, and `error.code` repeats it for older clients. `extensions` add context, such as
 * the interval an overlap refused.
 */
export function slotlockProblem(
  status: number,
  code: string,
  extensions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: slotlockProblemType(code),
    title: PROBLEM_TITLES[code] ?? STATUS_TITLES[status] ?? 'Error',
    status,
    code,
    ...extensions,
    error: { code },
  };
}

/**
 * The Idempotency-Key header's value: a Structured Field String (RFC 9651, per
 * draft-ietf-httpapi-idempotency-key-header-08), or a bare token as older clients send. `null` for
 * a quoted string that does not parse.
 */
export function parseIdempotencyKeyHeader(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let key = '';
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index] as string;
    if (char === '\\') {
      const next = trimmed[index + 1];
      if (next !== '"' && next !== '\\') return null;
      key += next;
      index++;
    } else if (char === '"') {
      return index === trimmed.length - 1 ? key : null;
    } else if (char < ' ' || char > '~') {
      return null;
    } else {
      key += char;
    }
  }
  return null;
}

/** Where an operation's arguments come from. */
export function restInputFromBody(route: { method: string }): boolean {
  return route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH';
}

export type SlotlockRestMatch<Operation extends string = SlotlockAgentOperation> =
  | { route: SlotlockRestRoute<Operation>; params: Record<string, string> }
  | { allow: readonly string[] }
  | { invalid: true }
  | null;

/** The path's parameters when it fits `pattern`, else `null`. */
function matchPath(pattern: string, segments: readonly string[]): Record<string, string> | null {
  const parts = pattern.split('/');
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    const segment = segments[index] as string;
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name === undefined) {
      if (part !== segment) return null;
    } else if (segment === '') {
      return null;
    } else {
      params[name] = segment;
    }
  }
  return params;
}

/**
 * The route for a method and path, the methods the path does have, or nothing. First fit wins; a
 * test checks no two routes fit the same path and method.
 */
export function matchSlotlockRestRoute<Operation extends string = SlotlockAgentOperation>(
  method: string,
  path: string,
  routes: readonly SlotlockRestRoute<Operation>[] = SLOTLOCK_REST_ROUTES as unknown as readonly SlotlockRestRoute<Operation>[],
): SlotlockRestMatch<Operation> {
  const segments = path.split('/');
  const allow: string[] = [];
  let hit: { route: SlotlockRestRoute<Operation>; params: Record<string, string> } | null = null;
  for (const route of routes) {
    const params = matchPath(route.path, segments);
    if (!params) continue;
    if (!allow.includes(route.method)) allow.push(route.method);
    if (route.method === method && !hit) hit = { route, params };
  }
  if (!hit) return allow.length > 0 ? { allow } : null;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(hit.params)) {
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      return { invalid: true };
    }
  }
  return { route: hit.route, params };
}

type JsonSchema = Record<string, unknown>;

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema.properties ?? {}) as Record<string, JsonSchema>;
}

function typeOf(schema: JsonSchema | undefined): string | undefined {
  const type = schema?.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((candidate) => candidate !== 'null');
  return undefined;
}

/** A query value as its schema reads it; anything else is left as text for the schema to refuse. */
function queryValue(value: string, schema: JsonSchema | undefined): unknown {
  const type = typeOf(schema);
  if ((type === 'integer' || type === 'number') && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

/**
 * An operation's input from a query string: array parameters repeat (OpenAPI's default form style),
 * others appear once. Unknown or repeated parameters pass through so the strict schema refuses
 * them.
 */
export function restQueryInput(
  search: URLSearchParams,
  inputSchema: JsonSchema,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const fields = properties(inputSchema);
  for (const name of new Set(search.keys())) {
    const values = search.getAll(name);
    const schema = fields[name];
    if (typeOf(schema) === 'array') {
      const items = schema?.items as JsonSchema | undefined;
      input[name] = values.map((value) => queryValue(value, items));
    } else {
      input[name] = values.length === 1 ? queryValue(values[0] as string, schema) : values;
    }
  }
  return input;
}

const ERROR_RESPONSE = { $ref: '#/components/responses/Error' };

const IDEMPOTENCY_KEY_HEADER =
  'Stands in for idempotency_key: a Structured Field String (`"8e03978e-40d5-43e8-bc93-6894a57f9324"`, ' +
  'draft-ietf-httpapi-idempotency-key-header-08) or the bare key; when both are sent they must be equal. ' +
  'A retry with the same key and request answers what the first did; the same key with another request is ' +
  '422 idempotency_conflict. An event write keeps its key for 30 days (maintenance removes it after that), ' +
  'a hold until the hold would have expired, is released or is confirmed. Where the key is required and ' +
  'neither is sent: 400 idempotency_key_required.';

/** One operation, as the OpenAPI document needs it. */
export interface SlotlockOpenApiOperation {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** An operation's own scope: a tool's, or the partner API's (else the application scope). */
  scope?: string;
}

/** The OpenAPI operation object for one route. */
function openApiOperation(
  route: { method: string; path: string },
  operation: SlotlockOpenApiOperation,
  extra: { tag: string; scope: string; responses: Record<string, unknown> },
): Record<string, unknown> {
  const pathNames = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
  const fields = properties(operation.inputSchema);
  const required = new Set((operation.inputSchema.required ?? []) as string[]);
  const parameters: Record<string, unknown>[] = pathNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: fields[name] ?? { type: 'string' },
  }));
  const result: Record<string, unknown> = {
    operationId: operation.name,
    summary: operation.title,
    description: operation.description,
    tags: [extra.tag],
    'x-slotlock-scope': extra.scope,
  };
  if (restInputFromBody(route)) {
    const bodyFields = Object.fromEntries(
      Object.entries(fields).filter(([name]) => !pathNames.includes(name)),
    );
    result.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema:
            pathNames.length === 0
              ? operation.inputSchema
              : {
                  ...operation.inputSchema,
                  properties: bodyFields,
                  required: [...required].filter((name) => !pathNames.includes(name)),
                },
        },
      },
    };
  } else {
    for (const [name, schema] of Object.entries(fields)) {
      if (pathNames.includes(name)) continue;
      parameters.push({ name, in: 'query', required: required.has(name), schema });
    }
  }
  // A write that keeps a retry identity also takes it as the Idempotency-Key header.
  const keyed = fields.idempotency_key !== undefined;
  if (keyed) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: IDEMPOTENCY_KEY_HEADER,
      schema: { type: 'string', minLength: 1, maxLength: 502 },
    });
  }
  if (parameters.length > 0) result.parameters = parameters;
  result.responses = {
    '200': {
      description: 'The operation ran.',
      content: { 'application/json': { schema: operation.outputSchema } },
    },
    ...extra.responses,
    ...(keyed ? { '422': ERROR_RESPONSE } : {}),
  };
  return result;
}

/** The OpenAPI 3.1 document for the REST routes, from the operations' own schemas. */
export function slotlockOpenApiDocument(args: {
  /** Where the server is; without it, the `{baseUrl}` server variable. */
  publicBaseUrl?: string;
  version: string;
  tools: readonly (SlotlockOpenApiOperation & { scope?: string })[];
  /** The application operations, when the server serves them. */
  application?: readonly SlotlockOpenApiOperation[];
}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (route: { method: string; path: string }, operation: Record<string, unknown>) => {
    paths[route.path] = { ...paths[route.path], [route.method.toLowerCase()]: operation };
  };
  for (const route of SLOTLOCK_REST_ROUTES) {
    const tool = args.tools.find((candidate) => candidate.name === route.operation);
    if (!tool) throw new Error(`Slotlock REST route ${route.path} names no tool`);
    add(
      route,
      openApiOperation(route, tool, {
        tag: 'Agent tools',
        scope: tool.scope ?? (route.method === 'GET' ? 'read' : 'write'),
        responses: {
          '400': ERROR_RESPONSE,
          '401': ERROR_RESPONSE,
          '403': ERROR_RESPONSE,
          ...Object.fromEntries((route.refusals ?? []).map((status) => [status, ERROR_RESPONSE])),
          ...(route.method === 'GET' ? {} : { '428': ERROR_RESPONSE }),
          '429': ERROR_RESPONSE,
          default: ERROR_RESPONSE,
        },
      }),
    );
  }
  for (const route of args.application ? SLOTLOCK_APPLICATION_REST_ROUTES : []) {
    const operation = args.application?.find((candidate) => candidate.name === route.operation);
    if (!operation) throw new Error(`Slotlock REST route ${route.path} names no operation`);
    add(
      route,
      openApiOperation(route, operation, {
        tag: operation.scope === 'partner' ? 'Partner' : 'Application',
        scope: operation.scope === 'partner' ? 'partner' : SLOTLOCK_APPLICATION_SCOPE,
        responses: {
          '400': ERROR_RESPONSE,
          '401': ERROR_RESPONSE,
          '403': ERROR_RESPONSE,
          '404': ERROR_RESPONSE,
          ...(route.method === 'GET' ? {} : { '409': ERROR_RESPONSE }),
          ...(route.operation === 'slotlock_list_changes' ? { '410': ERROR_RESPONSE } : {}),
          '429': ERROR_RESPONSE,
          default: ERROR_RESPONSE,
        },
      }),
    );
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Slotlock',
      version: args.version,
      description:
        'Calendars agents cannot double-book. The "Agent tools" operations are the Slotlock MCP tools; ' +
        'the "Application" operations (resources, bookable hours, holds, reservations, coverage and ' +
        'maintenance) need an API key with the admin scope. An error is RFC 9457 problem details ' +
        '(`application/problem+json`) whose `code` names it, also as `{"error":{"code":…}}`; an overlap ' +
        'names the `resource_id`, `start` and `end` it refused. A write that waits for a person answers 428 ' +
        '`confirmation_required`.',
    },
    servers: [
      args.publicBaseUrl !== undefined
        ? { url: args.publicBaseUrl }
        : {
            url: '{baseUrl}',
            variables: {
              baseUrl: {
                default: 'http://localhost:8080',
                description: "The server's public URL (SLOTLOCK_PUBLIC_URL), without a trailing slash.",
              },
            },
          },
    ],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Agent tools', description: 'What an agent does: the MCP tools and A2A skills.' },
      ...(args.application
        ? [
            {
              name: 'Application',
              description:
                'What the application around the agents does. Needs the admin scope; never offered to agents.',
            },
            {
              name: 'Partner',
              description:
                "What a partner reselling Slotlock does for its own users' accounts. Needs a partner key (`slk_partner_…`), whose `partner` scope reaches nothing else.",
            },
          ]
        : []),
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A Slotlock API key (`slk_…`, or `slk_test_…` for a test environment), a partner key (`slk_partner_…`; with a `Slotlock-Account` field naming one of its accounts, where its contract allows, it acts as that account) or the server token. `x-slotlock-scope` on each operation names the scope it needs.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          description: 'RFC 9457 problem details.',
          required: ['type', 'title', 'status', 'code', 'error'],
          properties: {
            type: { type: 'string', description: 'The problem type: a tag URI, one per code.' },
            title: { type: 'string' },
            status: { type: 'integer' },
            code: { type: 'string', description: 'Why the operation did not run.' },
            resource_id: { type: 'string', description: 'An overlap: the resource it refused.' },
            start: { type: 'string', description: 'An overlap: the start it refused.' },
            end: { type: 'string', description: 'An overlap: the end it refused.' },
            busy_start: {
              type: 'string',
              description: 'An overlap: when the booking in the way makes the time busy, from (buffers included).',
            },
            busy_end: { type: 'string', description: 'An overlap: until when that booking makes it busy.' },
            conflicting_hold_id: {
              type: 'string',
              description: 'An overlap with a hold of your own: its id, to book or release it.',
            },
            conflicting_event_id: {
              type: 'string',
              description: 'An overlap with an event of your own: its id, to move or cancel it.',
            },
            alternatives: {
              type: 'array',
              maxItems: 3,
              description:
                'A refusal another time can answer (overlap, pool_full, a booking rule): the earliest free times of the same length, within 7 days of the time asked for, checked as slotlock_find_available_slots checks them. Suggestions, not holds. Empty when none was found.',
              items: {
                type: 'object',
                required: ['resource_id', 'start', 'end'],
                properties: {
                  resource_id: { type: 'string' },
                  start: { type: 'string', format: 'date-time' },
                  end: { type: 'string', format: 'date-time' },
                  resource_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'A bundle or pool booking: the resources free together then.',
                  },
                },
              },
            },
            issues: {
              type: 'array',
              description:
                '`invalid_arguments` from argument validation: each field it refused (at most 20), by its path in the arguments, outermost first; `[]` is the arguments as a whole.',
              items: {
                type: 'object',
                required: ['path', 'message'],
                properties: {
                  path: { type: 'array', items: { type: ['string', 'integer'] } },
                  message: { type: 'string' },
                },
              },
            },
            error: {
              type: 'object',
              required: ['code'],
              properties: { code: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        Error: {
          description: 'The operation did not run; `code` says why.',
          headers: {
            Link: {
              description: 'Where the error codes are documented (`rel="describedby"`).',
              schema: { type: 'string' },
            },
          },
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Error' } },
          },
        },
      },
    },
  };
}
