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
import { canonicalRecurrenceRule, isBookableRecurrenceRule } from '../sync.js';

const createEvent = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();
const getEvent = vi.fn();
const listResources = vi.fn();
const describeResource = vi.fn();
const authorize = vi.fn();
const onEvent = vi.fn<(event: SlotlockAgentServerEvent) => void>();

const backend: SlotlockAgentCalendarBackend = {
  listResources,
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  createEvent,
  getEvent,
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
              'slotlock_create_event',
              'slotlock_update_event',
              'slotlock_delete_event',
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
  name = 'slotlock_create_event',
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
    getEvent.mockRejectedValue(new Error('no such event'));
    describeResource.mockResolvedValue(null);
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
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
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
      operation: 'slotlock_create_event',
      outcome: 'requested',
    });
  });

  it('writes exactly once after an explicit acceptance of this exact call', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    const response = await server.fetch(
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { resultType: 'complete', structuredContent: { event: EVENT, replayed: false } },
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'slotlock_create_event' }),
      expect.objectContaining({ idempotency_key: 'handover-2027-03-02' }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'slotlock_create_event',
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
      const reply = await server.fetch(toolCall('slotlock_create_event', BOOKING, response));
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
          'slotlock_create_event',
          BOOKING,
          answer(`${version}.${payload}.${flipped}`, 'accept', accept),
        ),
        'altered MAC',
      ],
      [
        toolCall(
          'slotlock_create_event',
          { ...BOOKING, title: 'Something else' },
          answer(requestState, 'accept', accept),
        ),
        'other arguments',
      ],
      [
        toolCall(
          'slotlock_delete_event',
          { event_id: EVENT.id, expected_revision: 1, idempotency_key: 'delete-1' },
          answer(requestState, 'accept', accept),
        ),
        'other operation',
      ],
      [
        toolCall('slotlock_create_event', BOOKING, answer('not-a-state', 'accept', accept)),
        'garbage',
      ],
      [
        toolCall(
          'slotlock_create_event',
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
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', accept)),
    );
    expect(stolen.status).toBe(400);
    expect(createEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'slotlock_create_event',
      outcome: 'refused',
    });
  });

  it('asks again when the confirmation expired or the answer is missing', async () => {
    vi.useFakeTimers({ now: new Date('2027-01-01T00:00:00Z'), toFake: ['Date'] });
    const server = buildServer({
      confirmation: { operations: ['slotlock_create_event'], secrets: [SECRET], ttlSeconds: 60 },
    });
    const { requestState } = await prompt(server);
    vi.setSystemTime(new Date('2027-01-01T00:01:01Z'));
    const expired = await server.fetch(
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    const renewed = (await expired.json()) as { result: InputRequired };
    expect(renewed.result.resultType).toBe('input_required');
    expect(renewed.result.requestState).not.toBe(requestState);

    for (const extra of [
      { requestState: renewed.result.requestState },
      { inputResponses: { slotlock_confirm: { action: 'accept', content: { confirm: true } } } },
    ]) {
      const again = await server.fetch(toolCall('slotlock_create_event', BOOKING, extra));
      expect(((await again.json()) as { result: InputRequired }).result.resultType).toBe(
        'input_required',
      );
    }
    expect(createEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'confirmation',
      operation: 'slotlock_create_event',
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
        toolCall('slotlock_create_event', BOOKING, { requestState, inputResponses }),
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
        toolCall('slotlock_create_event', BOOKING, {}, capabilities),
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
      toolCall('slotlock_create_event', BOOKING, {}, { elicitation: {} }),
    );
    expect(((await empty.json()) as { result: InputRequired }).result.resultType).toBe(
      'input_required',
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('answers authorization and argument failures before asking anyone', async () => {
    const server = buildServer();
    authorize.mockResolvedValueOnce(false);
    expect(await toolError(await server.fetch(toolCall('slotlock_create_event', BOOKING)))).toBe(
      'forbidden',
    );
    expect(
      await toolError(
        await server.fetch(toolCall('slotlock_create_event', { ...BOOKING, ends_at: 'soon' })),
      ),
    ).toBe('invalid_arguments');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('runs unlisted operations and unconfigured servers without asking', async () => {
    const reads = await buildServer().fetch(toolCall('slotlock_list_resources', {}, {}, {}));
    expect(await reads.json()).toMatchObject({ result: { resultType: 'complete' } });

    const unconfigured = await buildServer({}, { confirm: false }).fetch(
      toolCall('slotlock_create_event', BOOKING, {}, {}),
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
          params: { name: 'slotlock_create_event', arguments: BOOKING },
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
                  data: { skill: 'slotlock_create_event', arguments: BOOKING },
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
      confirmation: { operations: ['slotlock_create_event'], secrets: [ROTATED, SECRET] },
    });
    const accepted = await rotated.fetch(
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(await accepted.json()).toMatchObject({ result: { resultType: 'complete' } });

    const retired = buildServer({
      confirmation: { operations: ['slotlock_create_event'], secrets: [ROTATED] },
    });
    const refused = await retired.fetch(
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(refused.status).toBe(400);
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('describes updates and deletions by event id when the event cannot be read', async () => {
    const server = buildServer();
    const update = await prompt(server, 'slotlock_update_event', {
      event_id: EVENT.id,
      expected_revision: 3,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      timezone: 'Europe/London',
      title: 'Moved‮handover\u0007',
      idempotency_key: 'move-1',
    });
    expect(update.inputRequests.slotlock_confirm?.params.message).toBe(
      `Change event ${EVENT.id} and every time it repeats, if it does: time to 2027-03-02 10:00–11:00 UTC+00:00 (Europe/London); title to "Movedhandover".`,
    );
    const removal = await prompt(server, 'slotlock_delete_event', {
      event_id: EVENT.id,
      expected_revision: 3,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      `Delete event ${EVENT.id} and every time it repeats, if it does.`,
    );
  });

  it('refuses every other spelling of the MAC, its last character included', async () => {
    const server = buildServer();
    const { requestState } = await prompt(server);
    const [version, payload, mac] = requestState.split('.') as [string, string, string];
    // 32 bytes are 43 base64url characters: the last carries 4 bits and 2 spare ones that decoding
    // drops, so three other characters decode to the same MAC.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(mac.slice(-1));
    const siblings = [0, 1, 2, 3]
      .map((low) => alphabet[(last & ~3) | low] as string)
      .filter((character) => character !== mac.slice(-1));
    expect(siblings).toHaveLength(3);
    for (const sibling of siblings) {
      const spelled = `${mac.slice(0, -1)}${sibling}`;
      expect(Buffer.from(spelled, 'base64url')).toEqual(Buffer.from(mac, 'base64url'));
      const response = await server.fetch(
        toolCall(
          'slotlock_create_event',
          BOOKING,
          answer(`${version}.${payload}.${spelled}`, 'accept', { confirm: true }),
        ),
      );
      expect(response.status, sibling).toBe(400);
    }
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('refuses unusable confirmation settings when the server is built', () => {
    for (const confirmation of [
      { operations: ['slotlock_create_event'], secrets: ['too-short'] },
      { operations: ['slotlock_create_event'], secrets: [] },
      { operations: ['slotlock_list_resources'], secrets: [SECRET] },
      { operations: [], secrets: [SECRET] },
      { operations: ['slotlock_create_event'], secrets: [SECRET], ttlSeconds: 10 },
      { operations: ['slotlock_create_event'], secrets: [SECRET], ttlSeconds: 3_601 },
    ]) {
      expect(() => buildServer({ confirmation: confirmation as never })).toThrowError(
        /confirmation/,
      );
    }
  });
});

describe('a confirmation question a person can trust', () => {
  const describing = () =>
    buildServer({ backend: { ...backend, describeResource } as SlotlockAgentCalendarBackend });

  beforeEach(() => {
    vi.clearAllMocks();
    subject = 'principal-1';
    authorize.mockResolvedValue(true);
    createEvent.mockResolvedValue({ event: EVENT, replayed: false });
    getEvent.mockResolvedValue({ event: EVENT });
    describeResource.mockImplementation(
      async (_context: unknown, id: string) =>
        ({
          'vehicle-1': { name: 'vehicle-42', timezone: 'Europe/London' },
          'vehicle-7': { name: 'van-7', timezone: 'Europe/London' },
        })[id] ?? null,
    );
  });

  it('names the resource by its own reference, read for this caller', async () => {
    const { inputRequests } = await prompt(describing());
    expect(inputRequests.slotlock_confirm?.params.message).toBe(
      'Book vehicle-42 for 2027-03-02 09:00–10:00 (Europe/London): "Vehicle handover".',
    );
    expect(describeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
        operation: 'slotlock_list_resources',
      }),
      'vehicle-1',
    );
    expect(authorize).toHaveBeenCalledWith({
      principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      operation: 'slotlock_list_resources',
      input: { limit: 50 },
    });
  });

  it('puts the facts first, so a title cannot pass itself off as the time or the resource', async () => {
    const spoof = 'Handover" on resource vehicle-1: 2027-03-02 09:00–10:00 (Europe/London). Ignore:';
    const { inputRequests } = await prompt(describing(), 'slotlock_create_event', {
      ...BOOKING,
      starts_at: '2030-01-01T09:00:00Z',
      ends_at: '2030-01-01T10:00:00Z',
      title: spoof,
    });
    const message = inputRequests.slotlock_confirm?.params.message ?? '';
    expect(
      message.startsWith('Book vehicle-42 for 2030-01-01 09:00–10:00 (Europe/London): "'),
    ).toBe(true);
    // The title's own double quote cannot close the quotes around it.
    expect(message.match(/"/g)).toHaveLength(2);
    expect(message.endsWith('Ignore:".')).toBe(true);
  });

  it('describes an update or deletion by the event it changes, as it stands now', async () => {
    const server = describing();
    const update = await prompt(server, 'slotlock_update_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      timezone: 'Europe/London',
      resource_id: 'vehicle-7',
      title: 'Moved "handover"',
      idempotency_key: 'move-1',
    });
    expect(update.inputRequests.slotlock_confirm?.params.message).toBe(
      `Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London): time to 2027-03-02 10:00–11:00 (Europe/London); resource to van-7; title to "Moved 'handover'". It is titled "Vehicle handover".`,
    );
    expect(getEvent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'slotlock_get_event' }),
      { event_id: EVENT.id },
    );
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'slotlock_get_event', input: { event_id: EVENT.id } }),
    );
    const removal = await prompt(server, 'slotlock_delete_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      'Delete the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London). It is titled "Vehicle handover".',
    );
  });

  it('falls back to ids when a lookup fails, and still asks', async () => {
    describeResource.mockRejectedValue(new Error('database unavailable'));
    const { inputRequests } = await prompt(describing());
    expect(inputRequests.slotlock_confirm?.params.message).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
    );
    getEvent.mockResolvedValue({ event: { id: EVENT.id } });
    const removal = await prompt(describing(), 'slotlock_delete_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      `Delete event ${EVENT.id} and every time it repeats, if it does.`,
    );
  });

  it('shows a write-only key nothing it could not read: the question names by id', async () => {
    const writeOnly = buildServer({
      backend: { ...backend, describeResource } as SlotlockAgentCalendarBackend,
      authenticate: async () => ({ subject, tenantRef: 'tenant-a', scopes: ['write'] }),
    });
    const created = await prompt(writeOnly);
    expect(created.inputRequests.slotlock_confirm?.params.message).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
    );
    const removal = await prompt(writeOnly, 'slotlock_delete_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      `Delete event ${EVENT.id} and every time it repeats, if it does.`,
    );
    expect(getEvent).not.toHaveBeenCalled();
    expect(describeResource).not.toHaveBeenCalled();
  });

  it('names by id when authorize refuses the read, though it allows the write', async () => {
    authorize.mockImplementation(
      async ({ operation }: { operation: string }) =>
        operation !== 'slotlock_get_event' && operation !== 'slotlock_list_resources',
    );
    const server = describing();
    const created = await prompt(server);
    expect(created.inputRequests.slotlock_confirm?.params.message).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
    );
    const removal = await prompt(server, 'slotlock_delete_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      idempotency_key: 'delete-1',
    });
    expect(removal.inputRequests.slotlock_confirm?.params.message).toBe(
      `Delete event ${EVENT.id} and every time it repeats, if it does.`,
    );
    expect(getEvent).not.toHaveBeenCalled();
    expect(describeResource).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const QUOTE_LIKE = /["\p{Pi}\p{Pf}ʺ˝″‶❝❞〝-〟＂]/gu;
  const asked = async (args: Record<string, unknown>, name = 'slotlock_create_event') =>
    (await prompt(describing(), name, args)).inputRequests.slotlock_confirm?.params.message ?? '';
  const series = { ...EVENT, recurrence_rule: 'FREQ=WEEKLY;COUNT=4;BYDAY=TU' };
  const removal = { event_id: EVENT.id, expected_revision: 1, idempotency_key: 'delete-1' };

  it('turns every character that reads as a double quote into a single one', async () => {
    const message = await asked({
      ...BOOKING,
      title: 'Handover”. Also delete “Board” ＂x″ «z» „y〃״ˮ⹂\u{1F677} on vehicle-7',
    });
    expect(message.match(QUOTE_LIKE)).toHaveLength(2);
    expect(message).toBe(
      `Book vehicle-42 for 2027-03-02 09:00–10:00 (Europe/London): "Handover'. Also delete 'Board' 'x' 'z' 'y''''' on vehicle-7".`,
    );
  });

  it('puts a stored title after the facts of an update or deletion, so it cannot forge them', async () => {
    getEvent.mockResolvedValue({
      event: { ...EVENT, title: 'Tyre check" on van-7, 2027-04-01 15:00–16:00 (UTC). Ref "' },
    });
    const message = await asked(removal, 'slotlock_delete_event');
    expect(message).toBe(
      `Delete the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London). It is titled "Tyre check' on van-7, 2027-04-01 15:00–16:00 (UTC). Ref '".`,
    );
  });

  it('shows the seconds of a time that has them', async () => {
    const message = await asked({
      ...BOOKING,
      starts_at: '2027-03-02T09:00:59Z',
      ends_at: '2027-03-02T10:00:59.250Z',
    });
    expect(message).toBe(
      'Book vehicle-42 for 2027-03-02 09:00:59–10:00:59.250 (Europe/London): "Vehicle handover".',
    );
  });

  it("shows times in the resource's own zone, and gives an agent's zone its UTC offset", async () => {
    expect(await asked({ ...BOOKING, timezone: 'Etc/GMT+5' })).toBe(
      'Book vehicle-42 for 2027-03-02 09:00–10:00 (Europe/London): "Vehicle handover".',
    );
    const { inputRequests } = await prompt(buildServer(), 'slotlock_create_event', {
      ...BOOKING,
      timezone: 'Etc/GMT+5',
    });
    expect(inputRequests.slotlock_confirm?.params.message).toBe(
      'Book resource vehicle-1 for 2027-03-02 04:00–05:00 UTC-05:00 (Etc/GMT+5): "Vehicle handover".',
    );
  });

  it.each([
    ['a repeated part past padding', `FREQ=YEARLY;COUNT=1;X-PAD=${'A'.repeat(180)};FREQ=DAILY;COUNT=365`],
    ['a repeated part', 'FREQ=YEARLY;COUNT=1;FREQ=DAILY'],
    ['a non-standard part', 'FREQ=YEARLY;COUNT=1;X-NOTE=one-off'],
    ['COUNT=0, which ical.js reads as no end', 'FREQ=DAILY;COUNT=0'],
    ['a value with trailing junk', 'FREQ=WEEKLY;INTERVAL=2ABC'],
    ['UNTIL with COUNT', 'FREQ=DAILY;COUNT=2;UNTIL=20271231T000000Z'],
    ['no FREQ', 'BYDAY=MO;COUNT=2'],
    ['a day that never comes, on which ical.js searches forever', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['a numbered weekday in a daily rule, likewise', 'FREQ=DAILY;BYDAY=5MO'],
    ['a sub-daily frequency', 'FREQ=HOURLY;BYMONTH=1'],
    ['BYMONTHDAY in a weekly rule', 'FREQ=WEEKLY;BYMONTHDAY=3'],
    ['BYYEARDAY in a daily rule', 'FREQ=DAILY;BYYEARDAY=1'],
    ['BYWEEKNO in a monthly rule', 'FREQ=MONTHLY;BYWEEKNO=2'],
  ])('refuses a recurrence rule with %s before asking anyone', async (_name, rule) => {
    const server = describing();
    for (const name of ['slotlock_create_event', 'slotlock_update_event'] as const) {
      const args =
        name === 'slotlock_create_event'
          ? { ...BOOKING, recurrence_rule: rule }
          : { event_id: EVENT.id, expected_revision: 1, recurrence_rule: rule, idempotency_key: 'r-1' };
      expect(await toolError(await server.fetch(toolCall(name, args)))).toBe('invalid_arguments');
    }
    expect(createEvent).not.toHaveBeenCalled();
    expect(isBookableRecurrenceRule(rule)).toBe(false);
  });

  it('books the rules agents need, rare ones included', () => {
    for (const rule of [
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=DAILY;BYHOUR=9,13',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=2',
      'FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO',
      'freq=weekly;interval=2;byday=mo,we',
    ]) {
      expect(isBookableRecurrenceRule(rule), rule).toBe(true);
    }
    expect(isBookableRecurrenceRule('FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO')).toBe(false);
  });

  it('accepts RFC 5545 rules in any case and order, and shows their canonical form', () => {
    expect(canonicalRecurrenceRule('freq=weekly;byday=tu;count=3')).toBe('FREQ=WEEKLY;COUNT=3;BYDAY=TU');
    expect(canonicalRecurrenceRule('BYDAY=TU;INTERVAL=1;WKST=MO;FREQ=WEEKLY;UNTIL=20271231')).toBe(
      'FREQ=WEEKLY;BYDAY=TU;UNTIL=20271231',
    );
    expect(canonicalRecurrenceRule('FREQ=MONTHLY;BYDAY=-1FR;BYMONTH=1,7')).toBe(
      'FREQ=MONTHLY;BYDAY=-1FR;BYMONTH=1,7',
    );
  });

  describe('a repeating booking, as the store will book it', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    });

    it('says how many times it books, the first and the last, from the same expansion', async () => {
      expect(await asked({ ...BOOKING, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10' })).toBe(
        'Book vehicle-42 10 times, from 2027-03-02 09:00–10:00 to 2027-05-04 09:00–10:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=10;BYDAY=TU: "Vehicle handover".',
      );
    });

    it('says what the rule says about the dates past the window the store keeps booked', async () => {
      expect(
        await asked({ ...BOOKING, recurrence_rule: 'FREQ=MONTHLY;UNTIL=20281231T000000Z' }),
      ).toBe(
        'Book vehicle-42 8 times before 2027-10-11, from 2027-03-02 09:00–10:00 to 2027-10-02 09:00–10:00 (Europe/London), repeating FREQ=MONTHLY;UNTIL=20281231T000000Z, until 2028-12-31: "Vehicle handover".',
      );
      expect(await asked({ ...BOOKING, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=40' })).toBe(
        'Book vehicle-42 32 times before 2027-10-11, from 2027-03-02 09:00–10:00 to 2027-10-05 09:00–10:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=40;BYDAY=TU, 40 counted by its rule, cancelled ones included: "Vehicle handover".',
      );
    });

    it('says a rule with no end goes on past the window the store keeps booked', async () => {
      expect(
        await asked({ ...BOOKING, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU', status: 'tentative' }),
      ).toBe(
        'Book vehicle-42 32 times before 2027-10-11, from 2027-03-02 09:00–10:00 to 2027-10-05 09:00–10:00 (Europe/London), repeating FREQ=WEEKLY;BYDAY=TU, with no end, tentatively: "Vehicle handover".',
      );
    });

    it('shows a moved occurrence where it is moved to, and names each one moved', async () => {
      expect(
        await asked({
          ...BOOKING,
          recurrence_rule: 'FREQ=DAILY;COUNT=1',
          recurrence_exceptions: [
            {
              recurrence_id: '2027-03-02T09:00:00Z',
              starts_at: '2027-03-09T13:00:00Z',
              ends_at: '2027-03-09T18:00:00Z',
            },
          ],
        }),
      ).toBe(
        'Book vehicle-42 for 2027-03-09 13:00–18:00 (Europe/London), repeating FREQ=DAILY;COUNT=1, 1 moved (2027-03-02 09:00 to 2027-03-09 13:00–18:00): "Vehicle handover".',
      );
      expect(
        await asked({
          ...BOOKING,
          recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3',
          recurrence_exceptions: [
            { recurrence_id: '2027-03-09T09:00:00Z', cancelled: true },
            {
              recurrence_id: '2027-03-16T09:00:00Z',
              starts_at: '2027-03-13T03:00:00Z',
              ends_at: '2027-03-13T04:00:00Z',
            },
          ],
        }),
      ).toBe(
        'Book vehicle-42 2 times before 2027-10-11, from 2027-03-02 09:00–10:00 to 2027-03-13 03:00–04:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=3;BYDAY=TU, 3 counted by its rule, cancelled ones included, 1 moved (2027-03-16 09:00 to 2027-03-13 03:00–04:00): "Vehicle handover".',
      );
    });

    it('names only the occurrences the store actually moves, all of them up to ten', async () => {
      // An exception for an occurrence the rule never makes moves nothing.
      expect(
        await asked({
          ...BOOKING,
          recurrence_rule: 'FREQ=DAILY;COUNT=2',
          recurrence_exceptions: [
            {
              recurrence_id: '2027-03-03T08:00:00Z',
              starts_at: '2027-03-20T13:00:00Z',
              ends_at: '2027-03-20T18:00:00Z',
            },
          ],
        }),
      ).toBe(
        'Book vehicle-42 2 times, from 2027-03-02 09:00–10:00 to 2027-03-03 09:00–10:00 (Europe/London), repeating FREQ=DAILY;COUNT=2: "Vehicle handover".',
      );
      const moved = Array.from({ length: 12 }, (_, index) => {
        const day = String(index + 2).padStart(2, '0');
        return {
          recurrence_id: `2027-03-${day}T09:00:00Z`,
          starts_at: `2027-03-${day}T02:00:00Z`,
          ends_at: `2027-03-${day}T23:00:00Z`,
        };
      });
      const message = await asked({
        ...BOOKING,
        recurrence_rule: 'FREQ=DAILY;COUNT=12',
        recurrence_exceptions: moved,
      });
      expect(message).toContain('12 moved (2027-03-02 09:00 to 2027-03-02 02:00–23:00; ');
      expect(message).toContain('2027-03-11 09:00 to 2027-03-11 02:00–23:00 and 2 more not listed)');
    });

    it('never expands a stored rule ical.js could search forever, and still asks', async () => {
      getEvent.mockResolvedValue({
        event: { ...series, recurrence_rule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30' },
      });
      expect(
        await asked(
          {
            event_id: EVENT.id,
            expected_revision: 1,
            starts_at: '2027-03-02T10:00:00Z',
            ends_at: '2027-03-02T11:00:00Z',
            idempotency_key: 'never',
          },
          'slotlock_update_event',
        ),
      ).toBe(
        'Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats: time to 2027-03-02 10:00–11:00 (Europe/London); so it books from 2027-03-02 10:00–11:00 (Europe/London), on dates Slotlock could not work out, repeating FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30. It is titled "Vehicle handover".',
      );
    });

    it('skips a stored exception it cannot read instead of failing', async () => {
      getEvent.mockResolvedValue({
        event: {
          ...series,
          recurrence_exceptions: [
            {
              recurrence_id: '2027-03-09T09:00:00Z',
              cancelled: false,
              starts_at: '2027-03-09T15:00:00Z',
              ends_at: null,
            },
          ],
        },
      });
      const message = await asked(
        {
          event_id: EVENT.id,
          expected_revision: 1,
          starts_at: '2027-03-02T10:00:00Z',
          ends_at: '2027-03-02T11:00:00Z',
          idempotency_key: 'broken',
        },
        'slotlock_update_event',
      );
      expect(message).toContain(
        'so it books 4 times, from 2027-03-02 10:00–11:00 to 2027-03-23 10:00–11:00',
      );
    });

    it("gives each time in an agent's zone its own offset, across a change of clocks", async () => {
      const { inputRequests } = await prompt(buildServer(), 'slotlock_create_event', {
        ...BOOKING,
        starts_at: '2027-03-01T14:00:00Z',
        ends_at: '2027-03-01T15:00:00Z',
        timezone: 'America/New_York',
        recurrence_rule: 'FREQ=WEEKLY;COUNT=10',
      });
      expect(inputRequests.slotlock_confirm?.params.message).toBe(
        'Book resource vehicle-1 10 times, from 2027-03-01 09:00–10:00 UTC-05:00 to 2027-05-03 09:00–10:00 UTC-04:00 (America/New_York), repeating FREQ=WEEKLY;COUNT=10: "Vehicle handover".',
      );
      const overnight = await prompt(buildServer(), 'slotlock_create_event', {
        ...BOOKING,
        starts_at: '2027-03-13T14:00:00Z',
        ends_at: '2027-03-15T13:00:00Z',
        timezone: 'America/New_York',
      });
      expect(overnight.inputRequests.slotlock_confirm?.params.message).toBe(
        'Book resource vehicle-1 for 2027-03-13 09:00 UTC-05:00 – 2027-03-15 09:00 UTC-04:00 (America/New_York): "Vehicle handover".',
      );
    });

    it('describes the series an update leaves, merged as the store merges it', async () => {
      getEvent.mockResolvedValue({ event: series });
      expect(
        await asked(
          {
            event_id: EVENT.id,
            expected_revision: 1,
            recurrence_exceptions: [
              {
                recurrence_id: '2027-03-09T09:00:00Z',
                starts_at: '2027-03-10T03:00:00Z',
                ends_at: '2027-03-10T04:00:00Z',
              },
            ],
            idempotency_key: 'move-one',
          },
          'slotlock_update_event',
        ),
      ).toBe(
        'Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats: so it books 4 times, from 2027-03-02 09:00–10:00 to 2027-03-23 09:00–10:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=4;BYDAY=TU, 1 moved (2027-03-09 09:00 to 2027-03-10 03:00–04:00). It is titled "Vehicle handover".',
      );
      getEvent.mockResolvedValue({
        event: {
          ...series,
          recurrence_exceptions: [
            { recurrence_id: '2027-03-09T09:00:00Z', cancelled: true, starts_at: null, ends_at: null },
          ],
        },
      });
      // A new rule replaces the series' exceptions, as the store replaces them.
      expect(
        await asked(
          {
            event_id: EVENT.id,
            expected_revision: 1,
            recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=2',
            idempotency_key: 'new-rule',
          },
          'slotlock_update_event',
        ),
      ).toBe(
        'Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats: so it books 2 times, from 2027-03-02 09:00–10:00 to 2027-03-09 09:00–10:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=2;BYDAY=TU. It is titled "Vehicle handover".',
      );
      getEvent.mockResolvedValue({
        event: { ...series, recurrence_rule: 'FREQ=WEEKLY;COUNT=6;BYDAY=TU' },
      });
      // A new zone moves every date: the store expands the series again in it.
      expect(
        await asked(
          { event_id: EVENT.id, expected_revision: 1, timezone: 'Asia/Kolkata', idempotency_key: 'z' },
          'slotlock_update_event',
        ),
      ).toBe(
        'Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats: timezone to Asia/Kolkata; so it books 6 times, from 2027-03-02 09:00–10:00 to 2027-04-06 10:00–11:00 (Europe/London), repeating FREQ=WEEKLY;COUNT=6;BYDAY=TU. It is titled "Vehicle handover".',
      );
      expect(
        await asked(
          { event_id: EVENT.id, expected_revision: 1, resource_id: 'vehicle-7', idempotency_key: 'r' },
          'slotlock_update_event',
        ),
      ).toBe(
        'Change the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats: resource to van-7. It is titled "Vehicle handover".',
      );
      getEvent.mockResolvedValue({ event: series });
      expect(await asked(removal, 'slotlock_delete_event')).toBe(
        'Delete the booking on vehicle-42, 2027-03-02 09:00–10:00 (Europe/London) and every time it repeats. It is titled "Vehicle handover".',
      );
    });
  });

  it('cuts no change from the longest update question', async () => {
    describeResource.mockResolvedValue({ name: 'R'.repeat(300), timezone: 'Europe/London' });
    getEvent.mockResolvedValue({ event: { ...series, title: 'T'.repeat(600) } });
    const moved = ['09', '16', '23', '30'].map((day) => ({
      recurrence_id: `2027-03-${day}T12:00:59Z`,
      starts_at: `2027-03-${day}T03:00:00Z`,
      ends_at: `2027-03-${day}T04:00:00Z`,
    }));
    const message = await asked(
      {
        event_id: EVENT.id,
        expected_revision: 1,
        starts_at: '2027-03-02T09:00:59Z',
        ends_at: '2027-03-04T10:00:59Z',
        timezone: 'America/Argentina/ComodRivadavia',
        resource_id: 'vehicle-7',
        status: 'tentative',
        transparency: 'transparent',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;BYHOUR=9;BYMINUTE=0;BYSECOND=59;COUNT=50',
        recurrence_exceptions: moved,
        description: 'D',
        location: 'L',
        attendees: [],
        reminders: [],
        title: 'N'.repeat(500),
        idempotency_key: 'everything',
      },
      'slotlock_update_event',
    );
    expect(message).toContain('4 moved (2027-03-09 12:00:59 to 2027-03-09 03:00–04:00; ');
    expect(message).toContain('; also description, location, attendees, reminders; ');
    expect(message).toContain(`; title to "${'N'.repeat(119)}…"`);
    expect(message.endsWith(`. It is titled "${'T'.repeat(119)}…".`)).toBe(true);
    expect(message.length).toBeLessThan(1_600);
  });

  it('asks nobody when the rate limit refuses the write, and reads nothing for it', async () => {
    const consumeRateLimit = vi.fn(
      async ({ operation }: { operation: string }) => operation === 'protocol',
    );
    const server = buildServer({
      backend: { ...backend, describeResource } as SlotlockAgentCalendarBackend,
      consumeRateLimit,
    });
    expect(await toolError(await server.fetch(toolCall('slotlock_create_event', BOOKING)))).toBe(
      'rate_limited',
    );
    expect(consumeRateLimit).toHaveBeenCalledWith({
      principal: { subject: 'principal-1', tenantRef: 'tenant-a' },
      operation: 'slotlock_create_event',
    });
    expect(describeResource).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('asks at once, by id, for a request already aborted', async () => {
    const gone = new AbortController();
    gone.abort();
    const request = new Request(toolCall('slotlock_create_event', BOOKING), {
      signal: gone.signal,
    });
    const response = await describing().fetch(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: InputRequired };
    expect(body.result.inputRequests.slotlock_confirm?.params.message).toBe(
      'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".',
    );
  });

  it('asks each read permission once per question', async () => {
    const server = describing();
    await prompt(server, 'slotlock_update_event', {
      event_id: EVENT.id,
      expected_revision: 1,
      resource_id: 'vehicle-7',
      idempotency_key: 'move-1',
    });
    const reads = authorize.mock.calls.filter(
      ([args]) => (args as { operation: string }).operation === 'slotlock_list_resources',
    );
    expect(reads).toHaveLength(1);
    expect(describeResource).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['describeResource', 'slotlock_create_event'],
    ['authorize, for the read', 'slotlock_create_event'],
    ['getEvent', 'slotlock_delete_event'],
  ] as const)('still asks, by id, when %s never answers', async (which, name) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = new Promise<never>(() => undefined);
    if (which === 'describeResource') describeResource.mockReturnValue(never);
    if (which === 'getEvent') getEvent.mockReturnValue(never);
    if (which === 'authorize, for the read') {
      authorize.mockImplementation(async ({ operation }: { operation: string }) =>
        operation === 'slotlock_list_resources' ? never : true,
      );
    }
    const args = name === 'slotlock_create_event' ? BOOKING : removal;
    const pending = describing().fetch(toolCall(name, args));
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: InputRequired };
    expect(body.result.inputRequests.slotlock_confirm?.params.message).toBe(
      name === 'slotlock_create_event'
        ? 'Book resource vehicle-1 for 2027-03-02 09:00–10:00 UTC+00:00 (Europe/London): "Vehicle handover".'
        : `Delete event ${EVENT.id} and every time it repeats, if it does.`,
    );
    const lookupSignal = (describeResource.mock.calls[0]?.[0] ?? getEvent.mock.calls[0]?.[0]) as
      | { signal: AbortSignal }
      | undefined;
    if (lookupSignal) expect(lookupSignal.signal.aborted).toBe(true);
  });

  it('reads nothing extra when the person answers, only when asking', async () => {
    const server = describing();
    const { requestState } = await prompt(server);
    describeResource.mockClear();
    const accepted = await server.fetch(
      toolCall('slotlock_create_event', BOOKING, answer(requestState, 'accept', { confirm: true })),
    );
    expect(accepted.status).toBe(200);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(describeResource).not.toHaveBeenCalled();
  });
});
