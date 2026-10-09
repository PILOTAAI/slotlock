import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES,
  SLOTLOCK_AGENT_SERVER_VERSION,
  SLOTLOCK_MCP_APPS_EXTENSION,
  SLOTLOCK_MCP_APP_MIME_TYPE,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentOperationDispatchOptions,
  SlotlockAgentOperationError,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
  isSlotlockAgentOperation,
  slotlockAgentTools,
  slotlockMcpToolResult,
  parseSlotlockA2ATimestamp,
  resolveSlotlockAgentOperation,
} from '../agent-server.js';

const listResources = vi.fn();
const getFreeBusy = vi.fn();
const findNextAvailable = vi.fn();
const createEvent = vi.fn();
const getEvent = vi.fn();
const listEvents = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();
const authorize = vi.fn();

const backend: SlotlockAgentCalendarBackend = {
  listResources,
  getFreeBusy,
  findNextAvailable,
  createEvent,
  getEvent,
  listEvents,
  updateEvent,
  deleteEvent,
};

function buildServer(overrides: Partial<Parameters<typeof createSlotlockAgentServer>[0]> = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    allowedOrigins: ['http://localhost'],
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer valid'
        ? { subject: 'principal-1', tenantRef: 'tenant-a' }
        : null,
    authorize,
    health: async () => ({ ready: true, checks: ['database', 'worker'] }),
    ...overrides,
  });
}

function buildDispatchOptions(
  overrides: Partial<SlotlockAgentOperationDispatchOptions> = {},
): SlotlockAgentOperationDispatchOptions {
  return {
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer valid'
        ? { subject: 'principal-1', tenantRef: 'tenant-a' }
        : null,
    authorize,
    ...overrides,
  };
}

