// The REST API over the operation registry. Each route is one tool: reads and DELETE take their input
// from the query string, POST and PATCH from a JSON body, and the event id from the path. The OpenAPI
// 3.1 document is built from the same input and output schemas the MCP tools advertise, so the two
// cannot describe different contracts.
import type { SlotlockAgentOperation } from './agent-server.js';

export interface SlotlockRestRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Relative to the server's base URL; `{event_id}` is one path segment. */
  path: string;
  operation: SlotlockAgentOperation;
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

/** Where an operation's arguments come from. */
export function restInputFromBody(route: SlotlockRestRoute): boolean {
  return route.method === 'POST' || route.method === 'PATCH';
}

export type SlotlockRestMatch =
  | { route: SlotlockRestRoute; params: Record<string, string> }
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

/** The route for a method and path, the methods the path does have, or nothing. */
export function matchSlotlockRestRoute(method: string, path: string): SlotlockRestMatch {
  const segments = path.split('/');
  const allow: string[] = [];
  let hit: { route: SlotlockRestRoute; params: Record<string, string> } | null = null;
  for (const route of SLOTLOCK_REST_ROUTES) {
    const params = matchPath(route.path, segments);
    if (!params) continue;
    allow.push(route.method);
    if (route.method === method) hit = { route, params };
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

/** The OpenAPI 3.1 document for the REST routes, from the tools' own schemas. */
export function slotlockOpenApiDocument(args: {
  publicBaseUrl: string;
  version: string;
  tools: readonly {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
  }[];
}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of SLOTLOCK_REST_ROUTES) {
    const tool = args.tools.find((candidate) => candidate.name === route.operation);
    if (!tool) throw new Error(`Slotlock REST route ${route.path} names no tool`);
    const pathNames = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
    const fields = properties(tool.inputSchema);
    const required = new Set((tool.inputSchema.required ?? []) as string[]);
    const parameters: Record<string, unknown>[] = pathNames.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: fields[name] ?? { type: 'string' },
    }));
    const operation: Record<string, unknown> = {
      operationId: tool.name,
      summary: tool.title,
      description: tool.description,
    };
    if (restInputFromBody(route)) {
      const bodyFields = Object.fromEntries(
        Object.entries(fields).filter(([name]) => !pathNames.includes(name)),
      );
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema:
              pathNames.length === 0
                ? tool.inputSchema
                : {
                    ...tool.inputSchema,
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
    if (parameters.length > 0) operation.parameters = parameters;
    operation.responses = {
      '200': {
        description: 'The operation ran.',
        content: { 'application/json': { schema: tool.outputSchema } },
      },
      '400': ERROR_RESPONSE,
      '401': ERROR_RESPONSE,
      '403': ERROR_RESPONSE,
      ...(route.method === 'GET' ? {} : { '428': ERROR_RESPONSE }),
      '429': ERROR_RESPONSE,
      default: ERROR_RESPONSE,
    };
    paths[route.path] = { ...paths[route.path], [route.method.toLowerCase()]: operation };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Slotlock',
      version: args.version,
      description:
        'Calendars agents cannot double-book. Each operation is one of the Slotlock MCP tools; ' +
        'an error is `{"error":{"code":…}}`, and a write that waits for a person answers 428 ' +
        '`confirmation_required`.',
    },
    servers: [{ url: args.publicBaseUrl }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'A Slotlock API key (`slk_…`) or the server token.',
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
