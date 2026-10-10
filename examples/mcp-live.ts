// An MCP 2026-07-28 client (the official TypeScript SDK v2, `@modelcontextprotocol/client`): the
// person confirms each booking, and the agent hears when the vehicle's calendar changes.
// #region live
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { slotlockCalendarResourceUri } from 'slotlock';

export interface LiveCalendarOptions {
  mcpUrl: string;
  token: string;
  resourceId: string;
  /** Show Slotlock's sentence ("Book … on resource …: 2027-03-29 10:00–12:00 (Europe/London).") */
  confirm(message: string): Promise<boolean>;
  /** The resource's free/busy changed; call read() for the new one. */
  onChange(uri: string): void;
}

export async function openLiveCalendar(options: LiveCalendarOptions) {
  const client = new Client(
    { name: 'fleet-assistant', version: '1.0.0' },
    // 'auto' asks server/discover first and speaks 2026-07-28 when the server does.
    { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
  );
  // Slotlock asks before a guarded write; the SDK calls this, then repeats the call with the answer.
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
  // The acknowledgment lists what the server agreed to watch: nothing when this token cannot read it.
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
