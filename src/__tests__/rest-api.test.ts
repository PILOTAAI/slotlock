// The REST API: each route is one operation of the registry MCP and A2A serve, behind the same
// authentication, scopes, `authorize`, confirmation and rate limits. /openapi.json describes it.
import { Validator } from '@seriousme/openapi-schema-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  SlotlockAgentOperationError,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
  slotlockAgentTools,
} from '../agent-server.js';
import { SLOTLOCK_REST_ROUTES } from '../rest-api.js';

const listResources = vi.fn();
const listEvents = vi.fn();
const getEvent = vi.fn();
const createEvent = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();
const backend = {
  listResources,
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
} as unknown as SlotlockAgentCalendarBackend;
const authorize = vi.fn();
const consumeRateLimit = vi.fn();
const onEvent = vi.fn();

const BASE = 'https://calendar.example.com/slotlock';
const EVENT_ID = 'agent:5e8ff9bf55ba3508199d22e984129be6b5b6a8a7e3e5f1f0d2b9ba0c4a6f7e21';
const EVENT = {
  id: EVENT_ID,
  resource_id: 'vehicle-1',
  starts_at: '2027-03-02T09:00:00Z',
  ends_at: '2027-03-02T10:00:00Z',
  timezone: 'Europe/London',
  title: 'Vehicle handover',
  description: null,
  location: null,
  organizer: null,
  attendees: [],
  reminders: [],
  status: 'confirmed',
  transparency: 'opaque',
  sequence: 0,
  revision: 1,
  recurrence_rule: null,
  recurrence_exceptions: [],
  recurrence_id: null,
};
const BOOKING = {
  resource_id: 'vehicle-1',
  starts_at: '2027-03-02T09:00:00Z',
  ends_at: '2027-03-02T10:00:00Z',
  timezone: 'Europe/London',
  title: 'Vehicle handover',
  idempotency_key: 'handover-2027-03-02',
};

function buildServer(overrides: Partial<SlotlockAgentServerOptions> = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: BASE,
    backend,
    authenticate: async (request) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer full') return { subject: 'agent-1', tenantRef: 'tenant-a' };
      if (token === 'Bearer reader') {
        return { subject: 'agent-2', tenantRef: 'tenant-a', scopes: ['read'] };
      }
      return null;
    },
    authorize,
    health: async () => ({ ready: true, checks: [] }),
    allowedOrigins: ['https://app.example.com'],
    consumeRateLimit,
    onEvent,
    rest: true,
    ...overrides,
  });
}

function call(
  method: string,
  path: string,
  init: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Request {
  const { body, token = 'full', headers = {} } = init;
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

const principal = { subject: 'agent-1', tenantRef: 'tenant-a' };

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockResolvedValue(true);
  consumeRateLimit.mockResolvedValue(true);
  listResources.mockResolvedValue({
    resources: [{ id: 'vehicle-1', external_ref: 'vehicle-42', timezone: 'Europe/London' }],
    next_cursor: null,
  });
  listEvents.mockResolvedValue({ events: [EVENT], next_cursor: null });
  getEvent.mockResolvedValue({ event: EVENT });
  createEvent.mockResolvedValue({ event: EVENT, replayed: false });
  updateEvent.mockResolvedValue({ event: { ...EVENT, revision: 2 }, replayed: false });
  deleteEvent.mockResolvedValue({
    event_id: EVENT_ID,
    revision: 2,
    deleted: true,
    replayed: false,
  });
});

describe('the REST API switch', () => {
  it('serves nothing under /v1 or at /openapi.json unless `rest` is on', async () => {
    const server = buildServer({ rest: false });
    expect((await server.fetch(call('GET', '/v1/resources'))).status).toBe(404);
    expect((await server.fetch(call('GET', '/openapi.json'))).status).toBe(404);
    expect(listResources).not.toHaveBeenCalled();
  });
});

