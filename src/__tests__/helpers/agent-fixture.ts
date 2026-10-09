// A real Slotlock agent server on a loopback port, for tests that drive it with official client SDKs.
// The backend is in-memory and deterministic: reads succeed, writes and lookups fail with the
// bounded domain errors an agent must be able to read.
import { vi } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
} from '../../agent-server.js';
import { type SlotlockNodeServerFetchTarget, createSlotlockNodeServer } from '../../node-server.js';

export const FIXTURE_TOKEN = 'fixture-token';
const FIXTURE_RESOURCE = {
  id: 'resource-1',
  external_ref: 'vehicle-1',
  timezone: 'Europe/London',
} as const;

type BackendMethod = (
  context: SlotlockAgentInvocationContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** A backend method that fails until a test gives it an implementation. */
function refuse(code: string, status: number) {
  return vi.fn<BackendMethod>(async () => {
    throw new SlotlockAgentOperationError(code, status);
  });
}

function createFixtureBackend() {
  return {
    listResources: vi.fn(async () => ({ resources: [FIXTURE_RESOURCE], next_cursor: null })),
    getFreeBusy: refuse('not_found', 404),
    findNextAvailable: vi.fn(async (_context: unknown, input: Record<string, unknown>) => ({
      resource_id: null,
      start: null,
      end: null,
      coverage: {
        start: String(input.start),
        end: String(input.end),
        certainty: 'uncertain',
        reason: 'coverage_incomplete',
      },
    })),
    createEvent: refuse('reservation_conflict', 409),
    getEvent: refuse('not_found', 404),
    listEvents: vi.fn(async () => ({ events: [], next_cursor: null })),
    updateEvent: refuse('revision_conflict', 409),
    deleteEvent: refuse('revision_conflict', 409),
  } satisfies SlotlockAgentCalendarBackend;
}

export interface SlotlockFixture {
  backend: ReturnType<typeof createFixtureBackend>;
  /** Loopback origin the listener is bound to; every URL the server publishes uses it. */
  origin: string;
  close(): Promise<unknown>;
}

export async function startSlotlockFixture(
  overrides: Partial<SlotlockAgentServerOptions> = {},
): Promise<SlotlockFixture> {
  const backend = createFixtureBackend();
  // The port is only known once bound, and the card/metadata must advertise it, so the agent server
  // is built after `listen` behind a delegating target.
  const target: { server?: SlotlockNodeServerFetchTarget } = {};
  const listener = createSlotlockNodeServer(
    {
      fetch: (request) =>
        target.server
          ? target.server.fetch(request)
          : Promise.reject(new Error('fixture not ready')),
      shutdown: () => target.server?.shutdown?.(),
    },
    { requestOrigin: 'http://localhost', handlerTimeoutMs: 5_000, shutdownGraceMs: 1_000 },
  );
  const address = await listener.listen({ host: '127.0.0.1', port: 0 });
  target.server = createSlotlockAgentServer({
    publicBaseUrl: `${address.origin}/slotlock`,
    allowInsecureLocalhost: true,
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === `Bearer ${FIXTURE_TOKEN}`
        ? { subject: 'fixture-principal', tenantRef: 'fixture-tenant' }
        : null,
    authorize: async () => true,
    health: async () => ({ ready: true, checks: ['fixture'] }),
    ...overrides,
  });
  return { backend, origin: address.origin, close: () => listener.close() };
}
