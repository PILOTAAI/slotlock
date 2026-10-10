// Slotlock against the OFFICIAL MCP TypeScript SDK v2 client (@modelcontextprotocol/client, pinned in
// devDependencies) over real Streamable HTTP. v2 implements MCP 2026-07-28: it probes with
// `server/discover`, then sends every request with the `_meta` envelope and the mirrored headers.
// A mock can only confirm what its author believed; this file is the contract that a stock
// 2026-07-28 client negotiates the modern era, calls tools, reads resources, confirms a booking
// through its elicitation handler and receives live resource updates.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SLOTLOCK_AGENT_SERVER_VERSION,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE,
  SlotlockAgentOperationError,
  slotlockAgentTools,
  slotlockCalendarResourceUri,
} from '../agent-server.js';
import { FIXTURE_TOKEN, type SlotlockFixture, startSlotlockFixture } from './helpers/agent-fixture.js';

let fixture: SlotlockFixture | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await fixture?.close();
  client = undefined;
  fixture = undefined;
});

type NegotiationMode = 'auto' | 'legacy' | { pin: string };

async function connect(
  current: SlotlockFixture,
  mode: NegotiationMode,
  capabilities: Record<string, unknown> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${current.origin}/slotlock/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` } },
  });
  client = new Client(
    { name: 'slotlock-v2-interop', version: '1.0.0' },
    { versionNegotiation: { mode }, capabilities },
  );
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: unknown }): string {
  const [first] = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return first?.type === 'text' ? (first.text ?? '') : '';
}

describe('Slotlock with the official MCP TypeScript SDK v2 (MCP 2026-07-28)', () => {
  it('negotiates the stateless era through server/discover and calls tools', async () => {
    fixture = await startSlotlockFixture();
    const connected = await connect(fixture, 'auto');

    expect(connected.getProtocolEra()).toBe('modern');
    expect(connected.getNegotiatedProtocolVersion()).toBe(SLOTLOCK_MCP_PROTOCOL_VERSION);
    expect(connected.getServerVersion()).toEqual({
      name: 'slotlock',
      version: SLOTLOCK_AGENT_SERVER_VERSION,
    });
    expect(connected.getInstructions()).toContain('idempotency_key');
    expect(connected.getServerCapabilities()).toMatchObject({
      tools: {},
      resources: { subscribe: true },
    });

    const { tools } = await connected.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(slotlockAgentTools().map((tool) => tool.name));

    const listed = await connected.callTool({
      name: 'slotlock_list_resources',
      arguments: { limit: 5 },
    });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual({
      resources: [{ id: 'resource-1', external_ref: 'vehicle-1', timezone: 'Europe/London' }],
      next_cursor: null,
    });

    // A tool failure is a result the model reads, not an exception.
    const failed = await connected.callTool({
      name: 'slotlock_get_event',
      arguments: { event_id: 'missing' },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.parse(textOf(failed))).toEqual({ error: { code: 'not_found' } });
  });

  it('asks the person through the client elicitation handler before a booking is written', async () => {
    fixture = await startSlotlockFixture({
      confirmation: {
        operations: ['slotlock_create_event'],
        secrets: ['interop-confirmation-secret-0123456789'],
      },
    });
    const event = {
      id: 'agent:5e8ff9bf55ba3508199d22e984129be6b5b6a8a7e3e5f1f0d2b9ba0c4a6f7e21',
      resource_id: 'resource-1',
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
    fixture.backend.createEvent.mockImplementation(async () => ({ event, replayed: false }));
    const connected = await connect(fixture, 'auto', { elicitation: { form: {} } });
    const asked: string[] = [];
    let answer: { action: 'accept' | 'decline'; content?: Record<string, boolean> } = {
      action: 'accept',
      content: { confirm: true },
    };
    connected.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params.message);
      return answer;
    });
    const booking = {
      resource_id: 'resource-1',
      starts_at: '2027-03-02T09:00:00Z',
      ends_at: '2027-03-02T10:00:00Z',
      timezone: 'Europe/London',
      title: 'Vehicle handover',
      idempotency_key: 'interop-handover',
    };

    const booked = await connected.callTool({ name: 'slotlock_create_event', arguments: booking });
    expect(asked).toEqual([
      'Book resource resource-1 for 2027-03-02 09:00–10:00 (Europe/London): "Vehicle handover".',
    ]);
    expect(booked.isError).toBeFalsy();
    expect(booked.structuredContent).toEqual({ event, replayed: false });
    expect(fixture.backend.createEvent).toHaveBeenCalledTimes(1);

    answer = { action: 'decline' };
    const declined = await connected.callTool({
      name: 'slotlock_create_event',
      arguments: { ...booking, idempotency_key: 'interop-declined' },
    });
    expect(declined.isError).toBe(true);
    expect(JSON.parse(textOf(declined))).toEqual({ error: { code: 'confirmation_declined' } });
    expect(fixture.backend.createEvent).toHaveBeenCalledTimes(1);
  });

  it('lists and reads calendar resources, and delivers live updates through listen()', async () => {
    fixture = await startSlotlockFixture({ subscriptions: { pollIntervalMs: 1_000 } });
    const busy: { start: string; end: string }[] = [];
    fixture.backend.getFreeBusy.mockImplementation(async (_context, input) => {
      const resourceIds = input.resource_ids as string[];
      if (resourceIds.some((resourceId) => resourceId !== 'resource-1')) {
        throw new SlotlockAgentOperationError('not_found', 404);
      }
      return {
        resources: resourceIds.map((resourceId) => ({
          resource_id: resourceId,
          busy: [...busy],
          coverage: { start: input.start, end: input.end, certainty: 'certain', reason: null },
        })),
      };
    });
    const connected = await connect(fixture, 'auto');
    const uri = slotlockCalendarResourceUri('resource-1');

    const { resources } = await connected.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([SLOTLOCK_MCP_APP_RESOURCE_URI, uri]);
    const { resourceTemplates } = await connected.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE,
    ]);
    const [content] = (await connected.readResource({ uri })).contents;
    expect(content && 'text' in content ? JSON.parse(content.text) : null).toMatchObject({
      resource_id: 'resource-1',
      busy: [],
      coverage: { certainty: 'certain' },
    });

    const updates: string[] = [];
    let announced: () => void = () => {};
    const updated = new Promise<void>((resolve) => {
      announced = resolve;
    });
    connected.setNotificationHandler('notifications/resources/updated', (notification) => {
      updates.push(notification.params.uri);
      announced();
    });
    const subscription = await connected.listen({
      resourceSubscriptions: [uri, 'slotlock://resources/missing'],
      toolsListChanged: true,
    });
    // The acknowledgment names only what the server honors.
    expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: [uri] });

    busy.push({ start: '2027-03-02T09:00:00.000Z', end: '2027-03-02T10:00:00.000Z' });
    await updated;
    expect(updates).toEqual([uri]);
    const [changed] = (await connected.readResource({ uri })).contents;
    expect(changed && 'text' in changed ? JSON.parse(changed.text).busy : null).toEqual(busy);

    await subscription.close();
    expect(await subscription.closed).toBe('local');
  });

  it('ends an open subscription gracefully when the Node listener closes', async () => {
    fixture = await startSlotlockFixture();
    fixture.backend.getFreeBusy.mockImplementation(async (_context, input) => ({
      resources: (input.resource_ids as string[]).map((resourceId) => ({
        resource_id: resourceId,
        busy: [],
        coverage: { start: input.start, end: input.end, certainty: 'certain', reason: null },
      })),
    }));
    const connected = await connect(fixture, 'auto');
    const subscription = await connected.listen({
      resourceSubscriptions: [slotlockCalendarResourceUri('resource-1')],
    });
    // The listener ends the stream with the listen result instead of waiting out its grace period.
    expect(await fixture.close()).toEqual({ forced: false });
    expect(await subscription.closed).toBe('graceful');
  });

  it('connects pinned to 2026-07-28, and a v2 client left on its default legacy mode still gets 2025-11-25', async () => {
    fixture = await startSlotlockFixture();
    const pinned = await connect(fixture, { pin: SLOTLOCK_MCP_PROTOCOL_VERSION });
    expect(pinned.getNegotiatedProtocolVersion()).toBe(SLOTLOCK_MCP_PROTOCOL_VERSION);
    expect((await pinned.listTools()).tools).toHaveLength(8);
    await pinned.close();

    const legacy = await connect(fixture, 'legacy');
    expect(legacy.getProtocolEra()).toBe('legacy');
    expect(legacy.getNegotiatedProtocolVersion()).toBe(SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION);
    expect((await legacy.listTools()).tools).toHaveLength(8);
  });
});