function rpcRequest(
  body: unknown,
  path = '/slotlock/mcp',
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** An A2A `SendMessage` carrying one data part: the invocation convention the agent card describes. */
function a2aSendMessage(
  data: unknown,
  options: { id?: string | number; headers?: Record<string, string> } = {},
): Request {
  const id = options.id ?? 'a2a-test';
  return rpcRequest(
    {
      jsonrpc: '2.0',
      id,
      method: 'SendMessage',
      params: {
        message: {
          messageId: `message-${id}`,
          role: 'ROLE_USER',
          parts: [{ data, mediaType: 'application/json' }],
        },
      },
    },
    '/slotlock/a2a',
    options.headers ?? { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION },
  );
}

/** The data part of an A2A `SendMessage` reply. */
async function a2aReplyData(response: Response): Promise<unknown> {
  const body = (await response.json()) as {
    result?: { message?: { parts?: Array<{ data?: unknown }> } };
  };
  return body.result?.message?.parts?.[0]?.data;
}

/** The same request with a body that is not JSON. */
function withUnparseableBody(template: Request): Request {
  return new Request(template.url, {
    method: 'POST',
    headers: template.headers,
    body: '{"jsonrpc":',
  });
}

const CREATE_EVENT_ARGUMENTS = {
  resource_id: 'vehicle-1',
  starts_at: '2027-03-02T09:00:00Z',
  ends_at: '2027-03-02T10:00:00Z',
  timezone: 'Europe/London',
  idempotency_key: 'create-1',
};

/** A tool failure: `isError`, the code in the text content, and no `structuredContent` at all. */
function expectToolError(body: unknown, code: string): void {
  const result = (body as { result?: Record<string, unknown> }).result ?? {};
  expect(result.isError).toBe(true);
  expect(result).not.toHaveProperty('structuredContent');
  const [text] = result.content as Array<{ type: string; text: string }>;
  expect(text?.type).toBe('text');
  expect(JSON.parse(text?.text ?? 'null')).toEqual({ error: { code } });
}

describe('consumer-neutral Slotlock agent server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(true);
    listResources.mockResolvedValue({
      resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
      next_cursor: null,
    });
  });

  it('exports one bounded operation dispatcher with the same schemas as the protocol server', async () => {
    expect(isSlotlockAgentOperation('calendar_list_resources')).toBe(true);
    expect(isSlotlockAgentOperation('calendar_list_resources.extra')).toBe(false);
    const request = rpcRequest({});
    const direct = await invokeSlotlockAgentOperation({
      operation: 'calendar_list_resources',
      input: {},
      request,
      options: buildDispatchOptions(),
    });
    expect(direct).toEqual({
      ok: true,
      data: {
        resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
        next_cursor: null,
      },
    });
    expect(listResources).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'calendar_list_resources',
        principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      }),
      { limit: 50 },
    );

    const protocol = await buildServer().fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'dispatcher-parity',
        method: 'tools/call',
        params: { name: 'calendar_list_resources', arguments: {} },
      }),
    );
    expect(await protocol.json()).toMatchObject({
      result: { structuredContent: direct.ok ? direct.data : {} },
    });
    expect(listResources).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'calendar_list_resources',
        principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      }),
      { limit: 50 },
    );
  });

  it('dispatches only after authentication, bounded validation, authorization and rate limiting', async () => {
    const request = rpcRequest({});
    const unauthenticated = await invokeSlotlockAgentOperation({
      operation: 'calendar_list_resources',
      input: {},
      request,
      options: buildDispatchOptions({ authenticate: async () => null }),
    });
    expect(unauthenticated).toEqual({
      ok: false,
      status: 401,
      code: 'authentication_required',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();

    const oversized = await invokeSlotlockAgentOperation({
      operation: 'calendar_get_free_busy',
      input: {
        resource_ids: ['vehicle-1'],
        start: '2027-01-01T00:00:00.000Z',
        end: '2028-01-04T00:00:00.000Z',
      },
      request,
      options: buildDispatchOptions(),
    });
    expect(oversized).toEqual({ ok: false, status: 400, code: 'invalid_arguments' });
    expect(authorize).not.toHaveBeenCalled();
    expect(getFreeBusy).not.toHaveBeenCalled();

    const consumeRateLimit = vi.fn().mockResolvedValue(false);
    const limited = await invokeSlotlockAgentOperation({
      operation: 'calendar_list_resources',
      input: {},
      request,
      options: buildDispatchOptions({ consumeRateLimit }),
    });
    expect(limited).toEqual({ ok: false, status: 429, code: 'rate_limited' });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      operation: 'calendar_list_resources',
    });
    expect(listResources).not.toHaveBeenCalled();
  });

  it('lets an agent search for and book a long rental, up to the event ceiling', async () => {
    const request = rpcRequest({});
    const dispatch = (operation: string, input: Record<string, unknown>) =>
      invokeSlotlockAgentOperation({ operation, input, request, options: buildDispatchOptions() });
    const DAY_MS = 24 * 60 * 60 * 1000;
    const start = '2027-03-01T00:00:00Z';
    const plusDays = (days: number) => new Date(Date.parse(start) + days * DAY_MS).toISOString();

    // A 90-day slot inside a year-long window: the search reaches the backend.
    await dispatch('calendar_find_next_available', {
      resource_ids: ['vehicle-1'],
      start,
      end: plusDays(365),
      duration_minutes: 90 * 24 * 60,
    });
    expect(findNextAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'calendar_find_next_available' }),
      expect.objectContaining({ duration_minutes: 129_600 }),
    );
    // No slot can be longer than the 367-day search window.
    await expect(
      dispatch('calendar_find_next_available', {
        resource_ids: ['vehicle-1'],
        start,
        end: plusDays(367),
        duration_minutes: 367 * 24 * 60 + 1,
      }),
    ).resolves.toEqual({ ok: false, status: 400, code: 'invalid_arguments' });

    await dispatch('calendar_create_event', {
      ...CREATE_EVENT_ARGUMENTS,
      starts_at: start,
      ends_at: plusDays(3_660),
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    for (const [operation, input] of [
      [
        'calendar_create_event',
        { ...CREATE_EVENT_ARGUMENTS, starts_at: start, ends_at: plusDays(3_661) },
      ],
      [
        'calendar_update_event',
        {
          event_id: 'event-1',
          expected_revision: 1,
          starts_at: start,
          ends_at: plusDays(3_661),
          idempotency_key: 'extend-1',
        },
      ],
      [
        'calendar_update_event',
        {
          event_id: 'event-1',
          expected_revision: 1,
          starts_at: plusDays(2),
          ends_at: plusDays(1),
          idempotency_key: 'reverse-1',
        },
      ],
    ] as const) {
      await expect(dispatch(operation, input)).resolves.toEqual({
        ok: false,
        status: 400,
        code: 'invalid_arguments',
      });
    }
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('rejects non-canonical authenticated principal identities before authorization', async () => {
    const request = rpcRequest({});
    for (const principal of [
      { subject: ' principal-1', tenantRef: 'tenant-a' },
      { subject: 'principal-1\u0000alias', tenantRef: 'tenant-a' },
      { subject: 'principal-1', tenantRef: 'tenant-a\nshadow' },
    ]) {
      const outcome = await invokeSlotlockAgentOperation({
        operation: 'calendar_list_resources',
        input: {},
        request,
        options: buildDispatchOptions({ authenticate: async () => principal }),
      });
      expect(outcome).toEqual({
        ok: false,
        status: 401,
        code: 'authentication_required',
      });
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();
  });

  it('exposes bounded health and discovery without claiming unsupported streaming', async () => {
    const server = buildServer();
    const health = await server.fetch(new Request('http://localhost/slotlock/healthz'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ready',
      version: SLOTLOCK_AGENT_SERVER_VERSION,
      checks: ['database', 'worker'],
    });
    const card = await server.fetch(
      new Request('http://localhost/slotlock/.well-known/agent-card.json'),
    );
    expect(await card.json()).toMatchObject({
      capabilities: { streaming: false, pushNotifications: false },
      securitySchemes: {
        bearer: {
          httpAuthSecurityScheme: {
            scheme: 'Bearer',
          },
        },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      skills: expect.arrayContaining([
        expect.objectContaining({ id: 'calendar_create_event' }),
        expect.objectContaining({ id: 'calendar_get_free_busy' }),
      ]),
    });
  });

  it('requires authentication before exposing or executing MCP tools', async () => {
    const server = buildServer();
    const request = rpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    request.headers.delete('authorization');
    const response = await server.fetch(request);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="slotlock"');
    expect(listResources).not.toHaveBeenCalled();
  });

  it('implements the stateless Streamable HTTP GET/DELETE and notification lifecycle', async () => {
    const server = buildServer();
    const hostileGet = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        headers: { Accept: 'text/event-stream', Origin: 'https://attacker.example' },
      }),
    );
    expect(hostileGet.status).toBe(403);
    const malformedOrigin = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        headers: { Accept: 'text/event-stream', Origin: 'http://localhost/not-an-origin' },
      }),
    );
    expect(malformedOrigin.status).toBe(403);

    const get = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        headers: { Accept: 'text/event-stream', Origin: 'http://localhost' },
      }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const remove = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        method: 'DELETE',
        headers: { Origin: 'http://localhost' },
      }),
    );
    expect(remove.status).toBe(405);
    expect(remove.headers.get('allow')).toBe('POST');

    const initialized = await server.fetch(
      rpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe('');

    const cancelled = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'request-1', reason: 'no longer needed' },
      }),
    );
    expect(cancelled.status).toBe(202);
    expect(await cancelled.text()).toBe('');
  });

  it('validates MCP initialize and requires request ids for request methods', async () => {
    const server = buildServer();
    const malformed = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'init-invalid',
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32602 } });

    const initialized = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'init-valid',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'slotlock-test-client', version: '1.0.0' },
        },
      }),
    );
    expect(initialized.status).toBe(200);
    const initializedBody = (await initialized.json()) as {
      result: { protocolVersion: string; capabilities: { extensions?: unknown } };
    };
    expect(initializedBody).toMatchObject({
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });
    expect(initializedBody.result.capabilities.extensions).toBeUndefined();

    const requestWithoutId = await server.fetch(
      rpcRequest({ jsonrpc: '2.0', method: 'tools/list' }),
    );
    expect(requestWithoutId.status).toBe(400);
    expect(await requestWithoutId.json()).toMatchObject({ error: { code: -32600 } });
    expect(listResources).not.toHaveBeenCalled();
  });

  it('negotiates the stable MCP Apps extension without changing text-only MCP behavior', async () => {
    const server = buildServer();
    const initialized = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'apps-initialize',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {
            extensions: {
              [SLOTLOCK_MCP_APPS_EXTENSION]: { mimeTypes: [SLOTLOCK_MCP_APP_MIME_TYPE] },
            },
          },
          clientInfo: { name: 'apps-host', version: '1.0.0' },
        },
      }),
    );

    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: {
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            [SLOTLOCK_MCP_APPS_EXTENSION]: { mimeTypes: [SLOTLOCK_MCP_APP_MIME_TYPE] },
          },
        },
      },
    });

    const listed = await server.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 'apps-tools', method: 'tools/list' }),
    );
    const tools = (await listed.json()) as {
      result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
    };
    expect(tools.result.tools.find((tool) => tool.name === 'calendar_get_free_busy')).toMatchObject(
      {
        _meta: {
          ui: {
            resourceUri: SLOTLOCK_MCP_APP_RESOURCE_URI,
            visibility: ['model', 'app'],
          },
        },
      },
    );
    expect(
      tools.result.tools.find((tool) => tool.name === 'calendar_create_event'),
    ).not.toHaveProperty('_meta');
  });

  it('serves one self-contained, network-dark calendar UI through MCP resources', async () => {
    const server = buildServer();
    const listed = await server.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 'resources-list', method: 'resources/list' }),
    );
    expect(await listed.json()).toEqual({
      jsonrpc: '2.0',
      id: 'resources-list',
      result: {
        resources: [
          {
            uri: SLOTLOCK_MCP_APP_RESOURCE_URI,
            name: 'Slotlock calendar',
            description: 'Inspect resource availability and calendar results inside an MCP host.',
            mimeType: SLOTLOCK_MCP_APP_MIME_TYPE,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                  frameDomains: [],
                  baseUriDomains: [],
                },
                prefersBorder: true,
              },
            },
          },
        ],
      },
    });

    const read = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'resources-read',
        method: 'resources/read',
        params: { uri: SLOTLOCK_MCP_APP_RESOURCE_URI },
      }),
    );
    const body = (await read.json()) as {
      result: { contents: Array<{ uri: string; mimeType: string; text: string; _meta: unknown }> };
    };
    expect(body.result.contents).toHaveLength(1);
    expect(body.result.contents[0]).toMatchObject({
      uri: SLOTLOCK_MCP_APP_RESOURCE_URI,
      mimeType: SLOTLOCK_MCP_APP_MIME_TYPE,
    });
    const html = body.result.contents[0]?.text ?? '';
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('ui/initialize');
    expect(html).toContain('ui/notifications/initialized');
    expect(html).toContain('ui/notifications/tool-result');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('textContent');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(body.result.contents[0]?._meta)).not.toMatch(/https?:\/\//);
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();

    const unknown = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 'resources-unknown',
        method: 'resources/read',
        params: { uri: 'ui://slotlock/unknown' },
      }),
    );
    expect(await unknown.json()).toMatchObject({ error: { code: -32002 } });
  });

  it('binds tenant identity to the authenticated principal and rejects request substitution', async () => {
    const server = buildServer();
    const response = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'calendar_list_resources',
          arguments: { limit: 5, tenantRef: 'tenant-b' },
        },
      }),
    );
    expect(response.status).toBe(200);
    expectToolError(await response.json(), 'invalid_arguments');
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();
  });

  it('validates backend output and passes only the bound tenant context', async () => {
    const server = buildServer();
    const good = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'calendar_list_resources', arguments: { limit: 5 } },
      }),
    );
    expect(good.status).toBe(200);
    expect(listResources).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'calendar_list_resources',
        principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      }),
      { limit: 5 },
    );
    expect(await good.json()).toMatchObject({
      result: { structuredContent: { resources: expect.any(Array), next_cursor: null } },
    });

    listResources.mockResolvedValueOnce({ resources: [{ id: 'unbounded' }], secret: 'leak' });
    const invalid = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'calendar_list_resources', arguments: {} },
      }),
    );
    expect(invalid.status).toBe(500);
    const invalidBody = await invalid.json();
    // A backend returning an undeclared shape is a server fault: a JSON-RPC error, never a result.
    expect(invalidBody).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(JSON.stringify(invalidBody)).not.toContain('secret');
  });

  it('serializes every event field admitted by the trusted store byte bounds', async () => {
    const recurrenceExceptions = Array.from({ length: 1_000 }, (_, index) => ({
      recurrence_id: new Date(Date.UTC(2027, 0, 1, 0, index)).toISOString(),
      cancelled: true,
      starts_at: null,
      ends_at: null,
    }));
    getEvent.mockResolvedValueOnce({
      event: {
        id: 'provider-event',
        resource_id: 'vehicle-1',
        starts_at: '2027-01-01T00:00:00.000Z',
        ends_at: '2027-01-01T01:00:00.000Z',
        timezone: 'Europe/London',
        title: 's'.repeat(4_096),
        description: 'd'.repeat(16_384),
        location: 'l'.repeat(16_384),
        organizer: { address: 'organizer@example.com', name: 'o'.repeat(1_024) },
        attendees: [
          {
            address: 'attendee@example.com',
            name: 'a'.repeat(1_024),
            role: 'required',
            participation_status: 'accepted',
            rsvp: true,
          },
        ],
        reminders: [{ minutes_before: 366 * 24 * 60, channel: 'display' }],
        status: 'confirmed',
        transparency: 'opaque',
        sequence: 1,
        revision: 1,
        recurrence_rule: 'R'.repeat(4_096),
        recurrence_exceptions: recurrenceExceptions,
        recurrence_id: null,
      },
    });

    const outcome = await invokeSlotlockAgentOperation({
      operation: 'calendar_get_event',
      input: { event_id: 'provider-event' },
      request: rpcRequest({}),
      options: buildDispatchOptions(),
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(getEvent).toHaveBeenCalledOnce();
  });

  it('returns bounded tool failures without leaking backend exception content', async () => {
    listResources.mockRejectedValueOnce(
      Object.assign(new SlotlockAgentOperationError('revision_conflict', 409), {
        privateDetail: 'provider-token-and-tenant-detail',
      }),
    );
    const response = await buildServer().fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: { name: 'calendar_list_resources', arguments: {} },
      }),
    );

    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('revision_conflict');
    expect(body).not.toContain('provider-token-and-tenant-detail');
  });

  it('rejects no-op event patches before authorization or dispatch', async () => {
    const response = await buildServer().fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'calendar_update_event',
          arguments: {
            event_id: 'event-1',
            expected_revision: 1,
            idempotency_key: 'update-1',
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expectToolError(await response.json(), 'invalid_arguments');
    expect(authorize).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: 'calendar_get_free_busy',
      invoke: getFreeBusy,
      arguments: {
        resource_ids: ['vehicle-1'],
        start: '2027-01-01T00:00:00.000Z',
        end: '2028-01-04T00:00:00.000Z',
      },
    },
    {
      operation: 'calendar_find_next_available',
      invoke: findNextAvailable,
      arguments: {
        resource_ids: ['vehicle-1'],
        start: '2027-01-01T00:00:00.000Z',
        end: '2028-01-04T00:00:00.000Z',
        duration_minutes: 60,
      },
    },
    {
      operation: 'calendar_list_events',
      invoke: listEvents,
      arguments: {
        resource_ids: ['vehicle-1'],
        start: '2027-01-01T00:00:00.000Z',
        end: '2028-01-04T00:00:00.000Z',
      },
    },
  ])(
    'rejects an oversized $operation window before authorization or dispatch',
    async (testCase) => {
      const response = await buildServer().fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: `oversized-${testCase.operation}`,
          method: 'tools/call',
          params: { name: testCase.operation, arguments: testCase.arguments },
        }),
      );

      expect(response.status).toBe(200);
      expectToolError(await response.json(), 'invalid_arguments');
      expect(authorize).not.toHaveBeenCalled();
      expect(testCase.invoke).not.toHaveBeenCalled();
    },
  );

  it('accepts a resource move as a guarded event patch', async () => {
    updateEvent.mockResolvedValueOnce({
      event: {
        id: 'event-1',
        resource_id: 'resource-2',
        starts_at: '2027-01-10T09:00:00.000Z',
        ends_at: '2027-01-10T10:00:00.000Z',
        timezone: 'Europe/London',
        title: 'Collection',
        description: null,
        location: null,
        organizer: null,
        attendees: [],
        reminders: [],
        status: 'confirmed',
        transparency: 'opaque',
        sequence: 2,
        revision: 2,
        recurrence_rule: null,
        recurrence_exceptions: [],
        recurrence_id: null,
      },
      replayed: false,
    });
    const response = await buildServer().fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'calendar_update_event',
          arguments: {
            event_id: 'event-1',
            expected_revision: 1,
            resource_id: 'resource-2',
            idempotency_key: 'move-1',
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'calendar_update_event' }),
      expect.objectContaining({ resource_id: 'resource-2' }),
    );
  });

  it('rejects hostile origins, unsupported media, and oversized bodies before dispatch', async () => {
    const server = buildServer({ maxRequestBytes: 1_024 });
    const hostile = await server.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, '/slotlock/mcp', {
        Origin: 'https://attacker.example',
      }),
    );
    expect(hostile.status).toBe(403);

    const wrongType = rpcRequest({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
    wrongType.headers.set('content-type', 'text/plain');
    expect((await server.fetch(wrongType)).status).toBe(415);

    const oversized = await server.fetch(
      rpcRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'calendar_list_resources', arguments: { padding: 'x'.repeat(2_000) } },
      }),
    );
    expect(oversized.status).toBe(413);
    expect(listResources).not.toHaveBeenCalled();
  });

  it('uses the identical operation through the truthful synchronous A2A binding', async () => {
    const server = buildServer();
    const response = await server.fetch(
      rpcRequest(
        {
          jsonrpc: '2.0',
          id: 'a2a-1',
          method: 'SendMessage',
          params: {
            message: {
              messageId: 'message-1',
              contextId: 'context-1',
              role: 'ROLE_USER',
              parts: [
                {
                  data: { skill: 'calendar_list_resources', arguments: { limit: 10 } },
                  mediaType: 'application/json',
                },
              ],
            },
          },
        },
        '/slotlock/a2a',
        { 'A2A-Version': '1.0' },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        message: {
          messageId: expect.stringMatching(/^reply_/),
          contextId: 'context-1',
          role: 'ROLE_AGENT',
          parts: [{ data: { resources: expect.any(Array) }, mediaType: 'application/json' }],
        },
      },
    });
  });

  it('requires string or number JSON-RPC request ids for A2A requests', async () => {
    const server = buildServer();
    const message = {
      messageId: 'message-request-id',
      role: 'ROLE_USER',
      parts: [
        {
          data: { skill: 'calendar_list_resources', arguments: {} },
          mediaType: 'application/json',
        },
      ],
    };

    for (const invalidId of [undefined, null, true, false, {}, []]) {
      const body: Record<string, unknown> = {
        jsonrpc: '2.0',
        method: 'SendMessage',
        params: { message },
      };
      if (invalidId !== undefined) body.id = invalidId;

      const response = await server.fetch(
        rpcRequest(body, '/slotlock/a2a', { 'A2A-Version': '1.0' }),
      );
      // A2A §9.5: a JSON-RPC error travels in the envelope of an HTTP 200.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }

    for (const validId of ['request-string', 0, 7]) {
      const response = await server.fetch(
        rpcRequest(
          {
            jsonrpc: '2.0',
            id: validId,
            method: 'SendMessage',
            params: { message },
          },
          '/slotlock/a2a',
          { 'A2A-Version': '1.0' },
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: validId,
        result: { message: { role: 'ROLE_AGENT' } },
      });
    }

    expect(listResources).toHaveBeenCalledTimes(3);
  });

  it('rejects A2A tenant substitution instead of treating request routing as authority', async () => {
    const response = await buildServer().fetch(
      rpcRequest(
        {
          jsonrpc: '2.0',
          id: 'a2a-tenant-substitution',
          method: 'SendMessage',
          params: {
            tenant: 'tenant-b',
            message: {
              messageId: 'message-2',
              role: 'ROLE_USER',
              parts: [
                {
                  data: { skill: 'calendar_list_resources', arguments: {} },
                  mediaType: 'application/json',
                },
              ],
            },
          },
        },
        '/slotlock/a2a',
        { 'A2A-Version': '1.0' },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32602,
        data: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'INVALID_MESSAGE_PARAMETERS',
            domain: 'slotlock',
          },
        ],
      },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();
  });

  // `tenant` has no presence in a2a.proto, so a proto3 JSON emitter may send its default, '', which
  // means "not set": the caller's own tenant, as when the field is absent.
  it('reads an empty A2A tenant as unset, the proto3 default', async () => {
    const response = await buildServer().fetch(
      rpcRequest(
        {
          jsonrpc: '2.0',
          id: 'a2a-tenant-default',
          method: 'SendMessage',
          params: {
            tenant: '',
            message: {
              messageId: 'message-3',
              role: 'ROLE_USER',
              parts: [
                {
                  data: { skill: 'calendar_list_resources', arguments: {} },
                  mediaType: 'application/json',
                },
              ],
            },
          },
        },
        '/slotlock/a2a',
        { 'A2A-Version': '1.0' },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { message: { role: 'ROLE_AGENT' } } });
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  describe('portable operation names', () => {
    it('advertises only names every tool-calling API accepts', () => {
      const names = slotlockAgentTools().map((tool) => tool.name);
      expect(names).toHaveLength(8);
      for (const name of names) {
        // Claude: ^[a-zA-Z0-9_-]{1,128}$. OpenAI function names: the same characters, at most 64.
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect(isSlotlockAgentOperation(name)).toBe(true);
      }
      expect(new Set(Object.values(SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES))).toEqual(new Set(names));
    });

    it('resolves each legacy dotted name to its current operation and nothing else', () => {
      for (const [legacy, current] of Object.entries(SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES)) {
        expect(legacy).toBe(current.replace('_', '.'));
        expect(isSlotlockAgentOperation(legacy)).toBe(false);
        expect(resolveSlotlockAgentOperation(legacy)).toBe(current);
        expect(resolveSlotlockAgentOperation(current)).toBe(current);
      }
      for (const name of [
        'calendar.drop_tables',
        'calendar_drop_tables',
        'CALENDAR_LIST_RESOURCES',
        'calendar.list_resources ',
        'calendar/list_resources',
        'toString',
        '__proto__',
        '',
        42,
        null,
        undefined,
        { name: 'calendar_list_resources' },
      ]) {
        expect(resolveSlotlockAgentOperation(name)).toBeNull();
      }
    });

    it('dispatches a legacy name as its current operation on every entry point', async () => {
      const direct = await invokeSlotlockAgentOperation({
        operation: 'calendar.list_resources',
        input: { limit: 2 },
        request: rpcRequest({}),
        options: buildDispatchOptions(),
      });
      expect(direct).toMatchObject({ ok: true });
      expect(authorize).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'calendar_list_resources' }),
      );

      const server = buildServer();
      const mcp = await server.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 'legacy-mcp',
          method: 'tools/call',
          params: { name: 'calendar.list_resources', arguments: { limit: 3 } },
        }),
      );
      expect(await mcp.json()).toMatchObject({
        result: { structuredContent: { next_cursor: null } },
      });
      const a2a = await server.fetch(
        a2aSendMessage({ skill: 'calendar.list_resources', arguments: { limit: 4 } }),
      );
      expect(await a2aReplyData(a2a)).toMatchObject({ next_cursor: null });

      expect(
        listResources.mock.calls.map(([context, input]) => [context.operation, input]),
      ).toEqual([
        ['calendar_list_resources', { limit: 2 }],
        ['calendar_list_resources', { limit: 3 }],
        ['calendar_list_resources', { limit: 4 }],
      ]);
      expect(
        await invokeSlotlockAgentOperation({
          operation: 'calendar.drop_tables',
          input: {},
          request: rpcRequest({}),
          options: buildDispatchOptions(),
        }),
      ).toEqual({ ok: false, status: 404, code: 'operation_not_found' });
    });
  });

  describe('MCP tool results', () => {
    it('encodes success as structured content and failure as a text-only tool error', () => {
      expect(slotlockMcpToolResult({ ok: true, data: { next_cursor: null } })).toEqual({
        content: [{ type: 'text', text: '{"next_cursor":null}' }],
        structuredContent: { next_cursor: null },
      });
      const failure = slotlockMcpToolResult({
        ok: false,
        code: 'reservation_conflict',
        details: { code: 'overridden', resource_id: 'vehicle-1', retryable: false },
      });
      expect(failure).toEqual({
        content: [
          {
            type: 'text',
            text: '{"error":{"code":"reservation_conflict","resource_id":"vehicle-1","retryable":false}}',
          },
        ],
        isError: true,
      });
      expect(failure).not.toHaveProperty('structuredContent');
    });

    it('returns domain failures as tool errors the calling model can read', async () => {
      const server = buildServer();
      createEvent.mockRejectedValueOnce(new SlotlockAgentOperationError('reservation_conflict', 409));
      const conflict = await server.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 'conflict',
          method: 'tools/call',
          params: { name: 'calendar_create_event', arguments: CREATE_EVENT_ARGUMENTS },
        }),
      );
      expect(conflict.status).toBe(200);
      expectToolError(await conflict.json(), 'reservation_conflict');

      authorize.mockResolvedValueOnce(false);
      const forbidden = await server.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 'forbidden',
          method: 'tools/call',
          params: { name: 'calendar_list_resources', arguments: {} },
        }),
      );
      expect(forbidden.status).toBe(200);
      expectToolError(await forbidden.json(), 'forbidden');
      expect(listResources).not.toHaveBeenCalled();
    });

    it('answers an unknown tool with a JSON-RPC invalid-params error', async () => {
      const response = await buildServer().fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 'unknown-tool',
          method: 'tools/call',
          params: { name: 'calendar_drop_tables', arguments: {} },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 'unknown-tool',
        error: { code: -32602, message: 'Unknown tool' },
      });
      expect(authorize).not.toHaveBeenCalled();
    });

    it('reports a backend crash as a JSON-RPC internal error without its message', async () => {
      listResources.mockRejectedValueOnce(new Error('postgres://slotlock:hunter2@db refused'));
      const response = await buildServer().fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 'crash',
          method: 'tools/call',
          params: { name: 'calendar_list_resources', arguments: {} },
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 'crash',
        error: { code: -32603, message: 'Internal error' },
      });
    });

    it.each(['internal_error', 'invalid_backend_result'])(
      'keeps the reserved code %s from the agent when a backend throws it',
      async (code) => {
        const server = buildServer();
        listResources.mockRejectedValueOnce(new SlotlockAgentOperationError(code, 503));
        const mcp = await server.fetch(
          rpcRequest({
            jsonrpc: '2.0',
            id: code,
            method: 'tools/call',
            params: { name: 'calendar_list_resources', arguments: {} },
          }),
        );
        expect(mcp.status).toBe(500);
        expect(await mcp.json()).toEqual({
          jsonrpc: '2.0',
          id: code,
          error: { code: -32603, message: 'Internal error' },
        });
        listResources.mockRejectedValueOnce(new SlotlockAgentOperationError(code, 503));
        const a2a = await server.fetch(
          a2aSendMessage({ skill: 'calendar_list_resources', arguments: {} }),
        );
        expect(a2a.status).toBe(200);
        expect(await a2a.json()).toMatchObject({
          error: { code: -32603, message: 'Internal error' },
        });
      },
    );
  });

  describe('MCP lifecycle', () => {
    function initializeRequest(protocolVersion: string): Request {
      const request = rpcRequest({
        jsonrpc: '2.0',
        id: `initialize-${protocolVersion}`,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'version-client', version: '1.0.0' },
        },
      });
      // The client learns the version from this response, so its first request carries no header.
      request.headers.delete('mcp-protocol-version');
      return request;
    }

    it('answers ping with an empty result', async () => {
      const response = await buildServer().fetch(
        rpcRequest({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });
    });

    it("negotiates the client's revision when supported and the newest one otherwise", async () => {
      expect(SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual([
        SLOTLOCK_MCP_PROTOCOL_VERSION,
        SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
        '2025-06-18',
      ]);
      const server = buildServer();
      // `initialize` is the 2025 lifecycle: it negotiates a 2025 revision, never 2026-07-28, which
      // has no handshake (agent-server.modern.test.ts).
      for (const [requested, negotiated] of [
        ['2025-11-25', '2025-11-25'],
        ['2025-06-18', '2025-06-18'],
        ['2025-03-26', SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION],
        ['2026-07-28', SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION],
      ] as const) {
        const response = await server.fetch(initializeRequest(requested));
        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-protocol-version')).toBe(negotiated);
        expect(await response.json()).toMatchObject({ result: { protocolVersion: negotiated } });
      }

      const pinned = await server.fetch(
        rpcRequest({ jsonrpc: '2.0', id: 'pinned', method: 'tools/list' }, '/slotlock/mcp', {
          'MCP-Protocol-Version': '2025-06-18',
        }),
      );
      expect(pinned.status).toBe(200);
      expect(await pinned.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    });

    it('rejects a request whose protocol version header is missing or unsupported', async () => {
      const server = buildServer();
      // A 2026-07-28 header routes to that revision's own validation (agent-server.modern.test.ts).
      for (const version of ['2025-03-26', 'latest']) {
        const response = await server.fetch(
          rpcRequest({ jsonrpc: '2.0', id: version, method: 'tools/list' }, '/slotlock/mcp', {
            'MCP-Protocol-Version': version,
          }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          jsonrpc: '2.0',
          id: version,
          error: { code: -32600, message: 'Unsupported MCP protocol version' },
        });
      }
      const missing = rpcRequest({ jsonrpc: '2.0', id: 'no-header', method: 'tools/list' });
      missing.headers.delete('mcp-protocol-version');
      expect((await server.fetch(missing)).status).toBe(400);
    });

    it('answers an unknown method and unparseable JSON the MCP way', async () => {
      const server = buildServer();
      const unknown = await server.fetch(
        rpcRequest({ jsonrpc: '2.0', id: 'prompts', method: 'prompts/list' }),
      );
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({
        jsonrpc: '2.0',
        id: 'prompts',
        error: { code: -32601, message: 'Method not found' },
      });

      const unparseable = await server.fetch(withUnparseableBody(rpcRequest({})));
      expect(unparseable.status).toBe(400);
      expect(await unparseable.json()).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    });

    it('publishes its protocol revisions in the manifest', () => {
      expect(buildServer().manifest).toMatchObject({
        protocols: {
          mcp: {
            version: SLOTLOCK_MCP_PROTOCOL_VERSION,
            supportedVersions: [...SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS],
            endpoint: 'http://localhost/slotlock/mcp',
          },
          a2a: { version: SLOTLOCK_A2A_PROTOCOL_VERSION, endpoint: 'http://localhost/slotlock/a2a' },
        },
      });
    });
  });

  describe('A2A 1.0 binding', () => {
    it('answers any other A2A-Version, or none (read as 0.3), with VersionNotSupportedError', async () => {
      const server = buildServer();
      for (const headers of [{}, { 'A2A-Version': '0.3' }, { 'A2A-Version': '1.1' }]) {
        const response = await server.fetch(
          a2aSendMessage({ skill: 'calendar_list_resources', arguments: {} }, { headers }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          jsonrpc: '2.0',
          id: 'a2a-test',
          error: {
            code: -32009,
            message: 'A2A version not supported',
            data: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VERSION_NOT_SUPPORTED',
                domain: 'a2a-protocol.org',
                metadata: { supportedVersions: SLOTLOCK_A2A_PROTOCOL_VERSION },
              },
            ],
          },
        });
      }
      expect(listResources).not.toHaveBeenCalled();
    });

    it('declines the methods a synchronous, stateless agent does not implement', async () => {
      const server = buildServer();
      const call = (method: string, params: Record<string, unknown> = {}) =>
        server.fetch(
          rpcRequest({ jsonrpc: '2.0', id: method, method, params }, '/slotlock/a2a', {
            'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
          }),
        );
      for (const method of [
        'CreateTaskPushNotificationConfig',
        'GetTaskPushNotificationConfig',
        'ListTaskPushNotificationConfigs',
        'DeleteTaskPushNotificationConfig',
      ]) {
        const response = await call(method);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: method,
          error: {
            code: -32003,
            data: [{ reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED', domain: 'a2a-protocol.org' }],
          },
        });
      }
      for (const method of ['SendStreamingMessage', 'SubscribeToTask', 'GetExtendedAgentCard']) {
        const response = await call(method);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: method,
          error: {
            code: -32004,
            data: [{ reason: 'UNSUPPORTED_OPERATION', domain: 'a2a-protocol.org' }],
          },
        });
      }
      expect(listResources).not.toHaveBeenCalled();
    });

    // GetTask, ListTasks and CancelTask are core A2A operations. Every reply here is a message, so
    // no task id can exist: the answer is TaskNotFoundError and an empty list, not "unsupported".
    it('answers the core task methods as an agent that keeps no tasks', async () => {
      const server = buildServer();
      const call = async (method: string, params: Record<string, unknown>) => {
        const response = await server.fetch(
          rpcRequest({ jsonrpc: '2.0', id: method, method, params }, '/slotlock/a2a', {
            'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
          }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      for (const method of ['GetTask', 'CancelTask']) {
        await expect(call(method, { id: 'task-1' })).resolves.toMatchObject({
          id: method,
          error: {
            code: -32001,
            data: [{ reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' }],
          },
        });
        await expect(call(method, {})).resolves.toMatchObject({ error: { code: -32602 } });
      }
      await expect(call('ListTasks', {})).resolves.toEqual({
        jsonrpc: '2.0',
        id: 'ListTasks',
        result: { tasks: [], nextPageToken: '', pageSize: 50, totalSize: 0 },
      });
      await expect(call('ListTasks', { pageSize: 10 })).resolves.toMatchObject({
        result: { tasks: [], pageSize: 10 },
      });
      await expect(call('ListTasks', { pageSize: 150 })).resolves.toMatchObject({
        error: { code: -32602 },
      });
      // Every field of the A2A 1.0 request, well formed and for the caller's own tenant.
      await expect(
        call('ListTasks', {
          tenant: 'tenant-a',
          contextId: 'context-1',
          status: 'TASK_STATE_WORKING',
          pageSize: 5,
          pageToken: '',
          historyLength: 0,
          statusTimestampAfter: '2027-03-29T09:00:00.000Z',
          includeArtifacts: true,
        }),
      ).resolves.toMatchObject({ result: { tasks: [], nextPageToken: '', pageSize: 5 } });
      await expect(
        call('GetTask', { tenant: 'tenant-a', id: 'task-1', historyLength: 3 }),
      ).resolves.toMatchObject({ error: { code: -32001 } });
      await expect(
        call('CancelTask', { tenant: 'tenant-a', id: 'task-1', metadata: { reason: 'done' } }),
      ).resolves.toMatchObject({ error: { code: -32001 } });
      // Fields without presence at their proto3 default ('', TASK_STATE_UNSPECIFIED) are unset.
      await expect(
        call('ListTasks', {
          tenant: '',
          contextId: '',
          status: 'TASK_STATE_UNSPECIFIED',
          pageToken: '',
        }),
      ).resolves.toMatchObject({ result: { tasks: [], pageSize: 50 } });
      await expect(call('GetTask', { tenant: '', id: 'task-1' })).resolves.toMatchObject({
        error: { code: -32001 },
      });
      expect(listResources).not.toHaveBeenCalled();
    });

    // Refused as SendMessage refuses its own: another tenant, a field the method does not define, or
    // a value of the wrong type. A page token must come from an earlier response, and none is issued.
    it.each([
      ['GetTask', { id: 'task-1', tenant: 'tenant-b' }],
      ['GetTask', { id: 'task-1', historyLength: -1 }],
      ['GetTask', { id: 'task-1', pageSize: 10 }],
      ['CancelTask', { id: 'task-1', tenant: 'tenant-b' }],
      ['CancelTask', { id: 'task-1', metadata: ['done'] }],
      ['ListTasks', { tenant: 'tenant-b' }],
      ['ListTasks', { pageToken: 'page-2' }],
      ['ListTasks', { status: 'working' }],
      ['ListTasks', { contextId: 7 }],
      ['ListTasks', { historyLength: 1.5 }],
      ['ListTasks', { statusTimestampAfter: 'yesterday' }],
      ['ListTasks', { statusTimestampAfter: '2027-02-30T09:00:00Z' }],
      ['ListTasks', { statusTimestampAfter: '2027-03-29T24:00:00Z' }],
      ['ListTasks', { includeArtifacts: 'yes' }],
      ['ListTasks', { id: 'task-1' }],
      ['ListTasks', ['tenant-a']],
    ] as const)('refuses %s with params %j', async (method, params) => {
      const response = await buildServer().fetch(
        rpcRequest({ jsonrpc: '2.0', id: method, method, params }, '/slotlock/a2a', {
          'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: method,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'INVALID_PARAMS',
              domain: 'slotlock',
            },
          ],
        },
      });
    });

    it('answers the A2A 0.3 method spelling as an unknown method', async () => {
      const server = buildServer();
      const call = (method: string) =>
        server.fetch(
          rpcRequest({ jsonrpc: '2.0', id: method, method, params: {} }, '/slotlock/a2a', {
            'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
          }),
        );
      // The A2A 0.3 spelling is not a 1.0 method.
      const legacy = await call('message/send');
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toEqual({
        jsonrpc: '2.0',
        id: 'message/send',
        error: { code: -32601, message: 'Method not found' },
      });
      expect(listResources).not.toHaveBeenCalled();
    });

    it('replies with the skill outcome as the data part, failures included', async () => {
      const server = buildServer();
      createEvent.mockRejectedValueOnce(new SlotlockAgentOperationError('reservation_conflict', 409));
      const conflict = await server.fetch(
        a2aSendMessage(
          { skill: 'calendar_create_event', arguments: CREATE_EVENT_ARGUMENTS },
          { id: 'conflict' },
        ),
      );
      expect(conflict.status).toBe(200);
      expect(await a2aReplyData(conflict)).toEqual({ error: { code: 'reservation_conflict' } });

      const invalid = await server.fetch(
        a2aSendMessage(
          {
            skill: 'calendar_list_events',
            arguments: { resource_ids: [], start: 'soon', end: 'later' },
          },
          { id: 'invalid' },
        ),
      );
      expect(await a2aReplyData(invalid)).toEqual({ error: { code: 'invalid_arguments' } });

      authorize.mockResolvedValueOnce(false);
      const forbidden = await server.fetch(
        a2aSendMessage({ skill: 'calendar_list_resources', arguments: {} }, { id: 'forbidden' }),
      );
      expect(await a2aReplyData(forbidden)).toEqual({ error: { code: 'forbidden' } });
      expect(listResources).not.toHaveBeenCalled();
    });

    it('answers a message outside the invocation convention with InvalidParams', async () => {
      const server = buildServer();
      for (const data of [
        { skill: 'calendar_drop_tables', arguments: {} },
        { arguments: { limit: 1 } },
        'calendar_list_resources',
      ]) {
        const response = await server.fetch(a2aSendMessage(data, { id: 'bad-message' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: 'bad-message',
          error: {
            code: -32602,
            data: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'INVALID_MESSAGE',
                domain: 'slotlock',
                metadata: { expected: expect.stringContaining('"skill"') },
              },
            ],
          },
        });
      }
      expect(authorize).not.toHaveBeenCalled();
    });

    it('keeps crashes and unparseable JSON inside an HTTP 200 JSON-RPC envelope', async () => {
      const server = buildServer();
      listResources.mockRejectedValueOnce(new Error('postgres://slotlock:hunter2@db refused'));
      const crash = await server.fetch(
        a2aSendMessage({ skill: 'calendar_list_resources', arguments: {} }, { id: 'crash' }),
      );
      expect(crash.status).toBe(200);
      expect(await crash.json()).toEqual({
        jsonrpc: '2.0',
        id: 'crash',
        error: { code: -32603, message: 'Internal error' },
      });

      const unparseable = await server.fetch(withUnparseableBody(a2aSendMessage({})));
      expect(unparseable.status).toBe(200);
      expect(await unparseable.json()).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    });

    it('publishes an agent card whose every skill example is a valid invocation', async () => {
      authorize.mockResolvedValue(false);
      const response = await buildServer().fetch(
        new Request('http://localhost/slotlock/.well-known/agent-card.json'),
      );
      const card = (await response.json()) as {
        supportedInterfaces: unknown;
        capabilities: unknown;
        skills: Array<Record<string, unknown>>;
      };
      expect(card.supportedInterfaces).toEqual([
        {
          url: 'http://localhost/slotlock/a2a',
          protocolBinding: 'JSONRPC',
          protocolVersion: SLOTLOCK_A2A_PROTOCOL_VERSION,
        },
      ]);
      expect(card.capabilities).toEqual({
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
      });
      expect(card.skills.map((skill) => skill.id)).toEqual(
        slotlockAgentTools().map((tool) => tool.name),
      );
      for (const skill of card.skills) {
        // a2a.proto's AgentSkill has no `metadata` field.
        expect(skill).not.toHaveProperty('metadata');
        const examples = skill.examples as string[];
        expect(examples).toHaveLength(1);
        const example = JSON.parse(examples[0] ?? 'null') as { skill: string; arguments: unknown };
        expect(example.skill).toBe(skill.id);
        // Authorization runs only after the arguments validate, so `forbidden` proves they did.
        expect(
          await invokeSlotlockAgentOperation({
            operation: example.skill,
            input: example.arguments,
            request: rpcRequest({}),
            options: buildDispatchOptions(),
          }),
        ).toEqual({ ok: false, status: 403, code: 'forbidden' });
      }
    });
  });

  describe('OAuth protected-resource metadata (RFC 9728)', () => {
    // Issuer identifiers are compared as exact strings (RFC 8414 §3.3), so each is published as
    // configured: with its trailing slash, without one, or with a path.
    const oauth = {
      authorizationServers: [
        'https://auth.example.com/',
        'https://login.example.org',
        'https://login.example.org/tenant-a',
      ],
      scopesSupported: ['calendar:read', 'calendar:write'],
      requiredScopes: ['calendar:read', 'calendar:write'],
      resourceName: 'Slotlock calendar',
      resourceDocumentation: 'https://docs.example.com/slotlock',
    };

    function unauthenticated(request: Request): Request {
      request.headers.delete('authorization');
      return request;
    }

    it('publishes nothing when OAuth is not configured', async () => {
      const server = buildServer();
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/slotlock/mcp',
      ]) {
        expect((await server.fetch(new Request(`http://localhost${path}`))).status).toBe(404);
      }
    });

    it('serves the metadata at the path-aware and the root location', async () => {
      const server = buildServer({ oauth });
      for (const path of [
        '/.well-known/oauth-protected-resource/slotlock/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const response = await server.fetch(new Request(`http://localhost${path}`));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          resource: 'http://localhost/slotlock/mcp',
          authorization_servers: [
            'https://auth.example.com/',
            'https://login.example.org',
            'https://login.example.org/tenant-a',
          ],
          scopes_supported: ['calendar:read', 'calendar:write'],
          bearer_methods_supported: ['header'],
          resource_name: 'Slotlock calendar',
          resource_documentation: 'https://docs.example.com/slotlock',
        });
      }
      const write = await server.fetch(
        new Request('http://localhost/.well-known/oauth-protected-resource', { method: 'POST' }),
      );
      expect(write.status).toBe(404);
    });

    it('points an unauthenticated MCP client at the metadata; A2A keeps the plain challenge', async () => {
      const server = buildServer({ oauth });
      const mcp = await server.fetch(
        unauthenticated(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
      );
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get('www-authenticate')).toBe(
        'Bearer realm="slotlock", resource_metadata="http://localhost/.well-known/oauth-protected-resource/slotlock/mcp", scope="calendar:read calendar:write"',
      );

      const a2a = await server.fetch(
        unauthenticated(a2aSendMessage({ skill: 'calendar_list_resources', arguments: {} })),
      );
      expect(a2a.status).toBe(401);
      expect(a2a.headers.get('www-authenticate')).toBe('Bearer realm="slotlock"');

      const scopeless = await buildServer({
        oauth: { authorizationServers: ['https://auth.example.com'] },
      }).fetch(unauthenticated(rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })));
      expect(scopeless.headers.get('www-authenticate')).toBe(
        'Bearer realm="slotlock", resource_metadata="http://localhost/.well-known/oauth-protected-resource/slotlock/mcp"',
      );
      expect(listResources).not.toHaveBeenCalled();
    });

    it.each([
      ['no authorization server', { authorizationServers: [] }, 'authorizationServers'],
      [
        'a plain-HTTP issuer',
        { authorizationServers: ['http://auth.example.com'] },
        'authorizationServers',
      ],
      [
        'an issuer with credentials',
        { authorizationServers: ['https://user:secret@auth.example.com'] },
        'authorizationServers',
      ],
      [
        'an issuer with a query',
        { authorizationServers: ['https://auth.example.com/?tenant=a'] },
        'authorizationServers',
      ],
      // RFC 8414 §2: no query or fragment component, and URL parsing keeps an empty one.
      [
        'an issuer with an empty query',
        { authorizationServers: ['https://auth.example.com/?'] },
        'authorizationServers',
      ],
      [
        'an issuer with a fragment',
        { authorizationServers: ['https://auth.example.com/#tenant-a'] },
        'authorizationServers',
      ],
      [
        'an issuer with an empty fragment',
        { authorizationServers: ['https://auth.example.com/#'] },
        'authorizationServers',
      ],
      ['an unparseable issuer', { authorizationServers: ['not a url'] }, 'authorizationServers'],
      // Published verbatim, so an issuer must already be in canonical URL form.
      [
        'an issuer that is not in canonical form',
        { authorizationServers: ['https://Auth.Example.com'] },
        'authorizationServers',
      ],
      [
        'an issuer with surrounding whitespace',
        { authorizationServers: [' https://auth.example.com'] },
        'authorizationServers',
      ],
      [
        'a scope with a quote',
        { authorizationServers: ['https://auth.example.com'], requiredScopes: ['calendar"read'] },
        'requiredScopes',
      ],
      [
        'a scope with a space',
        { authorizationServers: ['https://auth.example.com'], scopesSupported: ['calendar read'] },
        'scopesSupported',
      ],
      [
        'a control character in the name',
        { authorizationServers: ['https://auth.example.com'], resourceName: 'Slotlock\n' },
        'resourceName',
      ],
      [
        'plain-HTTP documentation',
        {
          authorizationServers: ['https://auth.example.com'],
          resourceDocumentation: 'http://docs.example.com',
        },
        'resourceDocumentation',
      ],
    ] as const)('rejects %s when the server is created', (_label, invalid, field) => {
      expect(() => buildServer({ oauth: invalid })).toThrow(`oauth.${field} is invalid`);
    });

    it('accepts a loopback HTTP issuer only in local development mode', async () => {
      const local = { authorizationServers: ['http://localhost:8080', 'http://127.0.0.1:9000/as'] };
      const response = await buildServer({ oauth: local }).fetch(
        new Request('http://localhost/.well-known/oauth-protected-resource'),
      );
      expect(await response.json()).toMatchObject({
        authorization_servers: ['http://localhost:8080', 'http://127.0.0.1:9000/as'],
      });
      expect(() =>
        buildServer({
          publicBaseUrl: 'https://calendar.example.com/slotlock',
          allowInsecureLocalhost: false,
          allowedOrigins: ['https://calendar.example.com'],
          oauth: local,
        }),
      ).toThrow('oauth.authorizationServers is invalid');
    });
  });

  describe('base path and origin-root discovery', () => {
    it('serves nothing outside the public base path but the root discovery documents', async () => {
      const server = buildServer();
      for (const request of [
        new Request('http://localhost/healthz'),
        new Request('http://localhost/slotlockx/healthz'),
        new Request('http://localhost/other/slotlock/healthz'),
        rpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '/mcp'),
        rpcRequest({ jsonrpc: '2.0', id: 2, method: 'SendMessage', params: {} }, '/a2a', {
          'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
        }),
      ]) {
        expect((await server.fetch(request)).status).toBe(404);
      }

      const nested = await server.fetch(
        new Request('http://localhost/slotlock/.well-known/agent-card.json'),
      );
      const root = await server.fetch(new Request('http://localhost/.well-known/agent-card.json'));
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual(await nested.json());
      expect(authorize).not.toHaveBeenCalled();
      expect(listResources).not.toHaveBeenCalled();
    });

    it('routes a server mounted at the origin root', async () => {
      const server = buildServer({ publicBaseUrl: 'http://localhost' });
      const response = await server.fetch(
        rpcRequest({ jsonrpc: '2.0', id: 'root', method: 'ping' }, '/mcp'),
      );
      expect(response.status).toBe(200);
      expect(server.manifest).toMatchObject({
        protocols: { mcp: { endpoint: 'http://localhost/mcp' } },
      });
    });

    it('accepts plain HTTP only on a loopback host, IPv6 included, and only when opted in', () => {
      expect(() =>
        buildServer({
          publicBaseUrl: 'http://[::1]:8787/slotlock',
          allowedOrigins: ['http://[::1]:8787'],
        }),
      ).not.toThrow();
      expect(() =>
        buildServer({
          publicBaseUrl: 'http://127.0.0.1:8787',
          allowedOrigins: ['http://127.0.0.1:8787'],
        }),
      ).not.toThrow();
      expect(() =>
        buildServer({
          publicBaseUrl: 'http://[::1]:8787/slotlock',
          allowInsecureLocalhost: false,
          allowedOrigins: ['https://calendar.example.com'],
        }),
      ).toThrow('allowInsecureLocalhost');
      expect(() => buildServer({ publicBaseUrl: 'http://calendar.example.com/slotlock' })).toThrow(
        'must use HTTPS',
      );
    });
  });
});

