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

// An allow-list, so an operation added in a later release stays refused until you add it. This one
// permits everything except deleting events; a real policy also looks at the principal and input.
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
  /** The fixed public URL, e.g. https://calendar.example.com/slotlock. Never read from a request. */
  publicBaseUrl: string;
  port: number;
  /** Your token check: the principal (subject + tenant) for a valid token, else null (401). */
  verifyToken(token: string): Promise<SlotlockAgentPrincipal | null>;
  /** Development only: serve http://localhost instead of requiring HTTPS. */
  allowInsecureLocalhost?: boolean;
  /** A random secret of 32+ bytes; set it to have a person confirm every booking an agent makes. */
  confirmationSecret?: string;
}

export async function startCalendarServer(config: CalendarServerConfig) {
  const server = createSlotlockAgentServer({
    publicBaseUrl: config.publicBaseUrl,
    allowInsecureLocalhost: config.allowInsecureLocalhost === true,
    // MCP 2026-07-28 clients that can show a form are asked "Book … ?" before the write runs;
    // clients that cannot ask anyone (2025 revisions, A2A) have those writes refused, not trusted.
    ...(config.confirmationSecret
      ? {
          confirmation: {
            operations: ['slotlock_create_event', 'slotlock_update_event'] as const,
            secrets: [config.confirmationSecret],
          },
        }
      : {}),
    // Rentals are booked months ahead: calendar resources (and live updates) look 90 days ahead,
    // and a subscribed agent hears of a change within about five seconds.
    resourceWindowDays: 90,
    subscriptions: { pollIntervalMs: 5_000 },
    backend: createSlotlockStoreAgentBackend(config.store, {
      // Bookable hours per resource. No rules means never bookable, not open all week.
      availabilityRules: async () => [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 480 },
      ],
    }),
    authenticate: async (request) => {
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return token ? config.verifyToken(token) : null;
    },
    // Runs after argument validation on every call, with the current operation name even when the
    // client used a legacy dotted alias.
    authorize: async ({ operation }) => ALLOWED_OPERATIONS.has(operation),
    health: async () => ({ ready: true, checks: ['database'] }),
  });

  const listener = createSlotlockNodeServer(server, {
    requestOrigin: new URL(config.publicBaseUrl).origin,
  });
  await listener.listen({ host: '127.0.0.1', port: config.port });
  // listener.close() ends open subscriptions gracefully, then drains in-flight requests.
  return listener;
}
// #endregion server
