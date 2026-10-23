// Defects an audit reproduced on the agent server's protocol surface, each pinned by the request
// that showed it: a chunked body read whole past `maxRequestBytes`, a confirmation question that
// left out what changes a booking, arguments of the wrong type run as `{}`, an A2A rate limit
// answered in MCP's shape, a media type compared case-sensitively, and calls that named an
// operation but were never reported to `onEvent`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentServerEvent,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { modernRequest, rpc } from './helpers/modern-mcp.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const BASE = 'http://localhost/slotlock';
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';
const EVENT = {
  id: 'agent:5e8ff9bf55ba3508199d22e984129be6b5b6a8a7e3e5f1f0d2b9ba0c4a6f7e21',
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

const listResources = vi.fn();
const createEvent = vi.fn();
const backend = {
  listResources,
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent,
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
} as unknown as SlotlockAgentCalendarBackend;
const onEvent = vi.fn<(event: SlotlockAgentServerEvent) => void>();
const events = () => onEvent.mock.calls.map(([event]) => event);

function buildServer(overrides: Partial<SlotlockAgentServerOptions> = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: BASE,
    allowInsecureLocalhost: true,
    allowedOrigins: ['http://localhost'],
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer valid'
        ? { subject: 'principal-1', tenantRef: 'tenant-a' }
        : null,
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    onEvent,
    rest: true,
    ...overrides,
  });
}

const CONFIRMING = {
  confirmation: {
    operations: ['slotlock_create_event'] as const,
    secrets: ['confirmation-secret-0123456789abcdef'],
  },
};

/** A JSON-RPC request to `/mcp` (2025-11-25) or `/a2a` (A2A 1.0). */
function legacyRequest(
  path: '/mcp' | '/a2a',
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
      ...(path === '/mcp'
        ? { 'MCP-Protocol-Version': '2025-11-25' }
        : { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', ...body }),
  });
}

/** An A2A SendMessage whose one data part is `data`, with extra SendMessage params. */
function a2aSend(
  data: Record<string, unknown>,
  params: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): Request {
  return legacyRequest(
    '/a2a',
    {
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'message-1',
          role: 'ROLE_USER',
          parts: [{ data, mediaType: 'application/json' }],
          ...message,
        },
        ...params,
      },
    },
    { traceparent: TRACEPARENT },
  );
}

function legacyToolCall(params: Record<string, unknown>): Request {
  return legacyRequest('/mcp', { method: 'tools/call', params });
}

/**
 * A body that is produced only as it is read, `chunkBytes` at a time up to `totalBytes`, and that
 * records how much was pulled and whether the reader cancelled it.
 */
function pullingBody(totalBytes: number, chunkBytes = 512) {
  const probe = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(' '.repeat(chunkBytes));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      probe.pulled += chunk.byteLength;
      controller.enqueue(chunk);
      if (probe.pulled >= totalBytes) controller.close();
    },
    cancel() {
      probe.cancelled = true;
    },
  });
  return { body, probe };
}

function streamedRequest(path: string, body: ReadableStream<Uint8Array>): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
      'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
    },
    body,
    duplex: 'half',
  } as RequestInit);
}

beforeEach(() => {
  vi.clearAllMocks();
  listResources.mockResolvedValue({
    resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
    next_cursor: null,
  });
  createEvent.mockResolvedValue({ event: EVENT, replayed: false });
});

describe('P1: a body without Content-Length is counted as it arrives', () => {
  const LIMIT = 1_024;
  const CHUNK = 512;

  for (const path of ['/v1/events', '/mcp', '/a2a']) {
    it(`refuses a chunked ${path} body once it passes maxRequestBytes, without reading the rest`, async () => {
      const { body, probe } = pullingBody(256 * 1_024, CHUNK);
      const response = await buildServer({ maxRequestBytes: LIMIT }).fetch(
        streamedRequest(path, body),
      );
      expect(response.status).toBe(413);
      // The limit, the chunk that passed it, and at most one more the stream queued ahead.
      expect(probe.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
      expect(probe.cancelled).toBe(true);
      expect(listResources).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
    });
  }

  it('still reads a chunked body within the limit whole', async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slotlock_list_resources', arguments: { limit: 10 } },
      }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Two pieces, split inside a value, so a parse of the first piece alone would fail.
        controller.enqueue(encoded.slice(0, 40));
        controller.enqueue(encoded.slice(40));
        controller.close();
      },
    });
    const response = await buildServer({ maxRequestBytes: LIMIT }).fetch(
      streamedRequest('/mcp', body),
    );
    expect(response.status).toBe(200);
    expect(listResources).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
  });
});

