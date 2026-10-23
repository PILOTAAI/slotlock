// What the agent server tells `onEvent` about an MCP or A2A call: the operation, how it ended, how
// long it ran and the W3C trace id it carried. Never its arguments, its caller, its parent span or
// the rest of its trace context.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  SlotlockAgentOperationError,
  type SlotlockAgentServerEvent,
  createSlotlockAgentServer,
} from '../agent-server.js';
import { modernRequest, rpc } from './helpers/modern-mcp.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;
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

function buildServer() {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
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
  });
}

/** A 2025-11-25 JSON-RPC request to `/mcp` or `/a2a`. */
function legacyRequest(
  path: '/mcp' | '/a2a',
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/slotlock${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', ...body }),
  });
}

function a2aSend(skill: string, args: unknown, headers: Record<string, string> = {}): Request {
  return legacyRequest(
    '/a2a',
    {
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'message-1',
          role: 'ROLE_USER',
          parts: [{ data: { skill, arguments: args }, mediaType: 'application/json' }],
        },
      },
    },
    { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION, ...headers },
  );
}

const events = () => onEvent.mock.calls.map(([event]) => event);

beforeEach(() => {
  vi.clearAllMocks();
  listResources.mockResolvedValue({
    resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
    next_cursor: null,
  });
  createEvent.mockRejectedValue(new SlotlockAgentOperationError('overlap', 409));
});

describe('call events', () => {
  it('reports an MCP 2026 tools/call with its duration and the trace id from _meta', async () => {
    const response = await buildServer().fetch(
      modernRequest(
        'tools/call',
        { name: 'slotlock_list_resources', arguments: {} },
        { meta: { traceparent: TRACEPARENT, tracestate: 'vendor=opaque' } },
      ),
    );
    expect((await rpc(response)).result).toBeDefined();
    expect(events()).toEqual([
      {
        type: 'call',
        protocol: 'mcp',
        operation: 'slotlock_list_resources',
        outcome: 'ok',
        durationMs: expect.any(Number),
        traceId: TRACE_ID,
      },
    ]);
    const [event] = events();
    expect(event).toHaveProperty('durationMs', expect.any(Number));
    expect((event as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a 2025 tools/call refusal by its code, with the trace id from the header', async () => {
    await buildServer().fetch(
      legacyRequest(
        '/mcp',
        { method: 'tools/call', params: { name: 'slotlock_create_event', arguments: BOOKING } },
        { traceparent: TRACEPARENT },
      ),
    );
    expect(events()).toEqual([
      {
        type: 'call',
        protocol: 'mcp',
        operation: 'slotlock_create_event',
        outcome: 'overlap',
        durationMs: expect.any(Number),
        traceId: TRACE_ID,
      },
    ]);
  });

  it('reports an A2A SendMessage under the canonical operation a legacy skill name resolves to', async () => {
    await buildServer().fetch(a2aSend('calendar.list_resources', {}, { traceparent: TRACEPARENT }));
    expect(events()).toEqual([
      {
        type: 'call',
        protocol: 'a2a',
        operation: 'slotlock_list_resources',
        outcome: 'ok',
        durationMs: expect.any(Number),
        traceId: TRACE_ID,
      },
    ]);
  });

  it('leaves the trace id out when the traceparent is missing or invalid', async () => {
    const server = buildServer();
    await server.fetch(a2aSend('slotlock_list_resources', {}));
    await server.fetch(
      a2aSend(
        'slotlock_list_resources',
        {},
        { traceparent: `00-${'0'.repeat(32)}-${PARENT_ID}-01` },
      ),
    );
    expect(events()).toHaveLength(2);
    for (const event of events()) expect(event).not.toHaveProperty('traceId');
  });

  it('reports nothing for a tool or skill that names no operation', async () => {
    const server = buildServer();
    await server.fetch(
      legacyRequest('/mcp', {
        method: 'tools/call',
        params: { name: 'drop_tables', arguments: {} },
      }),
    );
    await server.fetch(modernRequest('tools/call', { name: 'drop_tables', arguments: {} }));
    await server.fetch(a2aSend('drop_tables', {}));
    expect(events()).toEqual([]);
    // The canary: the same server does report a call that names an operation.
    await server.fetch(a2aSend('slotlock_list_resources', {}));
    expect(events()).toMatchObject([{ type: 'call', operation: 'slotlock_list_resources' }]);
  });

  it('carries no argument, caller, parent span or other trace context', async () => {
    const server = buildServer();
    const meta = { traceparent: TRACEPARENT, tracestate: 'vendor=opaque', baggage: 'user=alice' };
    await server.fetch(
      modernRequest('tools/call', { name: 'slotlock_create_event', arguments: BOOKING }, { meta }),
    );
    await server.fetch(a2aSend('slotlock_create_event', BOOKING, { traceparent: TRACEPARENT }));
    expect(events()).toHaveLength(2);
    const reported = JSON.stringify(events());
    for (const absent of [
      PARENT_ID,
      'vendor=opaque',
      'user=alice',
      'principal-1',
      'tenant-a',
      'vehicle-1',
      BOOKING.title,
      BOOKING.idempotency_key,
    ]) {
      expect(reported).not.toContain(absent);
    }
  });

  it('answers the caller the same when onEvent throws', async () => {
    onEvent.mockImplementation(() => {
      throw new Error('collector down');
    });
    const response = await buildServer().fetch(
      modernRequest('tools/call', { name: 'slotlock_list_resources', arguments: {} }),
    );
    expect(response.status).toBe(200);
    expect(await rpc(response)).toMatchObject({
      result: { structuredContent: { resources: [{ id: 'vehicle-1' }] } },
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
