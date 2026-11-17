// Each answer's Slotlock-Request-Id, and with usage metering (onUsage) its Slotlock-Usage: the
// operations counted for it, on REST and MCP, none for a call refused before it runs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotlockAgentUsage } from '../agent-server.js';
import { FIXTURE_TOKEN, startSlotlockFixture } from './helpers/agent-fixture.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const mcp = (origin: string, body: unknown) =>
  fetch(`${origin}/slotlock/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FIXTURE_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify(body),
  });

describe('request ids and usage fields', () => {
  it('gives every answer a request id of its own, and no usage field without metering', async () => {
    const fixture = await startSlotlockFixture({ rest: true });
    close = fixture.close;
    const ids = new Set<string>();
    for (const path of ['/slotlock/healthz', '/slotlock/openapi.json', '/slotlock/v1/resources']) {
      const response = await fetch(`${fixture.origin}${path}`, { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` } });
      const id = response.headers.get('slotlock-request-id') ?? '';
      expect(id, path).toMatch(UUID);
      ids.add(id);
      expect(response.headers.get('slotlock-usage'), path).toBeNull();
    }
    const refused = await fetch(`${fixture.origin}/slotlock/v1/resources`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('slotlock-request-id')).toMatch(UUID);
    expect(ids.size).toBe(3);
  });

  it('says how many operations were counted for a REST or MCP answer, and none for a refused call', async () => {
    const counted: SlotlockAgentUsage[] = [];
    const onUsage = vi.fn((usage: SlotlockAgentUsage) => {
      counted.push(usage);
    });
    const fixture = await startSlotlockFixture({ rest: true, onUsage });
    close = fixture.close;
    const listed = await fetch(`${fixture.origin}/slotlock/v1/resources`, {
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('slotlock-usage')).toBe('operations=1');
    // Refused before it runs: not counted, no field.
    const invalid = await fetch(`${fixture.origin}/slotlock/v1/resources?limit=0`, {
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('slotlock-usage')).toBeNull();
    const called = await mcp(fixture.origin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slotlock_list_resources', arguments: {} },
    });
    expect(called.status).toBe(200);
    expect(called.headers.get('slotlock-usage')).toBe('operations=1');
    // A protocol message names no operation.
    const tools = await mcp(fixture.origin, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.headers.get('slotlock-usage')).toBeNull();
    expect(counted.map(({ operation, origin, principal }) => [operation, origin, principal.tenantRef])).toEqual([
      ['slotlock_list_resources', 'rest', 'fixture-tenant'],
      ['slotlock_list_resources', 'mcp', 'fixture-tenant'],
    ]);
  });

  it('counts nothing when the meter throws, and answers as before', async () => {
    const fixture = await startSlotlockFixture({
      rest: true,
      onUsage: () => {
        throw new Error('meter broken');
      },
    });
    close = fixture.close;
    const listed = await fetch(`${fixture.origin}/slotlock/v1/resources`, {
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ resources: [{ id: 'resource-1' }] });
  });
});