describe('P4: the question for a create names what changes the booking', () => {
  async function createQuestion(args: Record<string, unknown>): Promise<string> {
    const response = await buildServer(CONFIRMING).fetch(
      modernRequest(
        'tools/call',
        { name: 'slotlock_create_event', arguments: args },
        {
          meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } },
        },
      ),
    );
    const body = (await rpc(response)) as {
      result: { inputRequests: { slotlock_confirm: { params: { message: string } } } };
    };
    return body.result.inputRequests.slotlock_confirm.params.message;
  }

  it('says when the booking will not block the time', async () => {
    expect(await createQuestion({ ...BOOKING, transparency: 'transparent' })).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London), leaving the time free for other bookings: "Vehicle handover".',
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('lists the other fields set, by name, before the quoted title', async () => {
    const message = await createQuestion({
      ...BOOKING,
      status: 'tentative',
      transparency: 'transparent',
      description: 'Bring the spare key',
      location: 'Depot 4',
      organizer: { address: 'desk@fleet.example' },
      attendees: [
        {
          address: 'driver@fleet.example',
          role: 'required',
          participation_status: 'needs_action',
        },
      ],
      reminders: [{ minutes_before: 30, channel: 'email' }],
    });
    expect(message).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London), tentatively, leaving the time free for other bookings (also description, location, organizer, attendees, reminders): "Vehicle handover".',
    );
    // The agent's own text stays out of everything but the quoted title.
    for (const text of ['Bring the spare key', 'Depot 4', 'desk@fleet.example', 'driver@']) {
      expect(message).not.toContain(text);
    }
  });

  it('asks as before for an opaque booking that sets nothing else', async () => {
    expect(await createQuestion({ ...BOOKING, transparency: 'opaque' })).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
    );
  });
});