describe('the OpenAPI document', () => {
  it('is OpenAPI 3.1 that a validator accepts, served without a credential', async () => {
    const response = await buildServer().fetch(call('GET', '/openapi.json', { token: null }));
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;
    const validator = new Validator();
    const result = await validator.validate(document);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
    expect(document.servers).toEqual([{ url: BASE }]);
    expect(document.security).toEqual([{ bearer: [] }]);
  });

  it('has one operation per tool, with its input and output schemas', async () => {
    const document = (await (
      await buildServer().fetch(call('GET', '/openapi.json', { token: null }))
    ).json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const tools = slotlockAgentTools();
    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    expect(operations.map((operation) => operation.operationId).sort()).toEqual(
      tools.map((tool) => tool.name).sort(),
    );
    for (const route of SLOTLOCK_REST_ROUTES) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()];
      const tool = tools.find((candidate) => candidate.name === route.operation);
      expect(operation?.operationId).toBe(route.operation);
      expect(operation?.summary).toBe(tool?.title);
      expect(
        (operation?.responses as Record<string, { content: Record<string, { schema: unknown }> }>)[
          '200'
        ]?.content['application/json']?.schema,
      ).toEqual(tool?.outputSchema);
    }
    const create = document.paths['/v1/events']?.post as {
      requestBody: { required: boolean; content: Record<string, { schema: unknown }> };
    };
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content['application/json']?.schema).toEqual(
      tools.find((tool) => tool.name === 'slotlock_create_event')?.inputSchema,
    );
    const update = document.paths['/v1/events/{event_id}']?.patch as {
      parameters: { name: string; in: string; required: boolean }[];
      requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> };
    };
    expect(update.parameters).toContainEqual(
      expect.objectContaining({ name: 'event_id', in: 'path', required: true }),
    );
    expect(update.requestBody.content['application/json']?.schema.properties).not.toHaveProperty(
      'event_id',
    );
    const removal = document.paths['/v1/events/{event_id}']?.delete as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(removal.parameters.map(({ name, in: where }) => `${where}:${name}`).sort()).toEqual([
      'path:event_id',
      'query:expected_revision',
      'query:idempotency_key',
    ]);
    const list = document.paths['/v1/events']?.get as {
      parameters: { name: string; required: boolean; schema: { type: string } }[];
    };
    expect(list.parameters.find(({ name }) => name === 'resource_ids')).toMatchObject({
      required: true,
      schema: { type: 'array' },
    });
  });
});