// A2A carries a google.protobuf.Timestamp as RFC 3339 in UTC. Both A2A bindings in this repository
// (this package's server and a host application's own route) read it with this one parser.
describe('parseSlotlockA2ATimestamp', () => {
  it.each([
    ['2027-03-29T09:00:00Z', '2027-03-29T09:00:00.000Z'],
    ['2027-03-29T09:00:00.5Z', '2027-03-29T09:00:00.500Z'],
    ['2028-02-29T23:59:59.123456789Z', '2028-02-29T23:59:59.123Z'],
  ])('reads %s', (value, instant) => {
    expect(parseSlotlockA2ATimestamp(value)?.toISOString()).toBe(instant);
  });

  it.each([
    '2027-02-30T09:00:00Z',
    '2027-02-29T09:00:00Z',
    '2027-03-29T24:00:00Z',
    '2027-03-29T09:60:00Z',
    '2027-03-29T09:00:60Z',
    '0000-01-01T00:00:00Z',
    '2027-03-29T09:00:00+01:00',
    '2027-03-29 09:00:00Z',
    '2027-03-29T09:00:00.1234567890Z',
    'yesterday',
    '',
    1_743_238_800_000,
    null,
  ])('refuses %j', (value) => {
    expect(parseSlotlockA2ATimestamp(value)).toBeNull();
  });
});