describe('P5: arguments of the wrong type are refused, not run as {}', () => {
  const WRONG = ['{"limit":10}', [], 10, true];

  it('reads null arguments as none, on every protocol', async () => {
    const server = buildServer();
    const legacy = await server.fetch(
      legacyToolCall({ name: 'slotlock_list_resources', arguments: null }),
    );
    expect(await rpc(legacy)).toMatchObject({ result: { structuredContent: {} } });
    const modern = await server.fetch(
      modernRequest('tools/call', { name: 'slotlock_list_resources', arguments: null }),
    );
    expect(await rpc(modern)).toMatchObject({ result: { resultType: 'complete' } });
    const a2a = await server.fetch(
      a2aSend(
        { skill: 'slotlock_list_resources', arguments: null },
        { metadata: null, configuration: null },
      ),
    );
    expect(await rpc(a2a)).toMatchObject({ result: { message: { role: 'ROLE_AGENT' } } });
    expect(listResources).toHaveBeenCalledTimes(3);
    for (const [, input] of listResources.mock.calls) expect(input).toEqual({ limit: 50 });
  });

  it('MCP 2025 tools/call: -32602 and the backend is never called', async () => {
    const server = buildServer();
    for (const value of WRONG) {
      const response = await server.fetch(
        legacyToolCall({ name: 'slotlock_list_resources', arguments: value }),
      );
      expect(response.status).toBe(200);
      expect(await rpc(response)).toMatchObject({
        id: 'req-1',
        error: { code: -32602, message: 'Invalid params' },
      });
    }
    expect(listResources).not.toHaveBeenCalled();
    // Omitted arguments are still `{}`.
    const omitted = await server.fetch(legacyToolCall({ name: 'slotlock_list_resources' }));
    expect(await rpc(omitted)).toMatchObject({ result: { structuredContent: {} } });
    expect(listResources).toHaveBeenCalledWith(expect.anything(), { limit: 50 });
  });

  it('MCP 2026-07-28 tools/call: -32602 and the backend is never called', async () => {
    const server = buildServer();
    for (const value of WRONG) {
      const response = await server.fetch(
        modernRequest('tools/call', { name: 'slotlock_list_resources', arguments: value }),
      );
      expect(response.status).toBe(200);
      expect(await rpc(response)).toMatchObject({
        id: 'req-1',
        error: { code: -32602, message: 'Invalid params' },
      });
    }
    expect(listResources).not.toHaveBeenCalled();
    const omitted = await server.fetch(
      modernRequest('tools/call', { name: 'slotlock_list_resources' }),
    );
    expect(await rpc(omitted)).toMatchObject({ result: { resultType: 'complete' } });
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it('A2A: an arguments value that is not an object is an invalid message', async () => {
    const server = buildServer();
    for (const value of WRONG) {
      const response = await server.fetch(
        a2aSend({ skill: 'slotlock_list_resources', arguments: value }),
      );
      expect(response.status).toBe(200);
      expect(await rpc(response)).toMatchObject({
        id: 'req-1',
        error: {
          code: -32602,
          message: 'Invalid message',
          data: [{ '@type': ERROR_INFO, reason: 'INVALID_MESSAGE', domain: 'slotlock' }],
        },
      });
    }
    expect(listResources).not.toHaveBeenCalled();
    const omitted = await server.fetch(a2aSend({ skill: 'slotlock_list_resources' }));
    expect(await rpc(omitted)).toMatchObject({
      result: { message: { role: 'ROLE_AGENT' } },
    });
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it('A2A: SendMessage metadata and configuration must be objects when present', async () => {
    const server = buildServer();
    const data = { skill: 'slotlock_list_resources', arguments: {} };
    for (const params of [
      { metadata: 'x' },
      { metadata: [] },
      { configuration: 'x' },
      { configuration: [] },
      { configuration: 5 },
    ]) {
      const response = await server.fetch(a2aSend(data, params));
      expect(await rpc(response)).toMatchObject({
        error: {
          code: -32602,
          data: [{ '@type': ERROR_INFO, reason: 'INVALID_MESSAGE_PARAMETERS', domain: 'slotlock' }],
        },
      });
    }
    expect(listResources).not.toHaveBeenCalled();
    // The fields A2A 1.0 defines are left to the client.
    const accepted = await server.fetch(
      a2aSend(data, {
        metadata: { origin: 'test' },
        configuration: {
          acceptedOutputModes: ['application/json'],
          historyLength: 0,
          returnImmediately: false,
        },
      }),
    );
    expect(await rpc(accepted)).toMatchObject({ result: { message: { role: 'ROLE_AGENT' } } });
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it('the canonical dispatcher refuses input that is present but not an object', async () => {
    const options = {
      backend,
      authenticate: async () => ({ subject: 'principal-1', tenantRef: 'tenant-a' }),
      authorize: async () => true,
    };
    const request = new Request(`${BASE}/mcp`);
    for (const input of WRONG) {
      await expect(
        invokeSlotlockAgentOperation({
          operation: 'slotlock_list_resources',
          input,
          request,
          options,
        }),
      ).resolves.toEqual({ ok: false, status: 400, code: 'invalid_arguments' });
    }
    expect(listResources).not.toHaveBeenCalled();
    await expect(
      invokeSlotlockAgentOperation({
        operation: 'slotlock_list_resources',
        input: undefined,
        request,
        options,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('P6: a rate-limited A2A request is answered in A2A shape', () => {
  const limited = () => buildServer({ consumeRateLimit: async () => false });

  it('A2A: HTTP 200 with a google.rpc.ErrorInfo detail', async () => {
    const response = await limited().fetch(
      a2aSend({ skill: 'slotlock_list_resources', arguments: {} }),
    );
    expect(response.status).toBe(200);
    expect(await rpc(response)).toEqual({
      jsonrpc: '2.0',
      // Refused before the body is read, so the request's id is not known.
      id: null,
      error: {
        code: -32029,
        message: 'Rate limit exceeded',
        data: [{ '@type': ERROR_INFO, reason: 'RATE_LIMITED', domain: 'slotlock' }],
      },
    });
    expect(listResources).not.toHaveBeenCalled();
  });

  it('MCP keeps HTTP 429 with its own codes', async () => {
    const legacy = await limited().fetch(legacyToolCall({ name: 'slotlock_list_resources' }));
    expect(legacy.status).toBe(429);
    expect(await rpc(legacy)).toMatchObject({ error: { code: -32029 } });
    const modern = await limited().fetch(
      modernRequest('tools/call', { name: 'slotlock_list_resources', arguments: {} }),
    );
    expect(modern.status).toBe(429);
    expect(await rpc(modern)).toMatchObject({ error: { code: -31029 } });
  });
});

describe('P7: the media type is compared without regard to case', () => {
  function withType(request: Request, type: string): Request {
    const headers = new Headers(request.headers);
    headers.set('content-type', type);
    return new Request(request, { headers });
  }

  it('accepts application/json in any case on REST, MCP and A2A', async () => {
    const server = buildServer();
    const rest = await server.fetch(
      new Request(`${BASE}/v1/events`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid', 'Content-Type': 'Application/JSON' },
        body: JSON.stringify(BOOKING),
      }),
    );
    expect(rest.status).toBe(200);
    expect(createEvent).toHaveBeenCalledTimes(1);

    const mcp = await server.fetch(
      withType(legacyRequest('/mcp', { method: 'tools/list' }), 'APPLICATION/JSON; charset=UTF-8'),
    );
    expect(mcp.status).toBe(200);
    expect(await rpc(mcp)).toMatchObject({ result: { tools: expect.any(Array) } });

    const a2a = await server.fetch(
      withType(a2aSend({ skill: 'slotlock_list_resources', arguments: {} }), 'Application/Json'),
    );
    expect(await rpc(a2a)).toMatchObject({ result: { message: { role: 'ROLE_AGENT' } } });
  });

  it('still refuses another media type', async () => {
    const server = buildServer();
    for (const type of ['text/plain', 'application/jsonx', 'application/json-seq']) {
      const response = await server.fetch(
        withType(legacyRequest('/mcp', { method: 'tools/list' }), type),
      );
      expect(response.status).toBe(415);
    }
  });
});

describe('P8: every call that names an operation is reported', () => {
  it('reports a guarded write refused for a client without form elicitation', async () => {
    const response = await buildServer(CONFIRMING).fetch(
      modernRequest(
        'tools/call',
        { name: 'calendar.create_event', arguments: BOOKING },
        { meta: { traceparent: TRACEPARENT } },
      ),
    );
    expect(response.status).toBe(400);
    expect(await rpc(response)).toMatchObject({ error: { code: -32021 } });
    expect(events()).toEqual([
      {
        type: 'call',
        protocol: 'mcp',
        operation: 'slotlock_create_event',
        outcome: 'missing_capability',
        durationMs: expect.any(Number),
        traceId: TRACE_ID,
      },
    ]);
    expect(JSON.stringify(events())).not.toContain(BOOKING.title);
  });

  it('reports an A2A message that names a known skill but fails validation', async () => {
    const server = buildServer();
    await server.fetch(
      a2aSend(
        { skill: 'slotlock_create_event', arguments: BOOKING },
        {},
        {
          role: 'ROLE_AGENT',
        },
      ),
    );
    await server.fetch(a2aSend({ skill: 'slotlock_create_event', arguments: '{"title":"x"}' }));
    await server.fetch(
      a2aSend({ skill: 'slotlock_create_event', arguments: BOOKING }, { metadata: 'x' }),
    );
    const call = (outcome: string) => ({
      type: 'call',
      protocol: 'a2a',
      operation: 'slotlock_create_event',
      outcome,
      durationMs: expect.any(Number),
      traceId: TRACE_ID,
    });
    expect(events()).toEqual([
      call('invalid_message'),
      call('invalid_message'),
      call('invalid_message_parameters'),
    ]);
    expect(createEvent).not.toHaveBeenCalled();
    const reported = JSON.stringify(events());
    for (const absent of [BOOKING.title, BOOKING.idempotency_key, 'principal-1', 'tenant-a']) {
      expect(reported).not.toContain(absent);
    }
  });

  it('reports an MCP tools/call whose arguments are not an object', async () => {
    const server = buildServer();
    await server.fetch(legacyToolCall({ name: 'slotlock_list_resources', arguments: '{}' }));
    await server.fetch(
      modernRequest('tools/call', { name: 'slotlock_list_resources', arguments: '{}' }),
    );
    expect(events()).toEqual([
      expect.objectContaining({ protocol: 'mcp', outcome: 'invalid_arguments' }),
      expect.objectContaining({ protocol: 'mcp', outcome: 'invalid_arguments' }),
    ]);
  });

  it('still reports nothing for a message that names no operation', async () => {
    const server = buildServer();
    await server.fetch(a2aSend({ skill: 'drop_tables', arguments: '{}' }, {}, { role: 'x' }));
    await server.fetch(a2aSend({ skill: 'drop_tables', arguments: {} }, { metadata: 'x' }));
    expect(events()).toEqual([]);
    // The canary: the same server reports a refused message that does name one.
    await server.fetch(a2aSend({ skill: 'slotlock_list_resources' }, {}, { role: 'x' }));
    expect(events()).toMatchObject([{ operation: 'slotlock_list_resources' }]);
  });
});
