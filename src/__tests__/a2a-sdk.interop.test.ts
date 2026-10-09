// Slotlock against the OFFICIAL A2A JavaScript SDK (@a2a-js/sdk, pinned in devDependencies), whose
// types are generated from a2a.proto. Parsing the card with the SDK's own AgentCard.fromJSON is how
// this file proves the card has the protocol's shape rather than one Slotlock invented.
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SLOTLOCK_A2A_PROTOCOL_VERSION } from '../agent-server.js';
import { FIXTURE_TOKEN, type SlotlockFixture, startSlotlockFixture } from './helpers/agent-fixture.js';

const AUTH = { serviceParameters: { Authorization: `Bearer ${FIXTURE_TOKEN}` } };

let fixture: SlotlockFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function connect(current: SlotlockFixture) {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({})],
      cardResolver: new DefaultAgentCardResolver({}),
    }),
  );
  return factory.createFromUrl(`${current.origin}/slotlock/`);
}

function invocation(messageId: string, skill: string, args: Record<string, unknown>) {
  return SendMessageRequest.fromJSON({
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ data: { skill, arguments: args }, mediaType: 'application/json' }],
    },
  });
}

/** The single data part of a synchronous Slotlock reply. */
function replyData(reply: unknown): unknown {
  const parts = (reply as { parts?: Array<{ content?: { $case?: string; value?: unknown } }> })
    .parts;
  const content = parts?.[0]?.content;
  return content?.$case === 'data' ? content.value : undefined;
}

describe('Slotlock with the official A2A JavaScript SDK', () => {
  it('speaks the same protocol version as the SDK', () => {
    expect(SLOTLOCK_A2A_PROTOCOL_VERSION).toBe(A2A_PROTOCOL_VERSION);
  });

  it('publishes a card whose security requirement and skills survive the proto schema', async () => {
    fixture = await startSlotlockFixture();
    const response = await fetch(`${fixture.origin}/slotlock/.well-known/agent-card.json`);
    const raw = (await response.json()) as { skills: Array<Record<string, unknown>> };
    const card = AgentCard.fromJSON(raw);

    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
    expect(card.skills).toHaveLength(8);
    for (const skill of card.skills) {
      expect(skill.examples.length).toBeGreaterThan(0);
      expect(JSON.parse(skill.examples[0] ?? '{}')).toMatchObject({ skill: skill.id });
    }
    // Nothing outside AgentSkill: a proto parser would silently drop it.
    for (const skill of raw.skills) expect(skill).not.toHaveProperty('metadata');

    // The A2A discovery location is the origin root; Slotlock answers it too.
    const root = await fetch(`${fixture.origin}/.well-known/agent-card.json`);
    expect(root.status).toBe(200);
    expect(AgentCard.fromJSON(await root.json()).name).toBe(card.name);
  });

  it('invokes a skill and returns its result as the agent reply', async () => {
    fixture = await startSlotlockFixture();
    const client = await connect(fixture);

    const reply = await client.sendMessage(
      invocation('interop-list', 'calendar_list_resources', { limit: 2 }),
      AUTH,
    );
    expect(replyData(reply)).toEqual({
      resources: [{ id: 'resource-1', external_ref: 'vehicle-1', timezone: 'Europe/London' }],
      next_cursor: null,
    });
  });

  it('returns a skill failure as an agent reply the SDK does not throw on', async () => {
    fixture = await startSlotlockFixture();
    const client = await connect(fixture);

    const missing = await client.sendMessage(
      invocation('interop-missing', 'calendar_get_event', { event_id: 'missing' }),
      AUTH,
    );
    expect(replyData(missing)).toEqual({ error: { code: 'not_found' } });

    const invalid = await client.sendMessage(
      invocation('interop-invalid', 'calendar_list_events', { resource_ids: [] }),
      AUTH,
    );
    expect(replyData(invalid)).toEqual({ error: { code: 'invalid_arguments' } });
  });

  it('still executes a skill addressed by its legacy dotted name', async () => {
    fixture = await startSlotlockFixture();
    const client = await connect(fixture);

    const reply = await client.sendMessage(
      invocation('interop-legacy', 'calendar.list_resources', { limit: 1 }),
      AUTH,
    );
    expect(replyData(reply)).toMatchObject({ next_cursor: null });
    expect(fixture.backend.listResources).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'calendar_list_resources' }),
      { limit: 1 },
    );
  });

  it('answers the core task methods as an agent that keeps no tasks', async () => {
    fixture = await startSlotlockFixture();
    const client = await connect(fixture);

    await expect(
      client.getTask(GetTaskRequest.fromJSON({ id: 'task-1' }), AUTH),
    ).rejects.toMatchObject({ envelopeCode: -32001 });
    await expect(
      client.cancelTask(CancelTaskRequest.fromJSON({ id: 'task-1' }), AUTH),
    ).rejects.toMatchObject({ envelopeCode: -32001 });
    await expect(
      client.listTasks(ListTasksRequest.fromJSON({ pageSize: 10 }), AUTH),
    ).resolves.toEqual({ tasks: [], nextPageToken: '', pageSize: 10, totalSize: 0 });
  });
});
