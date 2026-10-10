// An MCP 2026-07-28 client (the official TypeScript SDK v2, `@modelcontextprotocol/client`): the
// person confirms each booking, and the agent hears when the vehicle's calendar changes.
// #region live
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { slotlockCalendarResourceUri } from 'slotlock';

export interface LiveCalendarOptions {
  mcpUrl: string;
  token: string;
  resourceId: string;
  confirm(message: string): Promise<boolean>;
  onChange(uri: string): void;
}

export async function openLiveCalendar(options: LiveCalendarOptions) {
  const client = new Client(
    { name: 'fleet-assistant', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler('elicitation/create', async (request) =>
    (await options.confirm(request.params.message))
      ? { action: 'accept' as const, content: { confirm: true } }
      : { action: 'decline' as const },
  );
  client.setNotificationHandler('notifications/resources/updated', (notification) =>
    options.onChange(notification.params.uri),
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    }),
  );

  const uri = slotlockCalendarResourceUri(options.resourceId);
  const subscription = await client.listen({ resourceSubscriptions: [uri] });
  return {
    watching: subscription.honoredFilter.resourceSubscriptions ?? [],
    book: (booking: Record<string, unknown>) =>
      client.callTool({
        name: 'slotlock_create_event',
        arguments: { resource_id: options.resourceId, ...booking },
      }),
    read: async () => {
      const [content] = (await client.readResource({ uri })).contents;
      return content && 'text' in content ? JSON.parse(content.text) : null;
    },
    close: async () => {
      await subscription.close();
      await client.close();
    },
  };
}
// #endregion live
