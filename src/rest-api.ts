// The REST API over the operation registries. Each agent route is one tool: reads and DELETE take their
// input from the query string, POST, PUT and PATCH from a JSON body, and ids from the path. The
// application operations (application-api.ts) are routes of the same shape. The OpenAPI 3.1 document
// is built from the same input and output schemas the operations validate with, so the two cannot
// describe different contracts.
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
}

export const SLOTLOCK_REST_ROUTES: readonly SlotlockRestRoute[] = Object.freeze([
  { method: 'GET', path: '/v1/resources', operation: 'slotlock_list_resources' },
  { method: 'GET', path: '/v1/free-busy', operation: 'slotlock_get_free_busy' },
  { method: 'GET', path: '/v1/next-available', operation: 'slotlock_find_next_available' },
  { method: 'GET', path: '/v1/events', operation: 'slotlock_list_events' },
  { method: 'POST', path: '/v1/events', operation: 'slotlock_create_event' },
  { method: 'GET', path: '/v1/events/{event_id}', operation: 'slotlock_get_event' },
  { method: 'PATCH', path: '/v1/events/{event_id}', operation: 'slotlock_update_event' },
  { method: 'DELETE', path: '/v1/events/{event_id}', operation: 'slotlock_delete_event' },
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
 * The route for a method and path, the methods the path does have, or nothing. The first route in
 * `routes` that fits wins; no two of Slotlock's routes fit the same path and method (a test checks).
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
 * An operation's input from a query string: an array parameter repeats (`resource_ids=a&resource_ids=b`,
 * OpenAPI's default form style), every other parameter appears once. A parameter the operation does
 * not have, or a repeated one, is passed on as it is, so the operation's strict schema refuses it.
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

/** One operation, as the OpenAPI document needs it. */
export interface SlotlockOpenApiOperation {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
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
  if (parameters.length > 0) result.parameters = parameters;
  result.responses = {
    '200': {
      description: 'The operation ran.',
      content: { 'application/json': { schema: operation.outputSchema } },
    },
    ...extra.responses,
  };
  return result;
}

/** The OpenAPI 3.1 document for the REST routes, from the operations' own schemas. */
export function slotlockOpenApiDocument(args: {
  publicBaseUrl: string;
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
        tag: 'Application',
        scope: SLOTLOCK_APPLICATION_SCOPE,
        responses: {
          '400': ERROR_RESPONSE,
          '401': ERROR_RESPONSE,
          '403': ERROR_RESPONSE,
          '404': ERROR_RESPONSE,
          ...(route.method === 'GET' ? {} : { '409': ERROR_RESPONSE }),
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
        'maintenance) need an API key with the admin scope. An error is `{"error":{"code":…}}`, and ' +
        'a write that waits for a person answers 428 `confirmation_required`.',
    },
    servers: [{ url: args.publicBaseUrl }],
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
            'A Slotlock API key (`slk_…`) or the server token. `x-slotlock-scope` on each operation names the scope it needs.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
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
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  };
}
