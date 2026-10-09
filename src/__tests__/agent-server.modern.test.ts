// MCP 2026-07-28 (stateless, per-request `_meta`) on the Slotlock agent server, beside the 2025
// revisions. Every expectation below is quoted from the 2026-07-28 specification (basic §Messages,
// §Error Codes, §_meta; transports/streamable-http §Request Metadata, §Server Validation;
// server/discover; server/utilities/caching), read from the modelcontextprotocol repository on
// 2026-09-28.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_AGENT_SERVER_VERSION,
  SLOTLOCK_MCP_APPS_EXTENSION,
  SLOTLOCK_MCP_APP_MIME_TYPE,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type SlotlockAgentCalendarBackend,
  createSlotlockAgentServer,
  slotlockAgentTools,
} from '../agent-server.js';
import {
  CLIENT_CAPABILITIES_KEY,
  CLIENT_INFO_KEY,
  PROTOCOL_VERSION_KEY,
  SERVER_INFO_KEY,
  modernRequest,
  rpc,
} from './helpers/modern-mcp.js';

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

const SERVER_INFO = { name: 'slotlock', version: SLOTLOCK_AGENT_SERVER_VERSION };

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
    health: async () => ({ ready: true, checks: ['database'] }),
    ...overrides,
  });
}

describe('MCP 2026-07-28 on the Slotlock agent server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(true);
    listResources.mockResolvedValue({
      resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
      next_cursor: null,
    });
  });

  it('supports 2026-07-28 first and keeps both 2025 revisions', () => {
    expect(SLOTLOCK_MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
    ]);
  });

  it('answers server/discover with versions, capabilities, instructions and public cache hints', async () => {
    const response = await buildServer().fetch(modernRequest('server/discover'));
    expect(response.status).toBe(200);
    const body = await rpc(response);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: {
          tools: {},
          resources: { subscribe: true },
          extensions: { [SLOTLOCK_MCP_APPS_EXTENSION]: { mimeTypes: [SLOTLOCK_MCP_APP_MIME_TYPE] } },
        },
        instructions: expect.stringContaining('calendar_find_next_available'),
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
      },
    });
    // Discovery never touches tenant data.
    expect(authorize).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();
  });

  it('names only fields and codes a model will actually receive in its instructions', async () => {
    const body = await rpc(await buildServer().fetch(modernRequest('server/discover')));
    const instructions = (body.result as { instructions: string }).instructions;
    // Free/busy and next-available carry coverage.certainty ("certain" | "uncertain"), and a
    // refused overlapping write is the store's "overlap" code, passed through unchanged.
    expect(instructions).toContain('coverage.certainty is "certain"');
    expect(instructions).toContain('overlap means the slot is taken');
    expect(instructions).not.toContain('coverage.state');
    expect(instructions).not.toContain('reservation_conflict');
  });

  it('lists the 2025 tools in the same order every time, as JSON Schema 2020-12, with cache hints', async () => {
    const server = buildServer();
    const first = await rpc(await server.fetch(modernRequest('tools/list')));
    const second = await rpc(await server.fetch(modernRequest('tools/list')));
    expect(first).toEqual(second);
    expect(first.result).toEqual({
      resultType: 'complete',
      tools: slotlockAgentTools(),
      ttlMs: 3_600_000,
      cacheScope: 'public',
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });
    // No `$schema`, so 2020-12 is the dialect (basic §JSON Schema Usage): every schema must compile
    // under a strict 2020-12 validator.
    const ajv = new Ajv2020({ strict: true, validateFormats: false, allErrors: true });
    for (const tool of slotlockAgentTools()) {
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema)).not.toThrow();
    }
  });

  it('calls a tool with the 2025 result encoding plus resultType and serverInfo', async () => {
    const server = buildServer();
    const listed = await rpc(
      await server.fetch(
        modernRequest('tools/call', { name: 'calendar_list_resources', arguments: {} }),
      ),
    );
    expect(listed.result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: expect.any(String) }],
      structuredContent: {
        resources: [{ id: 'vehicle-1', external_ref: 'fleet-1', timezone: 'Europe/London' }],
        next_cursor: null,
      },
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });

    const failed = await rpc(
      await server.fetch(
        modernRequest('tools/call', { name: 'calendar_get_event', arguments: { event_id: '' } }),
      ),
    );
    expect(failed.result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: '{"error":{"code":"invalid_arguments"}}' }],
      isError: true,
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });

    const unknown = await server.fetch(modernRequest('tools/call', { name: 'calendar_teleport' }));
    expect(await rpc(unknown)).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects a request missing a required _meta field with 400 Invalid params', async () => {
    const server = buildServer();
    for (const request of [
      modernRequest('tools/list', {}, { meta: null }),
      modernRequest('tools/list', {}, { meta: { [PROTOCOL_VERSION_KEY]: undefined } }),
      modernRequest('tools/list', {}, { meta: { [PROTOCOL_VERSION_KEY]: 20260728 } }),
      modernRequest('tools/list', {}, { meta: { [CLIENT_CAPABILITIES_KEY]: undefined } }),
      modernRequest('tools/list', {}, { meta: { [CLIENT_CAPABILITIES_KEY]: ['elicitation'] } }),
      modernRequest('tools/list', {}, { meta: { [CLIENT_INFO_KEY]: { name: 'no-version' } } }),
    ]) {
      const response = await server.fetch(request);
      expect(response.status).toBe(400);
      expect(await rpc(response)).toMatchObject({ id: 'req-1', error: { code: -32602 } });
    }
  });

  it('rejects headers that are missing, malformed or disagree with the body with 400 HeaderMismatch', async () => {
    const server = buildServer();
    const call = { name: 'calendar_list_resources', arguments: {} };
    for (const request of [
      modernRequest('tools/list', {}, { headers: { 'MCP-Protocol-Version': null } }),
      modernRequest('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } }),
      modernRequest('tools/list', {}, { headers: { 'Mcp-Method': null } }),
      modernRequest('tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } }),
      modernRequest('tools/call', call, { headers: { 'Mcp-Name': null } }),
      modernRequest('tools/call', call, { headers: { 'Mcp-Name': 'calendar_get_event' } }),
      modernRequest('tools/call', call, { headers: { 'Mcp-Name': '=?base64?not base64?=' } }),
      modernRequest('tools/call', call, { headers: { 'Mcp-Name': '=?base64?//79?=' } }),
      modernRequest('tools/call', { ...call, name: 'café' }, { headers: { 'Mcp-Name': 'café' } }),
      modernRequest(
        'resources/read',
        { uri: 'ui://slotlock/calendar' },
        { headers: { 'Mcp-Name': 'x' } },
      ),
    ]) {
      const response = await server.fetch(request);
      expect(response.status).toBe(400);
      expect(await rpc(response)).toMatchObject({ id: 'req-1', error: { code: -32020 } });
    }
    expect(listResources).not.toHaveBeenCalled();

    // A header value is compared after decoding the Base64 sentinel.
    const encoded = await server.fetch(
      modernRequest('tools/call', call, {
        headers: {
          'Mcp-Name': `=?base64?${Buffer.from('calendar_list_resources').toString('base64')}?=`,
        },
      }),
    );
    expect(encoded.status).toBe(200);
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it('answers an unsupported revision with 400 UnsupportedProtocolVersion naming what it supports', async () => {
    const response = await buildServer().fetch(
      modernRequest(
        'tools/list',
        {},
        {
          meta: { [PROTOCOL_VERSION_KEY]: '2099-01-01' },
          headers: { 'MCP-Protocol-Version': '2099-01-01' },
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(await rpc(response)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: {
          supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
          requested: '2099-01-01',
        },
      },
    });
  });

  it('answers methods this revision removed or Slotlock does not serve with 404 Method not found', async () => {
    const server = buildServer();
    for (const method of [
      'ping',
      'logging/setLevel',
      'resources/subscribe',
      'completion/complete',
      'prompts/list',
      'tasks/get',
    ]) {
      const response = await server.fetch(modernRequest(method));
      expect(response.status).toBe(404);
      expect(await rpc(response)).toEqual({
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: -32601, message: 'Method not found' },
      });
    }
  });

  it('accepts a notification with 202 and runs nothing; a request needs a string or number id', async () => {
    const server = buildServer();
    const notification = await server.fetch(
      modernRequest(
        'notifications/cancelled',
        { requestId: 'req-0' },
        {
          id: 'none',
          headers: { 'Mcp-Method': null },
        },
      ),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');

    const nullId = await server.fetch(modernRequest('tools/list', {}, { id: null }));
    expect(nullId.status).toBe(400);
    expect(await rpc(nullId)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('keeps initialize on the 2025 lifecycle even when it carries 2026 metadata', async () => {
    const request = modernRequest('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'dual-era', version: '1.0.0' },
    });
    request.headers.delete('mcp-protocol-version');
    const response = await buildServer().fetch(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-protocol-version')).toBe(SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION);
    expect(await rpc(response)).toMatchObject({
      result: { protocolVersion: SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION },
    });
  });

  it('ignores Mcp-Session-Id and still refuses GET and DELETE with 405', async () => {
    const server = buildServer();
    const withSession = await server.fetch(
      modernRequest('tools/list', {}, { headers: { 'Mcp-Session-Id': 'stale-session' } }),
    );
    expect(withSession.status).toBe(200);
    expect(withSession.headers.get('mcp-session-id')).toBeNull();
    for (const method of ['GET', 'DELETE']) {
      const response = await server.fetch(
        new Request('http://localhost/slotlock/mcp', {
          method,
          headers: { Authorization: 'Bearer valid', 'MCP-Protocol-Version': '2026-07-28' },
        }),
      );
      expect(response.status).toBe(405);
    }
  });

  it('hands W3C trace context to the backend from _meta or HTTP headers, and drops malformed values', async () => {
    const server = buildServer();
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';
    const call = { name: 'calendar_list_resources', arguments: {} };
    await server.fetch(
      modernRequest('tools/call', call, {
        meta: { traceparent, tracestate: 'slotlock=00f067aa0ba902b7', baggage: 'tenant.tier=gold' },
      }),
    );
    expect(listResources.mock.calls.at(-1)?.[0]).toMatchObject({
      trace: { traceparent, tracestate: 'slotlock=00f067aa0ba902b7', baggage: 'tenant.tier=gold' },
    });

    // The 2025 revisions and A2A carry it too (HTTP headers when `_meta` has none).
    const legacy = new Request('http://localhost/slotlock/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
        traceparent,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy', method: 'tools/call', params: call }),
    });
    await server.fetch(legacy);
    expect(listResources.mock.calls.at(-1)?.[0]).toMatchObject({ trace: { traceparent } });

    for (const invalid of [
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
      'ff-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01-extra',
      'not-a-trace',
    ]) {
      await server.fetch(modernRequest('tools/call', call, { meta: { traceparent: invalid } }));
      expect(listResources.mock.calls.at(-1)?.[0]).not.toHaveProperty('trace');
    }
    await server.fetch(
      modernRequest('tools/call', call, {
        meta: { traceparent, tracestate: 'bad\u0001state', baggage: 'x'.repeat(8_193) },
      }),
    );
    expect(listResources.mock.calls.at(-1)?.[0]).toMatchObject({ trace: { traceparent } });
    expect(listResources.mock.calls.at(-1)?.[0].trace).toEqual({ traceparent });
  });

  it('answers a rate-limited 2026 request with a code outside the MCP-reserved range', async () => {
    const consumeRateLimit = vi.fn().mockResolvedValue(false);
    const server = buildServer({ consumeRateLimit });
    const modern = await server.fetch(modernRequest('tools/list'));
    expect(modern.status).toBe(429);
    const code = ((await rpc(modern)).error as { code: number }).code;
    // basic §Error Codes: -32020..-32099 belong to the MCP specification alone.
    expect(code <= -32020 && code >= -32099).toBe(false);
    expect(code).toBe(-31029);

    // A 2025 client keeps the code it has always seen.
    const legacy = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy', method: 'tools/list' }),
      }),
    );
    expect(legacy.status).toBe(429);
    expect(await rpc(legacy)).toMatchObject({ error: { code: -32029 } });
  });
});
