// Confirm-before-write on MCP 2026-07-28: a configured write returns `input_required` with a form
// elicitation, and runs only when the retry carries the sealed `requestState` and an explicit
// acceptance (basic/patterns/mrtr; client/elicitation). Everything that is not an acceptance of
// exactly this call by exactly this principal must leave the calendar untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentServerEvent,
  createSlotlockAgentServer,
} from '../agent-server.js';

const createEvent = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();
const listResources = vi.fn();
const authorize = vi.fn();
const onEvent = vi.fn<(event: SlotlockAgentServerEvent) => void>();

const backend: SlotlockAgentCalendarBackend = {
  listResources,
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  createEvent,
  getEvent: vi.fn(),
  listEvents: vi.fn(),
  updateEvent,
  deleteEvent,
};

const SECRET = 'confirmation-secret-0123456789abcdef';
const ROTATED = 'rotated-confirmation-secret-fedcba9876543210';
const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const FORM_CLIENT = { elicitation: { form: {} } };

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

let subject = 'principal-1';

function buildServer(
  overrides: Partial<Parameters<typeof createSlotlockAgentServer>[0]> = {},
  { confirm = true }: { confirm?: boolean } = {},
) {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    allowedOrigins: ['http://localhost'],
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer valid'
        ? { subject, tenantRef: 'tenant-a' }
        : null,
    authorize,
    health: async () => ({ ready: true, checks: [] }),
    ...(confirm
      ? {
          confirmation: {
            operations: [
              'calendar_create_event',
              'calendar_update_event',
              'calendar_delete_event',
            ] as const,
            secrets: [SECRET],
          },
        }
      : {}),
    onEvent,
    ...overrides,
  });
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = FORM_CLIENT,
): Request {
  return new Request('http://localhost/slotlock/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${Math.random()}`,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...extra,
        _meta: {
          [PROTOCOL_VERSION_KEY]: SLOTLOCK_MCP_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_KEY]: capabilities,
        },
      },
    }),
  });
}

interface InputRequired {
  resultType: 'input_required';
  inputRequests: Record<
    string,
    { method: string; params: { mode: string; message: string; requestedSchema: unknown } }
  >;
  requestState: string;
}

async function prompt(
  server: ReturnType<typeof buildServer>,
  name = 'calendar_create_event',
  args: Record<string, unknown> = BOOKING,
): Promise<InputRequired> {
  const response = await server.fetch(toolCall(name, args));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: InputRequired };
  expect(body.result.resultType).toBe('input_required');
  return body.result;
}

function answer(
  state: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
) {
  return {
    requestState: state,
    inputResponses: { slotlock_confirm: { action, ...(content ? { content } : {}) } },
  };
}

async function toolError(response: Response): Promise<string> {
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  return (JSON.parse(body.result.content[0]?.text ?? '{}') as { error: { code: string } }).error
    .code;
}