describe('a REST call', () => {
  it('needs a credential, and says how to send one', async () => {
    const response = await buildServer().fetch(call('GET', '/v1/resources', { token: null }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="slotlock"');
    expect(await errorCode(response)).toBe('authentication_required');
    expect(listResources).not.toHaveBeenCalled();
  });

  it('reads with query parameters, decoded by the operation input schema', async () => {
    const server = buildServer();
    const resources = await server.fetch(call('GET', '/v1/resources'));
    expect(resources.status).toBe(200);
    expect(await resources.json()).toEqual(await listResources.mock.results[0]?.value);
    expect(listResources).toHaveBeenCalledWith(
      expect.objectContaining({ principal, operation: 'slotlock_list_resources' }),
      { limit: 50 },
    );
    const query =
      '?resource_ids=vehicle-1&resource_ids=vehicle-2&start=2027-03-01T00:00:00Z&end=2027-03-08T00:00:00Z&limit=10';
    const events = await server.fetch(call('GET', `/v1/events${query}`));
    expect(events.status).toBe(200);
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ principal }), {
      resource_ids: ['vehicle-1', 'vehicle-2'],
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-08T00:00:00Z',
      limit: 10,
    });
    // A list of one is still a list.
    const single = '?resource_ids=vehicle-1&start=2027-03-01T00:00:00Z&end=2027-03-08T00:00:00Z';
    expect((await server.fetch(call('GET', `/v1/events${single}`))).status).toBe(200);
    expect(listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ principal }), {
      resource_ids: ['vehicle-1'],
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-08T00:00:00Z',
      limit: 50,
    });
  });

  it.each([
    ['an unknown parameter', '/v1/resources?colour=red'],
    ['a number that is not one', '/v1/resources?limit=ten'],
    ['a single value given twice', '/v1/resources?limit=1&limit=2'],
    ['a path that is not percent-encoded right', '/v1/events/agent%E0%A4%A'],
  ])('refuses %s before reaching the backend', async (_name, path) => {
    const response = await buildServer().fetch(call('GET', path));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_arguments');
    expect(listResources).not.toHaveBeenCalled();
    expect(getEvent).not.toHaveBeenCalled();
  });

  it('reads, changes and deletes the event its path names', async () => {
    const server = buildServer();
    const path = `/v1/events/${encodeURIComponent(EVENT_ID)}`;
    expect((await server.fetch(call('GET', path))).status).toBe(200);
    expect(getEvent).toHaveBeenCalledWith(expect.objectContaining({ principal }), {
      event_id: EVENT_ID,
    });
    const changed = await server.fetch(
      call('PATCH', path, {
        body: { expected_revision: 1, title: 'Moved', idempotency_key: 'm-1' },
      }),
    );
    expect(changed.status).toBe(200);
    expect(updateEvent).toHaveBeenCalledWith(expect.objectContaining({ principal }), {
      event_id: EVENT_ID,
      expected_revision: 1,
      title: 'Moved',
      idempotency_key: 'm-1',
    });
    const deleted = await server.fetch(
      call('DELETE', `${path}?expected_revision=2&idempotency_key=d-1`),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      event_id: EVENT_ID,
      revision: 2,
      deleted: true,
      replayed: false,
    });
    expect(deleteEvent).toHaveBeenCalledWith(expect.objectContaining({ principal }), {
      event_id: EVENT_ID,
      expected_revision: 2,
      idempotency_key: 'd-1',
    });
  });

  it('refuses a body that names another event than its path', async () => {
    const response = await buildServer().fetch(
      call('PATCH', `/v1/events/${encodeURIComponent(EVENT_ID)}`, {
        body: { event_id: 'agent:other', expected_revision: 1, title: 'x', idempotency_key: 'k' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_arguments');
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('creates from a JSON body', async () => {
    const response = await buildServer().fetch(call('POST', '/v1/events', { body: BOOKING }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event: EVENT, replayed: false });
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ principal, operation: 'slotlock_create_event' }),
      expect.objectContaining(BOOKING),
    );
  });

  it('refuses a body that is not a JSON object, or too large', async () => {
    const server = buildServer({ maxRequestBytes: 1_024 });
    const untyped = await server.fetch(
      new Request(`${BASE}/v1/events`, {
        method: 'POST',
        headers: { Authorization: 'Bearer full', 'Content-Type': 'text/plain' },
        body: JSON.stringify(BOOKING),
      }),
    );
    expect(untyped.status).toBe(415);
    expect(await errorCode(untyped)).toBe('unsupported_media_type');
    const garbled = await server.fetch(call('POST', '/v1/events', { body: '{"resource_id":' }));
    expect(garbled.status).toBe(400);
    expect(await errorCode(garbled)).toBe('invalid_json');
    const list = await server.fetch(call('POST', '/v1/events', { body: [BOOKING] }));
    expect(list.status).toBe(400);
    expect(await errorCode(list)).toBe('invalid_arguments');
    const large = await server.fetch(
      call('POST', '/v1/events', { body: { ...BOOKING, description: 'x'.repeat(2_000) } }),
    );
    expect(large.status).toBe(413);
    expect(await errorCode(large)).toBe('request_too_large');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('answers a write that waits for a person with confirmation_required, and writes nothing', async () => {
    const server = buildServer({
      confirmation: {
        operations: ['slotlock_create_event'],
        secrets: ['confirmation-secret-0123456789abcdef'],
      },
    });
    const response = await server.fetch(call('POST', '/v1/events', { body: BOOKING }));
    expect(response.status).toBe(428);
    expect(await errorCode(response)).toBe('confirmation_required');
    expect(createEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'slotlock_create_event',
      outcome: 'unavailable',
    });
  });

  it("holds a key to its scopes and to the server's authorize", async () => {
    const server = buildServer();
    const write = await server.fetch(
      call('POST', '/v1/events', { body: BOOKING, token: 'reader' }),
    );
    expect(write.status).toBe(403);
    expect(await errorCode(write)).toBe('forbidden');
    expect(createEvent).not.toHaveBeenCalled();
    expect((await server.fetch(call('GET', '/v1/resources', { token: 'reader' }))).status).toBe(
      200,
    );
    authorize.mockResolvedValueOnce(false);
    const refused = await server.fetch(call('GET', '/v1/resources'));
    expect(refused.status).toBe(403);
    expect(authorize).toHaveBeenLastCalledWith({
      principal,
      operation: 'slotlock_list_resources',
      input: { limit: 50 },
    });
  });

  it('passes a domain error through with its status, and hides an internal one', async () => {
    const server = buildServer();
    createEvent.mockRejectedValueOnce(new SlotlockAgentOperationError('overlap', 409));
    const overlap = await server.fetch(call('POST', '/v1/events', { body: BOOKING }));
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toEqual({ error: { code: 'overlap' } });
    getEvent.mockRejectedValueOnce(new Error('connection reset by 10.0.0.7'));
    const broken = await server.fetch(call('GET', `/v1/events/${encodeURIComponent(EVENT_ID)}`));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: { code: 'internal_error' } });
    listResources.mockResolvedValueOnce({ resources: 'not a list' });
    const malformed = await server.fetch(call('GET', '/v1/resources'));
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: { code: 'internal_error' } });
  });

  it('answers 404 for an unknown path and 405, with Allow, for a method a path lacks', async () => {
    const server = buildServer();
    const missing = await server.fetch(call('GET', '/v1/calendars'));
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('not_found');
    const collection = await server.fetch(call('PUT', '/v1/events', { body: BOOKING }));
    expect(collection.status).toBe(405);
    expect(collection.headers.get('allow')).toBe('GET, POST');
    const item = await server.fetch(call('POST', `/v1/events/${encodeURIComponent(EVENT_ID)}`));
    expect(item.status).toBe(405);
    expect(item.headers.get('allow')).toBe('GET, PATCH, DELETE');
    expect((await server.fetch(call('POST', '/openapi.json'))).headers.get('allow')).toBe('GET');
  });

  it('refuses a browser origin the server does not allow', async () => {
    const response = await buildServer().fetch(
      call('GET', '/v1/resources', { headers: { Origin: 'https://elsewhere.example' } }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('origin_not_allowed');
    expect(listResources).not.toHaveBeenCalled();
    const allowed = await buildServer().fetch(
      call('GET', '/v1/resources', { headers: { Origin: 'https://app.example.com' } }),
    );
    expect(allowed.status).toBe(200);
  });

  it('counts against the same rate limit as MCP and A2A', async () => {
    consumeRateLimit.mockResolvedValueOnce(false);
    const response = await buildServer().fetch(call('GET', '/v1/resources'));
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe('rate_limited');
    expect(consumeRateLimit).toHaveBeenCalledWith({ principal, operation: 'protocol' });
    expect(listResources).not.toHaveBeenCalled();
  });

  it('reports each call by operation and status, never its arguments or caller', async () => {
    const server = buildServer();
    await server.fetch(call('GET', '/v1/resources'));
    createEvent.mockRejectedValueOnce(new SlotlockAgentOperationError('overlap', 409));
    await server.fetch(call('POST', '/v1/events', { body: BOOKING }));
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'rest', operation: 'slotlock_list_resources', status: 200 },
      { type: 'rest', operation: 'slotlock_create_event', status: 409 },
    ]);
  });
});
