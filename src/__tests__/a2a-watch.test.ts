// The A2A watch skill (SendStreamingMessage) on the agent server: refusals before the stream opens,
// the caps it shares with MCP subscriptions, and how the task ends. The happy path against the
// official SDK client is in a2a-sdk.interop.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_A2A_WATCH_SKILL,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  slotlockCalendarResourceUri,
} from '../agent-server.js';
import { createFakeChangeFeed } from './helpers/change-feed.js';
import { SseReader, modernRequest } from './helpers/modern-mcp.js';

type BackendMethod = (
  context: SlotlockAgentInvocationContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const getFreeBusy = vi.fn<BackendMethod>();
const authenticate = vi.fn<(request: Request) => Promise<SlotlockAgentPrincipal | null>>();
const backend: SlotlockAgentCalendarBackend = {
  listResources: vi.fn(),
  getFreeBusy,
  findNextAvailable: vi.fn(),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  listEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
};
const busy = new Map<string, { start: string; end: string }[]>();

function buildServer(feed = createFakeChangeFeed(), extra: object = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    allowedOrigins: ['http://localhost'],
    backend,
    authenticate,
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    subscriptions: {
      pollIntervalMs: 60_000,
      maxDurationMs: 120_000,
      changes: feed.source,
      ...extra,
    },
  });
}

function watch(args: unknown, token = 'Bearer valid', method = 'SendStreamingMessage'): Request {
  return new Request('http://localhost/slotlock/a2a', {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      Authorization: token,
      'Content-Type': 'application/json',
      'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method,
      params: {
        message: {
          messageId: 'watch-1',
          role: 'ROLE_USER',
          parts: [{ data: { skill: SLOTLOCK_A2A_WATCH_SKILL, arguments: args }, mediaType: 'application/json' }],
        },
      },
    }),
  });
}

/** The data of a one-message reply streamed for a refusal. */
async function streamedReply(response: Response): Promise<unknown> {
  const stream = new SseReader(response);
  const event = (await stream.message()) as { result: { message: { parts: [{ data: unknown }] } } };
  expect(await stream.message()).toBeNull();
  return event.result.message.parts[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    now: new Date('2027-03-01T08:00:00.000Z'),
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  busy.clear();
  busy.set('vehicle-a', []);
  authenticate.mockImplementation(async (request) =>
    request.headers.get('authorization') === 'Bearer valid'
      ? { subject: 'principal-1', tenantRef: 'tenant-a' }
      : null,
  );
  getFreeBusy.mockImplementation(async (_context, input) => {
    const ids = input.resource_ids as string[];
    if (ids.some((id) => !busy.has(id))) throw new SlotlockAgentOperationError('not_found', 404);
    return {
      resources: ids.map((id) => ({
        resource_id: id,
        busy: busy.get(id),
        coverage: { start: input.start, end: input.end, certainty: 'certain', reason: null },
      })),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the A2A watch skill', () => {
  it('refuses bad arguments, unknown resources and a plain SendMessage with a reply', async () => {
    const server = buildServer();
    for (const args of [undefined, {}, { resource_ids: [] }, { resource_ids: ['a'], extra: 1 }]) {
      expect(await streamedReply(await server.fetch(watch(args)))).toEqual({
        error: { code: 'invalid_arguments' },
      });
    }
    expect(await streamedReply(await server.fetch(watch({ resource_ids: ['missing'] })))).toEqual({
      error: { code: 'not_found' },
    });
    const sync = await server.fetch(watch({ resource_ids: ['vehicle-a'] }, 'Bearer valid', 'SendMessage'));
    expect(await sync.json()).toMatchObject({
      result: { message: { parts: [{ data: { error: { code: 'streaming_required' } } }] } },
    });
  });

  it('opens with the working task, announces each change, and completes when its duration is up', async () => {
    const feed = createFakeChangeFeed();
    const stream = new SseReader(await buildServer(feed).fetch(watch({ resource_ids: ['vehicle-a'] })));
    const opened = (await stream.message()) as { id: number; result: { task: Record<string, unknown> } };
    expect(opened.id).toBe(7);
    expect(opened.result.task).toMatchObject({
      status: {
        state: 'TASK_STATE_WORKING',
        message: {
          role: 'ROLE_AGENT',
          parts: [
            {
              data: {
                resources: [{ resource_id: 'vehicle-a', uri: slotlockCalendarResourceUri('vehicle-a') }],
              },
            },
          ],
        },
      },
    });
    const taskId = opened.result.task.id;
    await vi.advanceTimersByTimeAsync(0);

    busy.set('vehicle-a', [{ start: '2027-03-02T09:00:00.000Z', end: '2027-03-02T10:00:00.000Z' }]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(250);
    expect(await stream.message()).toMatchObject({
      result: {
        statusUpdate: {
          taskId,
          status: {
            state: 'TASK_STATE_WORKING',
            message: { parts: [{ data: { resource_id: 'vehicle-a' } }] },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(await stream.message()).toMatchObject({
      result: { statusUpdate: { taskId, status: { state: 'TASK_STATE_COMPLETED' } } },
    });
    expect(await stream.message()).toBeNull();
    expect(feed.listening()).toEqual([]);
  });

  it('fails the task when the credential is withdrawn', async () => {
    const feed = createFakeChangeFeed();
    const stream = new SseReader(await buildServer(feed).fetch(watch({ resource_ids: ['vehicle-a'] })));
    await stream.message();
    await vi.advanceTimersByTimeAsync(0);
    authenticate.mockResolvedValue(null);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(250);
    expect(await stream.message()).toMatchObject({
      result: {
        statusUpdate: {
          status: {
            state: 'TASK_STATE_FAILED',
            message: { parts: [{ data: { error: { code: 'forbidden' } } }] },
          },
        },
      },
    });
    expect(await stream.message()).toBeNull();
  });

  it('counts against the same caps as MCP subscriptions, and frees its slot when the client leaves', async () => {
    const feed = createFakeChangeFeed();
    const server = buildServer(feed, { maxPerPrincipal: 1 });
    const abort = new AbortController();
    const first = new SseReader(
      await server.fetch(new Request(watch({ resource_ids: ['vehicle-a'] }), { signal: abort.signal })),
    );
    await first.message();
    await vi.advanceTimersByTimeAsync(0);

    expect(await (await server.fetch(watch({ resource_ids: ['vehicle-a'] }))).json()).toMatchObject({
      id: 7,
      error: { code: -32029, data: [{ reason: 'RATE_LIMITED' }] },
    });
    const listen = await server.fetch(
      modernRequest('subscriptions/listen', {
        notifications: { resourceSubscriptions: [slotlockCalendarResourceUri('vehicle-a')] },
      }),
    );
    expect(listen.status).toBe(429);

    abort.abort();
    expect(feed.stopped).toEqual(['tenant-a']);
    const again = new SseReader(await server.fetch(watch({ resource_ids: ['vehicle-a'] })));
    expect(await again.message()).toMatchObject({ result: { task: { status: { state: 'TASK_STATE_WORKING' } } } });
    await again.cancel();
  });
});
