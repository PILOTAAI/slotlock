// Any MCP client works; this is the official TypeScript SDK (@modelcontextprotocol/sdk).
// #region mcp
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function findSlotOverMcp(mcpUrl: string, token: string, resourceId: string) {
  const client = new Client({ name: 'fleet-assistant', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'slotlock_find_next_available',
      arguments: {
        resource_ids: [resourceId],
        start: '2027-03-29T00:00:00Z',
        end: '2027-04-05T00:00:00Z',
        duration_minutes: 120,
      },
    });
    // A refusal or conflict is a result the model reads ({"error":{"code":…}}), not an exception.
    if (result.isError) {
      const [text] = result.content as Array<{ type: 'text'; text: string }>;
      return { error: JSON.parse(text?.text ?? '{}').error as { code: string } };
    }
    return { slot: result.structuredContent };
  } finally {
    await client.close();
  }
}
// #endregion mcp
