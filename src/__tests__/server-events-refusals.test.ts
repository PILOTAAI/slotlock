// What `onEvent` hears about calls refused before they run, and in what order a confirmation and
// the call it decided are reported; that a hook which rejects changes nothing; and which A2A errors
// carry a google.rpc.ErrorInfo (A2A's own, not JSON-RPC's), as SPEC.md says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentServerEvent,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
} from '../agent-server.js';

const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';
const BASE = 'http://localhost/slotlock';
const SECRET = 'confirmation-secret-0123456789abcdef';
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
const events = () =>
  onEvent.mock.calls.map(([event]) => [
    event.type,
    'outcome' in event ? event.outcome : event.status,
  ]);

function server(overrides: Partial<SlotlockAgentServerOptions> = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: BASE,
    allowInsecureLocalhost: true,
    backend,
    rest: true,
    authenticate: async () => ({ subject: 'principal-1', tenantRef: 'tenant-a' }),
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    onEvent,
    ...overrides,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, raw = false) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const A2A = { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION };
const sendMessage = (skill: string) => ({
  jsonrpc: '2.0',
  id: 'm-1',
  method: 'SendMessage',
  params: {
    message: {
      messageId: 'message-1',
      role: 'ROLE_USER',
      parts: [{ data: { skill, arguments: {} }, mediaType: 'application/json' }],
    },
  },
});

function modernCall(args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return post(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 'c-1',
      method: 'tools/call',
      params: {
        name: 'slotlock_create_event',
        arguments: args,
        ...extra,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': SLOTLOCK_MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
      },
    },
    {
      'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'slotlock_create_event',
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listResources.mockResolvedValue({ resources: [], next_cursor: null });
  createEvent.mockResolvedValue({ event: EVENT, replayed: false });
});

describe('A2A errors', () => {
  const cases: Array<[string, () => Request, number, boolean, () => void]> = [
    ['unparseable JSON', () => post('/a2a', '{"jsonrpc":', A2A, true), -32700, false, () => {}],
    ['not a request object', () => post('/a2a', [1], A2A), -32600, false, () => {}],
    [
      'an unknown method',
      () => post('/a2a', { jsonrpc: '2.0', id: 1, method: 'message/send' }, A2A),
      -32601,
      false,
      () => {},
    ],
    [
      'a server fault',
      () => post('/a2a', sendMessage('slotlock_list_resources'), A2A),
      -32603,
      false,
      () => listResources.mockRejectedValueOnce(new Error('db down')),
    ],
    [
      'an A2A-Version other than 1.0',
      () => post('/a2a', sendMessage('slotlock_list_resources')),
      -32009,
      true,
      () => {},
    ],
    [
      'a message that is not one data part',
      () => post('/a2a', { ...sendMessage('x'), params: { message: { parts: [] } } }, A2A),
      -32602,
      true,
      () => {},
    ],
  ];
  for (const [name, request, code, withInfo, arrange] of cases) {
    it(`${name}: ${code} in a 200, ${withInfo ? 'with' : 'without'} an ErrorInfo`, async () => {
      arrange();
      const response = await server().fetch(request());
      const body = (await response.json()) as {
        error: { code: number; data?: Array<{ '@type': string }> };
      };
      expect({
        status: response.status,
        code: body.error.code,
        info: body.error.data?.[0]?.['@type'] ?? null,
      }).toEqual({ status: 200, code, info: withInfo ? ERROR_INFO : null });
    });
  }
});

describe('calls refused before they run', () => {
  const confirming = {
    confirmation: { operations: ['slotlock_create_event'] as const, secrets: [SECRET] },
  };

  it('reports each confirmation before the call it decided, on every protocol', async () => {
    const s = server(confirming);
    // MCP 2025: the write cannot be confirmed.
    await s.fetch(
      post(
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'slotlock_create_event', arguments: BOOKING },
        },
        { 'MCP-Protocol-Version': '2025-11-25' },
      ),
    );
    const legacy = events();
    onEvent.mockClear();
    // MCP 2026-07-28: asked, then accepted.
    const asked = (await (await s.fetch(modernCall(BOOKING))).json()) as {
      result: { requestState: string };
    };
    await s.fetch(
      modernCall(BOOKING, {
        requestState: asked.result.requestState,
        inputResponses: { slotlock_confirm: { action: 'accept', content: { confirm: true } } },
      }),
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect({ legacy, modern: events() }).toEqual({
      legacy: [
        ['confirmation', 'unavailable'],
        ['call', 'confirmation_required'],
      ],
      modern: [
        ['confirmation', 'requested'],
        ['call', 'confirmation_required'],
        ['confirmation', 'accepted'],
        ['call', 'ok'],
      ],
    });
  });

  it('reports a REST call refused before it runs, by its status', async () => {
    const s = server({ maxRequestBytes: 1_024 });
    const statuses = [
      // Not JSON by its media type, then by its body; too large; not an object.
      await s.fetch(post('/v1/events', BOOKING, { 'Content-Type': 'text/plain' })),
      await s.fetch(post('/v1/events', '{"resource_id":', {}, true)),
      await s.fetch(post('/v1/events', { ...BOOKING, title: 'x'.repeat(2_048) })),
      await s.fetch(post('/v1/events', [])),
    ].map((response) => response.status);
    expect(statuses).toEqual([415, 400, 413, 400]);
    expect(events()).toEqual([
      ['rest', 415],
      ['rest', 400],
      ['rest', 413],
      ['rest', 400],
    ]);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('reports nothing for a request refused before its operation is read', async () => {
    const s = server();
    // An A2A-Version other than 1.0 is refused before the message is read.
    await s.fetch(post('/a2a', sendMessage('slotlock_list_resources')));
    // A path that names no route, and one whose parameter is not valid percent-encoding.
    await s.fetch(new Request(`${BASE}/v1/nothing`));
    await s.fetch(new Request(`${BASE}/v1/events/%E0%A4%A`));
    expect(events()).toEqual([]);
  });
});

describe('a hook that rejects changes nothing', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', record);
  });
  afterEach(() => {
    process.off('unhandledRejection', record);
  });

  it('an async onEvent, and an async onError told of a server fault', async () => {
    const onError = vi.fn(async () => {
      throw new Error('the logger is down');
    });
    const s = server({
      onEvent: async () => {
        throw new Error('the collector is down');
      },
      onError,
    });
    const ok = await s.fetch(post('/a2a', sendMessage('slotlock_list_resources'), A2A));
    listResources.mockRejectedValueOnce(new Error('db down'));
    const fault = await s.fetch(post('/a2a', sendMessage('slotlock_list_resources'), A2A));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({
      ok: ok.status,
      fault: ((await fault.json()) as { error: { code: number } }).error.code,
      reported: onError.mock.calls.length,
      unhandled,
    }).toEqual({ ok: 200, fault: -32603, reported: 1, unhandled: [] });
  });
});
