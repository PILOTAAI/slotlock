// Any A2A 1.0 JSON-RPC client works; this is the official JavaScript SDK (@a2a-js/sdk).
// #region a2a
import { SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';

export async function listResourcesOverA2a(baseUrl: string, token: string) {
  // Fetches .well-known/agent-card.json relative to baseUrl (Slotlock answers it under its base path
  // and at the origin root), then calls the card's JSON-RPC interface.
  const client = await new ClientFactory().createFromUrl(baseUrl);
  const reply = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        // One application/json data part: the skill id and its arguments (see the agent card).
        parts: [
          {
            data: { skill: 'slotlock_list_resources', arguments: { limit: 10 } },
            mediaType: 'application/json',
          },
        ],
      },
    }),
    { serviceParameters: { Authorization: `Bearer ${token}` } },
  );
  // The reply's single data part is the skill result, or {"error":{"code":…}} when refused.
  const part = 'parts' in reply ? reply.parts[0] : undefined;
  return part?.content?.$case === 'data' ? part.content.value : undefined;
}
// #endregion a2a
