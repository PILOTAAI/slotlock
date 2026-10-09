import { discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
// Slotlock against the OFFICIAL MCP TypeScript SDK (@modelcontextprotocol/sdk, pinned in
// devDependencies) over real Streamable HTTP. A mock can only confirm what its author believed; this
// file is the contract that a stock MCP client can connect, list portable tool names, read tool
// failures and discover OAuth metadata.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION } from '../agent-server.js';
import { FIXTURE_TOKEN, type SlotlockFixture, startSlotlockFixture } from './helpers/agent-fixture.js';

// Claude's tool names must match ^[a-zA-Z0-9_-]{1,128}$ (platform.claude.com, define-tools,
// checked 2026-09-26) and OpenAI function names are capped at 64 of the same characters.
const PORTABLE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

let fixture: SlotlockFixture | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await fixture?.close();
  client = undefined;
  fixture = undefined;
});

async function connect(current: SlotlockFixture) {
  const transport = new StreamableHTTPClientTransport(new URL(`${current.origin}/slotlock/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` } },
  });
  client = new Client({ name: 'slotlock-interop-test', version: '1.0.0' });
  // The SDK's own declarations are not written for exactOptionalPropertyTypes (`sessionId?:`), so the
  // transport is handed over as the interface it implements.
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as Array<{ type: string; text?: string }>;
  return first?.type === 'text' ? (first.text ?? '') : '';
}

describe('Slotlock with the official MCP TypeScript SDK', () => {
  it('connects, answers ping and lists only portable tool names', async () => {
    fixture = await startSlotlockFixture();
    const { client: connected, transport } = await connect(fixture);

    // SDK 1.x speaks the 2025 lifecycle: `initialize` negotiates the newest 2025 revision.
    expect(transport.protocolVersion).toBe(SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION);
    await expect(connected.ping()).resolves.toEqual({});

    const { tools } = await connected.listTools();
    expect(tools).toHaveLength(8);
    for (const tool of tools) expect(tool.name).toMatch(PORTABLE_TOOL_NAME);
    expect(tools.map((tool) => tool.name)).toContain('calendar_get_free_busy');
  });

  it('returns successful structured results and tool failures the SDK does not throw on', async () => {
    fixture = await startSlotlockFixture();
    const { client: connected } = await connect(fixture);
    await connected.listTools(); // caches the output schemas the SDK validates against

    const listed = await connected.callTool({
      name: 'calendar_list_resources',
      arguments: { limit: 5 },
    });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual({
      resources: [{ id: 'resource-1', external_ref: 'vehicle-1', timezone: 'Europe/London' }],
      next_cursor: null,
    });

    for (const [name, args, code] of [
      ['calendar_get_event', { event_id: 'missing' }, 'not_found'],
      [
        'calendar_create_event',
        {
          resource_id: 'resource-1',
          starts_at: '2027-03-01T09:00:00Z',
          ends_at: '2027-03-01T10:00:00Z',
          timezone: 'Europe/London',
          idempotency_key: 'interop-create-1',
        },
        'reservation_conflict',
      ],
      [
        'calendar_list_events',
        { resource_ids: [], start: 'soon', end: 'later' },
        'invalid_arguments',
      ],
    ] as const) {
      const failed = await connected.callTool({ name, arguments: args });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toBeUndefined();
      expect(JSON.parse(textOf(failed))).toEqual({ error: { code } });
    }
  });

  it('still executes a tool addressed by its legacy dotted name', async () => {
    fixture = await startSlotlockFixture();
    const { client: connected } = await connect(fixture);

    const legacy = await connected.callTool({
      name: 'calendar.list_resources',
      arguments: { limit: 1 },
    });
    expect(legacy.isError).toBeFalsy();
    expect(fixture.backend.listResources).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'calendar_list_resources' }),
      { limit: 1 },
    );
  });

  it('publishes RFC 9728 protected-resource metadata that the SDK discovers', async () => {
    fixture = await startSlotlockFixture({
      oauth: {
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['calendar:read', 'calendar:write'],
        requiredScopes: ['calendar:read'],
      },
    });

    const metadata = await discoverOAuthProtectedResourceMetadata(
      new URL(`${fixture.origin}/slotlock/mcp`),
    );
    expect(metadata).toMatchObject({
      resource: `${fixture.origin}/slotlock/mcp`,
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['calendar:read', 'calendar:write'],
      bearer_methods_supported: ['header'],
    });

    const unauthenticated = await fetch(`${fixture.origin}/slotlock/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      `Bearer realm="slotlock", resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource/slotlock/mcp", scope="calendar:read"`,
    );
  });
});
