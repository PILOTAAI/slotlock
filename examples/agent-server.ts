// Serve MCP and A2A from one process. Terminate public HTTPS at a reverse proxy in front of it.
// #region server
import {
  type SlotlockAgentOperation,
  type SlotlockAgentPrincipal,
  type SlotlockStore,
  createSlotlockAgentServer,
  createSlotlockStoreAgentBackend,
} from 'slotlock';
import { createSlotlockNodeServer } from 'slotlock/node-server';

const ALLOWED_OPERATIONS: ReadonlySet<SlotlockAgentOperation> = new Set([
  'slotlock_list_resources',
  'slotlock_get_free_busy',
  'slotlock_find_next_available',
  'slotlock_create_event',
  'slotlock_get_event',
  'slotlock_list_events',
  'slotlock_update_event',
]);

export interface CalendarServerConfig {
  store: SlotlockStore;
  publicBaseUrl: string;
  port: number;
  verifyToken(token: string): Promise<SlotlockAgentPrincipal | null>;
  allowInsecureLocalhost?: boolean;
  confirmationSecret?: string;
}

export async function startCalendarServer(config: CalendarServerConfig) {
  const server = createSlotlockAgentServer({
    publicBaseUrl: config.publicBaseUrl,
    allowInsecureLocalhost: config.allowInsecureLocalhost === true,
    ...(config.confirmationSecret
      ? {
          confirmation: {
            operations: ['slotlock_create_event', 'slotlock_update_event'] as const,
            secrets: [config.confirmationSecret],
          },
        }
      : {}),
    resourceWindowDays: 90,
    subscriptions: { pollIntervalMs: 5_000 },
    backend: createSlotlockStoreAgentBackend(config.store, {
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 480 },
      ],
    }),
    authenticate: async (request) => {
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return token ? config.verifyToken(token) : null;
    },
    authorize: async ({ operation }) => ALLOWED_OPERATIONS.has(operation),
    health: async () => ({ ready: true, checks: ['database'] }),
  });

  const listener = createSlotlockNodeServer(server, {
    requestOrigin: new URL(config.publicBaseUrl).origin,
  });
  await listener.listen({ host: '127.0.0.1', port: config.port });
  return listener;
}
// #endregion server