describe('confirm-before-write (MCP 2026-07-28 input_required)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    subject = 'principal-1';
    authorize.mockResolvedValue(true);
    createEvent.mockResolvedValue({ event: EVENT, replayed: false });
    deleteEvent.mockResolvedValue({
      event_id: EVENT.id,
      revision: 2,
      deleted: true,
      replayed: false,
    });
    listResources.mockResolvedValue({ resources: [], next_cursor: null });
  });
  afterEach(() => vi.useRealTimers());

  it('asks for a form confirmation describing the booking and writes nothing', async () => {
    const result = await prompt(buildServer());
    expect(createEvent).not.toHaveBeenCalled();
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['resultType', 'inputRequests', 'requestState']),
    );
    expect(result).not.toHaveProperty('ttlMs');
    const request = result.inputRequests.slotlock_confirm;
    expect(request?.method).toBe('elicitation/create');
    expect(request?.params.mode).toBe('form');
    expect(request?.params.message).toBe(
      'Book "Vehicle handover" on resource vehicle-1: 2027-03-02 09:00–10:00 (Europe/London).',
    );
    expect(request?.params.requestedSchema).toEqual({
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Confirm this change',
          description: 'The agent changes the calendar only if this is ticked.',
          default: false,
        },
      },
      required: ['confirm'],
    });
    expect(result.requestState).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'calendar_create_event',
      outcome: 'requested',
    });
  });

  it('writes exactly once after an explicit acceptance of this exact call', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    const response = await server.fetch(
      toolCall('calendar_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { resultType: 'complete', structuredContent: { event: EVENT, replayed: false } },
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'calendar_create_event' }),
      expect.objectContaining({ idempotency_key: 'handover-2027-03-02' }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'calendar_create_event',
      outcome: 'accepted',
    });
  });

  it('never writes on a decline, a cancel or an unticked box', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    for (const [response, code] of [
      [answer(requestState, 'decline'), 'confirmation_declined'],
      [answer(requestState, 'cancel'), 'confirmation_cancelled'],
      [answer(requestState, 'accept', { confirm: false }), 'confirmation_declined'],
      [answer(requestState, 'accept'), 'confirmation_declined'],
    ] as const) {
      const reply = await server.fetch(toolCall('calendar_create_event', BOOKING, response));
      expect(await toolError(reply)).toBe(code);
    }
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('refuses state that was altered, belongs to another principal or another call', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    const [version, payload, mac] = requestState.split('.') as [string, string, string];
    // The final base64url character has unused bits: changing A to B can preserve the MAC.
    // Mutate a fully significant character and prove this fixture actually changes its bytes.
    const flipped = `${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;
    expect(Buffer.from(flipped, 'base64url')).not.toEqual(Buffer.from(mac, 'base64url'));
    const accept = { confirm: true };
    const refusals: Array<[Request, string]> = [
      [
        toolCall(
          'calendar_create_event',
          BOOKING,
          answer(`${version}.${payload}.${flipped}`, 'accept', accept),
        ),
        'altered MAC',
      ],
      [
        toolCall(
          'calendar_create_event',
          { ...BOOKING, title: 'Something else' },
          answer(requestState, 'accept', accept),
        ),
        'other arguments',
      ],
      [
        toolCall(
          'calendar_delete_event',
          { event_id: EVENT.id, expected_revision: 1, idempotency_key: 'delete-1' },
          answer(requestState, 'accept', accept),
        ),
        'other operation',
      ],
      [
        toolCall('calendar_create_event', BOOKING, answer('not-a-state', 'accept', accept)),
        'garbage',
      ],
      [
        toolCall(
          'calendar_create_event',
          BOOKING,
          answer(`${requestState}${'x'.repeat(2_100)}`, 'accept', accept),
        ),
        'oversized',
      ],
    ];
    for (const [request, why] of refusals) {
      const response = await server.fetch(request);
      expect(response.status, why).toBe(400);
      expect(await response.json(), why).toMatchObject({ error: { code: -32602 } });
    }

    subject = 'principal-2';
    const stolen = await server.fetch(
      toolCall('calendar_create_event', BOOKING, answer(requestState, 'accept', accept)),
    );
    expect(stolen.status).toBe(400);
    expect(createEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'calendar_create_event',
      outcome: 'refused',
    });
  });

  it('asks again when the confirmation expired or the answer is missing', async () => {
    vi.useFakeTimers({ now: new Date('2027-01-01T00:00:00Z'), toFake: ['Date'] });
    const server = buildServer({
      confirmation: { operations: ['calendar_create_event'], secrets: [SECRET], ttlSeconds: 60 },
    });
    const { requestState } = await prompt(server);
    vi.setSystemTime(new Date('2027-01-01T00:01:01Z'));
    const expired = await server.fetch(
      toolCall('calendar_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    const renewed = (await expired.json()) as { result: InputRequired };
    expect(renewed.result.resultType).toBe('input_required');
    expect(renewed.result.requestState).not.toBe(requestState);

    for (const extra of [
      { requestState: renewed.result.requestState },
      { inputResponses: { slotlock_confirm: { action: 'accept', content: { confirm: true } } } },
    ]) {
      const again = await server.fetch(toolCall('calendar_create_event', BOOKING, extra));
      expect(((await again.json()) as { result: InputRequired }).result.resultType).toBe(
        'input_required',
      );
    }
    expect(createEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'calendar_create_event',
      outcome: 'expired',
    });
  });

  it('refuses a malformed answer as invalid params', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    for (const inputResponses of [
      { slotlock_confirm: { action: 'maybe' } },
      { slotlock_confirm: 'accept' },
      { slotlock_confirm: { action: 'accept', content: ['confirm'] } },
    ]) {
      const response = await server.fetch(
        toolCall('calendar_create_event', BOOKING, { requestState, inputResponses }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    }
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('answers a client that cannot show a form with MissingRequiredClientCapability', async () => {
    const server = buildServer();
    for (const capabilities of [{}, { elicitation: { url: {} } }, { elicitation: [] }]) {
      const response = await server.fetch(
        toolCall('calendar_create_event', BOOKING, {}, capabilities),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: -32021,
          data: { requiredCapabilities: { elicitation: { form: {} } } },
        },
      });
    }
    // `elicitation: {}` declares form mode (client/elicitation §Capabilities).
    const empty = await server.fetch(
      toolCall('calendar_create_event', BOOKING, {}, { elicitation: {} }),
    );
    expect(((await empty.json()) as { result: InputRequired }).result.resultType).toBe(
      'input_required',
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('answers authorization and argument failures before asking anyone', async () => {
    const server = buildServer();
    authorize.mockResolvedValueOnce(false);
    expect(await toolError(await server.fetch(toolCall('calendar_create_event', BOOKING)))).toBe(
      'forbidden',
    );
    expect(
      await toolError(
        await server.fetch(toolCall('calendar_create_event', { ...BOOKING, ends_at: 'soon' })),
      ),
    ).toBe('invalid_arguments');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('runs unlisted operations and unconfigured servers without asking', async () => {
    const reads = await buildServer().fetch(toolCall('calendar_list_resources', {}, {}, {}));
    expect(await reads.json()).toMatchObject({ result: { resultType: 'complete' } });

    const unconfigured = await buildServer({}, { confirm: false }).fetch(
      toolCall('calendar_create_event', BOOKING, {}, {}),
    );
    expect(await unconfigured.json()).toMatchObject({ result: { resultType: 'complete' } });
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('fails closed with confirmation_required where no confirmation is possible: 2025 MCP and A2A', async () => {
    const server = buildServer();
    const legacy = await server.fetch(
      new Request('http://localhost/slotlock/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'legacy',
          method: 'tools/call',
          params: { name: 'calendar_create_event', arguments: BOOKING },
        }),
      }),
    );
    expect(await toolError(legacy)).toBe('confirmation_required');

    const a2a = await server.fetch(
      new Request('http://localhost/slotlock/a2a', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid',
          'Content-Type': 'application/json',
          'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'a2a',
          method: 'SendMessage',
          params: {
            message: {
              messageId: 'message-1',
              role: 'ROLE_USER',
              parts: [
                {
                  data: { skill: 'calendar_create_event', arguments: BOOKING },
                  mediaType: 'application/json',
                },
              ],
            },
          },
        }),
      }),
    );
    expect(await a2a.json()).toMatchObject({
      result: { message: { parts: [{ data: { error: { code: 'confirmation_required' } } }] } },
    });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('keeps accepting state sealed with a rotated-out key while it is still listed', async () => {
    const before = buildServer();
    const { requestState } = await prompt(before);
    const rotated = buildServer({
      confirmation: { operations: ['calendar_create_event'], secrets: [ROTATED, SECRET] },
    });
    const accepted = await rotated.fetch(
      toolCall('calendar_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(await accepted.json()).toMatchObject({ result: { resultType: 'complete' } });

    const retired = buildServer({
      confirmation: { operations: ['calendar_create_event'], secrets: [ROTATED] },
    });
    const refused = await retired.fetch(
      toolCall('calendar_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(refused.status).toBe(400);
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('describes updates and deletions by event and revision', async () => {
    const server = buildServer();
    const update = await prompt(server, 'calendar_update_event', {
      event_id: EVENT.id,
      expected_revision: 3,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      timezone: 'Europe/London',
      title: 'Moved‮handover\u0007',
      idempotency_key: 'move-1',
    });
    expect(update.inputRequests.slotlock_confirm?.params.message).toBe(
      `Change event ${EVENT.id} (revision 3): time to 2027-03-02 10:00–11:00 (Europe/London); title to "Movedhandover".`,
    );
    const removal = await prompt(server, 'calendar_delete_event', {
      event_id: EVENT.id,
      expected_revision: 3,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      `Delete event ${EVENT.id} (revision 3).`,
    );
  });

  it('refuses unusable confirmation settings when the server is built', () => {
    for (const confirmation of [
      { operations: ['calendar_create_event'], secrets: ['too-short'] },
      { operations: ['calendar_create_event'], secrets: [] },
      { operations: ['calendar_list_resources'], secrets: [SECRET] },
      { operations: [], secrets: [SECRET] },
      { operations: ['calendar_create_event'], secrets: [SECRET], ttlSeconds: 10 },
      { operations: ['calendar_create_event'], secrets: [SECRET], ttlSeconds: 3_601 },
    ]) {
      expect(() => buildServer({ confirmation: confirmation as never })).toThrowError(
        /confirmation/,
      );
    }
  });
});
