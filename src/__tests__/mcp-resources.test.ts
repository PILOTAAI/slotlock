// MCP 2026-07-28 resources and live calendar updates on the Slotlock agent server. Expectations are
// quoted from the 2026-07-28 specification (server/resources; basic/patterns/subscriptions;
// transports/streamable-http §Receiving Messages; server/utilities/caching), read from the
// modelcontextprotocol repository on 2026-09-28.
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_AGENT_SERVER_VERSION,
  SLOTLOCK_MCP_APP_HTML,
  SLOTLOCK_MCP_APP_RESOURCE,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
  type SlotlockAgentPrincipal,
  type SlotlockAgentServerEvent,
  createSlotlockAgentServer,
  slotlockCalendarResourceUri,
} from '../agent-server.js';
import {
  SERVER_INFO_KEY,
  SUBSCRIPTION_ID_KEY,
  SseReader,
  modernRequest,
  rpc,
} from './helpers/modern-mcp.js';
import type { SlotlockAgentChangeSource } from '../change-watch.js';
import { createFakeChangeFeed } from './helpers/change-feed.js';

type BackendMethod = (
  context: SlotlockAgentInvocationContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const listResources = vi.fn<BackendMethod>();
const getFreeBusy = vi.fn<BackendMethod>();
const authorize = vi.fn<Parameters<typeof createSlotlockAgentServer>[0]['authorize']>();
const authenticate = vi.fn<(request: Request) => Promise<SlotlockAgentPrincipal | null>>();
const onEvent = vi.fn<(event: SlotlockAgentServerEvent) => void>();

const backend: SlotlockAgentCalendarBackend = {
  listResources,
  getFreeBusy,
  findNextAvailable: vi.fn(),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  listEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
};

const SERVER_INFO = { name: 'slotlock', version: SLOTLOCK_AGENT_SERVER_VERSION };
const PRINCIPALS: Record<string, SlotlockAgentPrincipal> = {
  'Bearer valid': { subject: 'principal-1', tenantRef: 'tenant-a' },
  'Bearer other': { subject: 'principal-2', tenantRef: 'tenant-a' },
  'Bearer third': { subject: 'principal-3', tenantRef: 'tenant-b' },
};
// 30 days from the start of the minute the request arrives in.
const NOW = new Date('2027-03-01T08:00:30.500Z');
const WINDOW = { start: '2027-03-01T08:00:00.000Z', end: '2027-03-31T08:00:00.000Z' };
// What a subscription opened then watches: that window plus its 60-second maximum lifetime.
const WATCHED = { start: WINDOW.start, end: '2027-03-31T08:01:00.000Z' };
const URI_A = slotlockCalendarResourceUri('vehicle-a');
const URI_B = slotlockCalendarResourceUri('vehicle-b');
const HANDOVER = { start: '2027-03-02T09:00:00.000Z', end: '2027-03-02T10:00:00.000Z' };

/** The calendars the fake backend knows, by resource id: its busy intervals. */
const calendars = new Map<string, { start: string; end: string }[]>();

function buildServer(overrides: Partial<Parameters<typeof createSlotlockAgentServer>[0]> = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    allowedOrigins: ['http://localhost'],
    backend,
    authenticate,
    authorize,
    health: async () => ({ ready: true, checks: [] }),
    subscriptions: { pollIntervalMs: 1_000, keepAliveMs: 5_000, maxDurationMs: 60_000 },
    onEvent,
    ...overrides,
  });
}

function listen(notifications: Record<string, unknown>, token = 'Bearer valid'): Request {
  return modernRequest(
    'subscriptions/listen',
    { notifications },
    { headers: { Authorization: token } },
  );
}

const closedEvents = () =>
  onEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'subscription' && event.outcome === 'closed');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    now: NOW,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  calendars.clear();
  calendars.set('vehicle-a', []);
  calendars.set('vehicle-b', []);
  authenticate.mockImplementation(
    async (request) => PRINCIPALS[request.headers.get('authorization') ?? ''] ?? null,
  );
  authorize.mockResolvedValue(true);
  listResources.mockResolvedValue({
    resources: [
      { id: 'vehicle-a', external_ref: 'AB12 CDE', timezone: 'Europe/London' },
      { id: 'Van 7/α', external_ref: null, timezone: 'Europe/Paris' },
    ],
    next_cursor: 'page-2',
  });
  // Like a real backend, it answers only for the window asked about.
  getFreeBusy.mockImplementation(async (_context, input) => {
    const resourceIds = input.resource_ids as string[];
    if (resourceIds.some((resourceId) => !calendars.has(resourceId))) {
      throw new SlotlockAgentOperationError('not_found', 404);
    }
    const [start, end] = [Date.parse(String(input.start)), Date.parse(String(input.end))];
    return {
      resources: resourceIds.map((resourceId) => ({
        resource_id: resourceId,
        busy: (calendars.get(resourceId) ?? []).filter(
          (busy) => Date.parse(busy.start) < end && Date.parse(busy.end) > start,
        ),
        coverage: { start: input.start, end: input.end, certainty: 'certain', reason: null },
      })),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('calendar resources (MCP 2026-07-28 server/resources)', () => {
  it('publishes one canonical URI per resource, expanding the advertised template', () => {
    expect(SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE).toBe('slotlock://resources/{resource_id}');
    expect(slotlockCalendarResourceUri('vehicle-a')).toBe('slotlock://resources/vehicle-a');
    // RFC 6570 simple expansion: everything but unreserved characters is percent-encoded.
    expect(slotlockCalendarResourceUri("Van 7/α!'()*~")).toBe(
      'slotlock://resources/Van%207%2F%CE%B1%21%27%28%29%2A~',
    );
  });

  it('lists its resource template with public cache hints', async () => {
    const response = await buildServer().fetch(modernRequest('resources/templates/list'));
    expect(await rpc(response)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        resultType: 'complete',
        resourceTemplates: [
          {
            uriTemplate: 'slotlock://resources/{resource_id}',
            name: 'resource-calendar',
            title: 'Resource calendar',
            description: expect.stringContaining('next 30 days'),
            mimeType: 'application/json',
          },
        ],
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
      },
    });
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists the calendar view and the tenant's resources, paginated, with private cache hints", async () => {
    const server = buildServer();
    const first = await rpc(await server.fetch(modernRequest('resources/list')));
    expect(first.result).toEqual({
      resultType: 'complete',
      resources: [
        { ...SLOTLOCK_MCP_APP_RESOURCE },
        {
          uri: 'slotlock://resources/vehicle-a',
          name: 'vehicle-a',
          title: 'AB12 CDE',
          description: 'Free/busy of this resource for the next 30 days (Europe/London).',
          mimeType: 'application/json',
        },
        {
          uri: 'slotlock://resources/Van%207%2F%CE%B1',
          name: 'Van 7/α',
          title: 'Van 7/α',
          description: 'Free/busy of this resource for the next 30 days (Europe/Paris).',
          mimeType: 'application/json',
        },
      ],
      nextCursor: 'page-2',
      ttlMs: 60_000,
      cacheScope: 'private',
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });
    expect(listResources.mock.calls[0]?.[1]).toEqual({ limit: 50 });

    // Later pages carry only resources, from the backend's cursor.
    listResources.mockResolvedValueOnce({
      resources: [{ id: 'vehicle-b', external_ref: null, timezone: 'UTC' }],
      next_cursor: null,
    });
    const second = await rpc(
      await server.fetch(modernRequest('resources/list', { cursor: 'page-2' })),
    );
    expect(second.result).toMatchObject({
      resources: [{ uri: 'slotlock://resources/vehicle-b', name: 'vehicle-b' }],
    });
    expect(second.result).not.toHaveProperty('nextCursor');
    expect(listResources.mock.calls[1]?.[1]).toEqual({ cursor: 'page-2', limit: 50 });
  });

  it('lists only the calendar view to a principal that may not list resources', async () => {
    authorize.mockResolvedValue(false);
    const listed = await rpc(await buildServer().fetch(modernRequest('resources/list')));
    expect(listed.result).toMatchObject({
      resources: [{ uri: SLOTLOCK_MCP_APP_RESOURCE_URI }],
      cacheScope: 'private',
    });
    expect((listed.result as { resources: unknown[] }).resources).toHaveLength(1);
    expect(listResources).not.toHaveBeenCalled();
  });

  it('answers a bad cursor, a rate limit and a backend fault with the matching errors', async () => {
    const server = buildServer();
    const numeric = await server.fetch(modernRequest('resources/list', { cursor: 7 }));
    expect(numeric.status).toBe(200);
    expect(await rpc(numeric)).toMatchObject({ error: { code: -32602 } });
    const tooLong = await server.fetch(
      modernRequest('resources/list', { cursor: 'x'.repeat(501) }),
    );
    expect(await rpc(tooLong)).toMatchObject({ error: { code: -32602 } });

    const limited = buildServer({
      consumeRateLimit: async ({ operation }) => operation === 'protocol',
    });
    const refused = await limited.fetch(modernRequest('resources/list'));
    expect(refused.status).toBe(429);
    expect(await rpc(refused)).toMatchObject({ error: { code: -31029 } });

    listResources.mockRejectedValueOnce(new Error('database down'));
    const failed = await server.fetch(modernRequest('resources/list'));
    expect(failed.status).toBe(500);
    expect(await rpc(failed)).toMatchObject({ error: { code: -32603, message: 'Internal error' } });
  });

  it('reads the calendar view with public cache hints', async () => {
    const read = await rpc(
      await buildServer().fetch(
        modernRequest('resources/read', { uri: SLOTLOCK_MCP_APP_RESOURCE_URI }),
      ),
    );
    expect(read.result).toEqual({
      resultType: 'complete',
      contents: [
        {
          uri: SLOTLOCK_MCP_APP_RESOURCE_URI,
          mimeType: SLOTLOCK_MCP_APP_RESOURCE.mimeType,
          _meta: SLOTLOCK_MCP_APP_RESOURCE._meta,
          text: SLOTLOCK_MCP_APP_HTML,
        },
      ],
      ttlMs: 3_600_000,
      cacheScope: 'public',
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });
  });

  it("reads a resource's free/busy for the next 30 days, uncached and private", async () => {
    calendars.set('Van 7/α', [HANDOVER]);
    const uri = slotlockCalendarResourceUri('Van 7/α');
    const read = await rpc(await buildServer().fetch(modernRequest('resources/read', { uri })));
    expect(read.result).toEqual({
      resultType: 'complete',
      contents: [{ uri, mimeType: 'application/json', text: expect.any(String) }],
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
    });
    const [content] = (read.result as { contents: [{ text: string }] }).contents;
    expect(JSON.parse(content.text)).toEqual({
      resource_id: 'Van 7/α',
      window: WINDOW,
      busy: [HANDOVER],
      coverage: { ...WINDOW, certainty: 'certain', reason: null },
    });
    expect(getFreeBusy.mock.calls[0]?.[1]).toEqual({ resource_ids: ['Van 7/α'], ...WINDOW });
    expect(authorize).toHaveBeenCalledWith({
      principal: PRINCIPALS['Bearer valid'],
      operation: 'slotlock_get_free_busy',
      input: { resource_ids: ['Van 7/α'], ...WINDOW },
    });
  });

  it('looks as far ahead as resourceWindowDays says, up to the 367-day horizon', async () => {
    const server = buildServer({ resourceWindowDays: 367, subscriptions: false });
    const year = { start: WINDOW.start, end: '2028-03-02T08:00:00.000Z' };
    const read = await rpc(await server.fetch(modernRequest('resources/read', { uri: URI_A })));
    const [content] = (read.result as { contents: [{ text: string }] }).contents;
    expect(JSON.parse(content.text).window).toEqual(year);
    const templates = await rpc(await server.fetch(modernRequest('resources/templates/list')));
    expect(templates.result).toMatchObject({
      resourceTemplates: [{ description: expect.stringContaining('next 367 days') }],
    });
    const listed = await rpc(await server.fetch(modernRequest('resources/list')));
    expect(listed.result).toMatchObject({
      resources: [{}, { description: expect.stringContaining('next 367 days') }, {}],
    });

    // A subscription watches that window plus its own lifetime, which must fit the horizon too.
    const watching = buildServer({ resourceWindowDays: 366 });
    getFreeBusy.mockClear();
    const stream = new SseReader(await watching.fetch(listen({ resourceSubscriptions: [URI_A] })));
    await stream.message();
    expect(getFreeBusy.mock.calls[0]?.[1]).toEqual({
      resource_ids: ['vehicle-a'],
      start: WINDOW.start,
      end: '2028-03-01T08:01:00.000Z',
    });
    await stream.cancel();
    expect(() => buildServer({ resourceWindowDays: 367 })).toThrow(
      /resourceWindowDays plus subscriptions\.maxDurationMs must fit 367 days/,
    );

    for (const resourceWindowDays of [0, 368, 1.5]) {
      expect(() => buildServer({ resourceWindowDays, subscriptions: false })).toThrow(
        /resourceWindowDays is invalid/,
      );
    }
  });

  it('answers Resource not found alike for a foreign, missing or malformed resource URI', async () => {
    const server = buildServer();
    const notFound = async (uri: string) => {
      const response = await server.fetch(modernRequest('resources/read', { uri }));
      expect(response.status).toBe(200);
      expect(await rpc(response)).toEqual({
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: -32602, message: 'Resource not found', data: { uri } },
      });
    };
    // Never reaches the backend: not a calendar resource, or not its one canonical spelling.
    for (const uri of [
      'file:///etc/passwd',
      'slotlock://resources/',
      'slotlock://resources/vehicle-a/busy',
      'slotlock://resources/%76ehicle-a',
      'slotlock://resources/Van%207%2f%CE%B1',
      'slotlock://resources/%20padded%20',
      'slotlock://resources/%E0%A4%A',
      'slotlock://resources/%C3%28',
      `slotlock://resources/${'a'.repeat(201)}`,
    ]) {
      await notFound(uri);
    }
    expect(getFreeBusy).not.toHaveBeenCalled();

    await notFound(slotlockCalendarResourceUri('missing'));
    authorize.mockResolvedValue(false);
    await notFound(URI_A);
  });

  it('answers a rate-limited or failing read with 429 or 500, not Resource not found', async () => {
    const limited = await buildServer({
      consumeRateLimit: async ({ operation }) => operation === 'protocol',
    }).fetch(modernRequest('resources/read', { uri: URI_A }));
    expect(limited.status).toBe(429);
    expect(await rpc(limited)).toMatchObject({ error: { code: -31029 } });

    getFreeBusy.mockRejectedValueOnce(new Error('database down'));
    const failed = await buildServer().fetch(modernRequest('resources/read', { uri: URI_A }));
    expect(failed.status).toBe(500);
    expect(await rpc(failed)).toMatchObject({ error: { code: -32603 } });

    getFreeBusy.mockRejectedValueOnce(new SlotlockAgentOperationError('unavailable', 503));
    const unavailable = await buildServer().fetch(modernRequest('resources/read', { uri: URI_A }));
    expect(unavailable.status).toBe(503);
  });
});

describe('live calendar updates (MCP 2026-07-28 subscriptions/listen)', () => {
  it('acknowledges first, honoring only the calendar resources this principal can read', async () => {
    const response = await buildServer().fetch(
      listen({
        toolsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: [
          URI_A,
          URI_B,
          slotlockCalendarResourceUri('missing'),
          SLOTLOCK_MCP_APP_RESOURCE_URI,
          'file:///etc/passwd',
          URI_A,
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const stream = new SseReader(response);
    expect(await stream.message()).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { [SUBSCRIPTION_ID_KEY]: 'req-1' },
        notifications: { resourceSubscriptions: [URI_A, URI_B] },
      },
    });
    // One read for all of them; when that is refused, one read each.
    expect(getFreeBusy.mock.calls.map(([, input]) => input.resource_ids)).toEqual([
      ['vehicle-a', 'vehicle-b', 'missing'],
      ['vehicle-a'],
      ['vehicle-b'],
      ['missing'],
    ]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'subscription', outcome: 'opened', resources: 2 });
    await stream.cancel();
  });

  it('sends one update per change to a watched resource, over the window fixed when it opened', async () => {
    const stream = new SseReader(
      await buildServer().fetch(listen({ resourceSubscriptions: [URI_A, URI_B] })),
    );
    await stream.message();
    getFreeBusy.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getFreeBusy).toHaveBeenCalledTimes(1);
    calendars.set('vehicle-b', [HANDOVER]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stream.message()).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 'req-1' }, uri: URI_B },
    });
    // Unchanged since: nothing. Then vehicle-a changes, and only it is announced.
    await vi.advanceTimersByTimeAsync(1_000);
    calendars.set('vehicle-a', [HANDOVER]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stream.message()).toMatchObject({
      method: 'notifications/resources/updated',
      params: { uri: URI_A },
    });
    expect(getFreeBusy).toHaveBeenCalledTimes(4);
    for (const [, input] of getFreeBusy.mock.calls) {
      expect(input).toEqual({ resource_ids: ['vehicle-a', 'vehicle-b'], ...WATCHED });
    }
    // Re-reads skip the rate limiter but not authorization.
    expect(authorize).toHaveBeenLastCalledWith({
      principal: PRINCIPALS['Bearer valid'],
      operation: 'slotlock_get_free_busy',
      input: { resource_ids: ['vehicle-a', 'vehicle-b'], ...WATCHED },
    });
    await stream.cancel();
  });

  it('announces a booking that enters the rolling read window while it is open', async () => {
    const server = buildServer();
    const stream = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    await stream.message();
    // Thirty seconds on, a read's window ends thirty seconds later than the one the subscription
    // opened with. A booking made in between is in what a fresh read returns, so it is announced.
    await vi.advanceTimersByTimeAsync(30_000);
    const tail = { start: '2027-03-31T08:00:10.000Z', end: '2027-03-31T08:00:20.000Z' };
    calendars.set('vehicle-a', [tail]);
    const read = await rpc(await server.fetch(modernRequest('resources/read', { uri: URI_A })));
    const [content] = (read.result as { contents: [{ text: string }] }).contents;
    expect(JSON.parse(content.text).busy).toEqual([tail]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stream.message()).toMatchObject({
      method: 'notifications/resources/updated',
      params: { uri: URI_A },
    });
    await stream.cancel();
  });

  it('keeps a quiet stream open with SSE comments', async () => {
    const stream = new SseReader(
      await buildServer().fetch(listen({ resourceSubscriptions: [URI_A] })),
    );
    await stream.message();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stream.next()).toEqual({ type: 'comment' });
    await stream.cancel();
  });

  it('ends gracefully with the listen result when its duration is up, and stops reading', async () => {
    const stream = new SseReader(
      await buildServer().fetch(listen({ resourceSubscriptions: [URI_A] })),
    );
    await stream.message();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await stream.message()).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        resultType: 'complete',
        _meta: { [SUBSCRIPTION_ID_KEY]: 'req-1', [SERVER_INFO_KEY]: SERVER_INFO },
      },
    });
    expect(await stream.next()).toEqual({ type: 'end' });
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'duration', resources: 1 },
    ]);
    getFreeBusy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getFreeBusy).not.toHaveBeenCalled();
  });

  it('ends gracefully when the credential, the identity or the permission is withdrawn', async () => {
    const withdrawals: (() => void)[] = [
      () => authenticate.mockResolvedValue(null),
      () => authenticate.mockResolvedValue({ subject: 'someone-else', tenantRef: 'tenant-a' }),
      () => authorize.mockResolvedValue(false),
      () => calendars.delete('vehicle-a'),
    ];
    for (const withdraw of withdrawals) {
      onEvent.mockClear();
      const server = buildServer();
      const stream = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
      await stream.message();
      withdraw();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await stream.message()).toMatchObject({
        id: 'req-1',
        result: { resultType: 'complete' },
      });
      expect(await stream.next()).toEqual({ type: 'end' });
      expect(closedEvents()).toEqual([
        { type: 'subscription', outcome: 'closed', reason: 'revoked', resources: 1 },
      ]);
      authenticate.mockImplementation(
        async (request) => PRINCIPALS[request.headers.get('authorization') ?? ''] ?? null,
      );
      authorize.mockResolvedValue(true);
      calendars.set('vehicle-a', []);
    }
  });

  it('survives two failed re-reads but drops the stream, without a result, on the third', async () => {
    const stream = new SseReader(
      await buildServer().fetch(listen({ resourceSubscriptions: [URI_A] })),
    );
    await stream.message();
    getFreeBusy.mockRejectedValueOnce(new Error('blip')).mockRejectedValueOnce(new Error('blip'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(closedEvents()).toEqual([]);

    getFreeBusy.mockRejectedValue(new SlotlockAgentOperationError('unavailable', 503));
    await vi.advanceTimersByTimeAsync(3_000);
    // Only keep-alive comments were sent, then the stream closed: no result, so a client may retry.
    expect(await stream.message()).toBeNull();
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'failed', resources: 1 },
    ]);
  });

  it('stops when the client closes the stream or the request is aborted', async () => {
    const server = buildServer();
    const stream = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    await stream.message();
    await stream.cancel();

    const abort = new AbortController();
    const aborted = new SseReader(
      await server.fetch(
        new Request(listen({ resourceSubscriptions: [URI_B] }), { signal: abort.signal }),
      ),
    );
    await aborted.message();
    abort.abort();
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'client', resources: 1 },
      { type: 'subscription', outcome: 'closed', reason: 'client', resources: 1 },
    ]);
    getFreeBusy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getFreeBusy).not.toHaveBeenCalled();
  });

  it('ends right after the acknowledgment when nothing asked for can be honored', async () => {
    const server = buildServer();
    for (const notifications of [
      { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      {
        resourceSubscriptions: [SLOTLOCK_MCP_APP_RESOURCE_URI, slotlockCalendarResourceUri('missing')],
      },
      { resourceSubscriptions: [] },
    ]) {
      const stream = new SseReader(await server.fetch(listen(notifications)));
      expect(await stream.message()).toMatchObject({
        method: 'notifications/subscriptions/acknowledged',
        params: { notifications: {} },
      });
      expect(await stream.message()).toMatchObject({
        id: 'req-1',
        result: { resultType: 'complete' },
      });
      expect(await stream.next()).toEqual({ type: 'end' });
    }
    expect(closedEvents()).toEqual(
      Array(3).fill({ type: 'subscription', outcome: 'closed', reason: 'empty', resources: 0 }),
    );
  });

  it('refuses a malformed filter with Invalid params before reading anything', async () => {
    const server = buildServer();
    for (const params of [
      {},
      { notifications: 'all' },
      { notifications: [] },
      { notifications: { toolsListChanged: 'yes' } },
      { notifications: { resourceSubscriptions: URI_A } },
      { notifications: { resourceSubscriptions: [URI_A, 7] } },
    ]) {
      const response = await server.fetch(modernRequest('subscriptions/listen', params));
      expect(response.status).toBe(200);
      expect(await rpc(response)).toMatchObject({ id: 'req-1', error: { code: -32602 } });
    }
    const many = Array.from({ length: 21 }, (_, index) => slotlockCalendarResourceUri(`v-${index}`));
    const tooMany = await server.fetch(listen({ resourceSubscriptions: many }));
    expect(await rpc(tooMany)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32602, message: 'Too many resource subscriptions', data: { max: 20 } },
    });
    expect(getFreeBusy).not.toHaveBeenCalled();

    // Duplicates count once.
    const repeated = await server.fetch(
      listen({ resourceSubscriptions: [...many.slice(0, 20), many[0]] }),
    );
    expect(repeated.headers.get('content-type')).toBe('text/event-stream');
    await repeated.body?.cancel();
  });

  it('caps open subscriptions per principal and across the server, counting only open ones', async () => {
    const server = buildServer({
      subscriptions: { pollIntervalMs: 1_000, maxPerPrincipal: 1, maxTotal: 2 },
    });
    const first = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    await first.message();
    const tooMany = await server.fetch(listen({ resourceSubscriptions: [URI_B] }));
    expect(tooMany.status).toBe(429);
    expect(await rpc(tooMany)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -31029, message: 'Too many subscriptions' },
    });
    const other = new SseReader(
      await server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer third')),
    );
    await other.message();
    // Each tenant holds one: the server is full for either of them.
    const full = await server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer other'));
    expect(full.status).toBe(429);

    await first.cancel();
    const again = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    expect(await again.message()).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    // A subscription that ended by itself frees its slot too.
    await vi.advanceTimersByTimeAsync(900_000);
    const later = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    expect(await later.message()).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    await later.cancel();
    await other.cancel();
  });

  it('caps open subscriptions per tenant, so one tenant with many keys cannot take them all (SURF-3)', async () => {
    // The audit's probe: one tenant minted 64 keys and opened all 256 slots, and another tenant's
    // first subscriptions/listen then answered 429. Here the tenant has six keys and the server six
    // slots; the tenant's share is two.
    authenticate.mockImplementation(async (request) => {
      const token = request.headers.get('authorization') ?? '';
      const key = /^Bearer key-(\d)$/.exec(token)?.[1];
      if (key !== undefined) return { subject: `api_key:${key}`, tenantRef: 'tenant-a' };
      return PRINCIPALS[token] ?? null;
    });
    const server = buildServer({
      subscriptions: { pollIntervalMs: 1_000, maxPerPrincipal: 4, maxPerTenant: 2, maxTotal: 6 },
    });
    const opened: SseReader[] = [];
    const statuses: number[] = [];
    for (const key of [1, 2, 3, 4, 5, 6]) {
      const response = await server.fetch(
        listen({ resourceSubscriptions: [URI_A] }, `Bearer key-${key}`),
      );
      statuses.push(response.status);
      if (response.status === 200) {
        const reader = new SseReader(response);
        await reader.message();
        opened.push(reader);
      } else {
        expect(await rpc(response)).toMatchObject({
          error: { code: -31029, message: 'Too many subscriptions' },
        });
      }
    }
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
    // Another tenant still gets a slot.
    const other = await server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer third'));
    expect(other.status).toBe(200);
    const otherReader = new SseReader(other);
    expect(await otherReader.message()).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    // A closed subscription gives the tenant its slot back.
    await opened[0]?.cancel();
    const again = await server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer key-3'));
    expect(again.status).toBe(200);
    await again.body?.cancel();
    await opened[1]?.cancel();
    await otherReader.cancel();
  });

  it('ends the oldest subscription of the tenant holding most for a tenant holding fewer when the server is full', async () => {
    // The audit's probe: 16 sign-up tenants held all 256 slots, each within its share, and every
    // other tenant's first subscriptions/listen answered 429 for as long as they held them.
    authenticate.mockImplementation(async (request) => {
      const token = request.headers.get('authorization') ?? '';
      const match = /^Bearer t(\d)-k(\d)$/.exec(token);
      return match ? { subject: `api_key:${match[1]}-${match[2]}`, tenantRef: `tenant-${match[1]}` } : null;
    });
    const server = buildServer({
      subscriptions: { pollIntervalMs: 1_000, maxPerPrincipal: 4, maxPerTenant: 2, maxTotal: 4 },
    });
    const open = async (token: string) => {
      const response = await server.fetch(listen({ resourceSubscriptions: [URI_A] }, `Bearer ${token}`));
      expect(response.status).toBe(200);
      const reader = new SseReader(response);
      await reader.message();
      return reader;
    };
    const oldest = await open('t1-k1');
    const held = [await open('t1-k2'), await open('t2-k1'), await open('t2-k2')];
    // Before, the third tenant's first listen answered 429.
    const third = await open('t3-k1');
    // The first tenant's oldest is ended gracefully, with the listen request's result.
    expect(await oldest.message()).toMatchObject({ result: { resultType: 'complete' } });
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'preempted', resources: 1 },
    ]);
    // A tenant holding as many as the largest, less one, takes nothing back.
    const refused = await server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer t1-k1'));
    expect(refused.status).toBe(429);
    for (const reader of [...held, third]) await reader.cancel();
  });

  it('releases the slot when opening fails, answering a rate limit or a fault as such', async () => {
    let limited = true;
    const server = buildServer({
      consumeRateLimit: async ({ operation }) => operation === 'protocol' || !limited,
      subscriptions: { pollIntervalMs: 1_000, maxPerPrincipal: 1 },
    });
    const refused = await server.fetch(listen({ resourceSubscriptions: [URI_A] }));
    expect(refused.status).toBe(429);
    expect(await rpc(refused)).toMatchObject({
      error: { code: -31029, message: 'Rate limit exceeded' },
    });

    limited = false;
    getFreeBusy.mockRejectedValueOnce(new Error('database down'));
    const failed = await server.fetch(listen({ resourceSubscriptions: [URI_A] }));
    expect(failed.status).toBe(500);
    expect(await rpc(failed)).toMatchObject({ error: { code: -32603 } });

    const opened = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    expect(await opened.message()).toMatchObject({
      params: { notifications: { resourceSubscriptions: [URI_A] } },
    });
    await opened.cancel();
  });

  it('drops a reader that has stopped reading', async () => {
    const server = buildServer({
      subscriptions: { pollIntervalMs: 300_000, keepAliveMs: 1_000, maxDurationMs: 86_400_000 },
    });
    const response = await server.fetch(listen({ resourceSubscriptions: [URI_A] }));
    await vi.advanceTimersByTimeAsync(250_000);
    expect(closedEvents()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'failed', resources: 1 },
    ]);
    await response.body?.cancel();
  });

  it('ends every subscription gracefully on shutdown and refuses new ones', async () => {
    const server = buildServer();
    const streams = [
      new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] }))),
      new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_B] }, 'Bearer other'))),
    ];
    for (const stream of streams) await stream.message();
    await server.shutdown();
    for (const stream of streams) {
      expect(await stream.message()).toMatchObject({
        id: 'req-1',
        result: { resultType: 'complete' },
      });
      expect(await stream.next()).toEqual({ type: 'end' });
    }
    expect(closedEvents()).toEqual(
      Array(2).fill({ type: 'subscription', outcome: 'closed', reason: 'shutdown', resources: 1 }),
    );
    const refused = await server.fetch(listen({ resourceSubscriptions: [URI_A] }));
    expect(refused.status).toBe(503);
    expect(await rpc(refused)).toMatchObject({
      error: { code: -32603, message: 'Server is shutting down' },
    });
    // Everything else still answers while the listener drains.
    expect((await server.fetch(modernRequest('tools/list'))).status).toBe(200);
  });

  it('can be switched off, and then advertises no subscribe capability', async () => {
    const server = buildServer({ subscriptions: false });
    const discovered = await rpc(await server.fetch(modernRequest('server/discover')));
    expect(discovered.result).toMatchObject({ capabilities: { resources: {} } });
    expect(
      (discovered.result as { capabilities: { resources: Record<string, unknown> } }).capabilities
        .resources,
    ).toEqual({});
    const response = await server.fetch(listen({ resourceSubscriptions: [URI_A] }));
    expect(response.status).toBe(404);
    expect(await rpc(response)).toMatchObject({ error: { code: -32601 } });
    expect((await server.fetch(modernRequest('resources/read', { uri: URI_A }))).status).toBe(200);
  });

  it('rejects out-of-range subscription options when the server is built', () => {
    for (const subscriptions of [
      { pollIntervalMs: 999 },
      { pollIntervalMs: 1_500.5 },
      { maxDurationMs: 59_999 },
      { keepAliveMs: 60_001 },
      { maxPerPrincipal: 0 },
      { maxPerTenant: 0 },
      { maxPerTenant: 10_001 },
      { maxTotal: 10_001 },
    ]) {
      expect(() => buildServer({ subscriptions })).toThrow(/subscriptions\.\w+ is invalid/);
    }
  });
});

describe('live calendar updates from the change feed (RFC 0002 P1-5)', () => {
  // A re-read every minute is only the fallback: a change must arrive long before it.
  const feedServer = (feed: ReturnType<typeof createFakeChangeFeed>, extra: object = {}) =>
    buildServer({
      subscriptions: {
        pollIntervalMs: 60_000,
        keepAliveMs: 5_000,
        maxDurationMs: 600_000,
        changes: feed.source,
        ...extra,
      },
    });

  /** Every message the stream carries from now on, as it arrives. */
  function collect(stream: SseReader): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    void (async () => {
      for (;;) {
        const message = await stream.message();
        if (message === null) return;
        messages.push(message);
      }
    })();
    return messages;
  }
  const updated = (messages: Record<string, unknown>[]) =>
    messages
      .filter((message) => message.method === 'notifications/resources/updated')
      .map((message) => (message.params as { uri: string }).uri);

  async function open(server: ReturnType<typeof buildServer>, uris: string[], token = 'Bearer valid') {
    const stream = new SseReader(await server.fetch(listen({ resourceSubscriptions: uris }, token)));
    expect(await stream.message()).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    const messages = collect(stream);
    // The reader's first read, and the one re-read that covers whatever came in between.
    await vi.advanceTimersByTimeAsync(0);
    return { stream, messages };
  }

  it('announces a booking change within a second, without waiting for the re-read', async () => {
    const feed = createFakeChangeFeed();
    const { stream, messages } = await open(feedServer(feed), [URI_A, URI_B]);
    expect(updated(messages)).toEqual([]);

    calendars.set('vehicle-b', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-b');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(messages)).toEqual([URI_B]);
    // A change to a resource it does not watch is read from the feed and announces nothing.
    feed.publish('tenant-a', 'vehicle-z');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(messages)).toEqual([URI_B]);
    for (const [params] of feed.source.listChanges.mock.calls) {
      expect(params.tenantRef).toBe('tenant-a');
    }
    await stream.cancel();
  });

  it('announces a change on a page read before a later page failed, on the next read', async () => {
    // As the store's own source: no wake-up, so the reader polls at most a second apart.
    const feed = createFakeChangeFeed({ wakes: false });
    const { stream, messages } = await open(feedServer(feed), [URI_B]);
    // Pages of `limit`; the second page of the first read after the burst fails once.
    const entries: { resourceId: string | null }[] = [];
    let failSecondPage = true;
    feed.source.listChanges.mockImplementation(async ({ after, limit = 100 }) => {
      const from = Number(after);
      if (failSecondPage && from === 500) {
        failSecondPage = false;
        throw new Error('pool timeout');
      }
      const page = entries.slice(from, from + limit);
      return { ok: true, changes: page, next: String(from + page.length) };
    });
    await vi.advanceTimersByTimeAsync(1_000);

    calendars.set('vehicle-b', [HANDOVER]);
    entries.push({ resourceId: 'vehicle-b' });
    for (let index = 1; index < 600; index += 1) entries.push({ resourceId: 'vehicle-z' });
    // Well inside the 15-second revalidation: only the feed can have announced it.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(failSecondPage).toBe(false);
    expect(updated(messages)).toEqual([URI_B]);
    await stream.cancel();
  });

  it("never tells one tenant's subscriber of another tenant's change", async () => {
    const feed = createFakeChangeFeed();
    const server = feedServer(feed);
    const tenantA = await open(server, [URI_A]);
    const tenantB = await open(server, [URI_A], 'Bearer third');
    expect(feed.listening().sort()).toEqual(['tenant-a', 'tenant-b']);

    calendars.set('vehicle-a', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(tenantA.messages)).toEqual([URI_A]);
    // Tenant b's reader was not woken and read nothing new, so its subscriber re-read nothing.
    expect(updated(tenantB.messages)).toEqual([]);
    const readsOf = (tenantRef: string) =>
      getFreeBusy.mock.calls.filter(([context]) => context.principal.tenantRef === tenantRef).length;
    const tenantBReads = readsOf('tenant-b');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readsOf('tenant-b')).toBe(tenantBReads);
    await tenantA.stream.cancel();
    await tenantB.stream.cancel();
  });

  it("shares one reader among a tenant's subscriptions", async () => {
    const feed = createFakeChangeFeed();
    const server = feedServer(feed);
    const first = await open(server, [URI_A]);
    const second = await open(server, [URI_A, URI_B], 'Bearer other');
    expect(feed.source.watch?.mock.calls.map(([tenantRef]) => tenantRef)).toEqual(['tenant-a']);
    expect(feed.source.head).toHaveBeenCalledTimes(1);

    calendars.set('vehicle-a', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(first.messages)).toEqual([URI_A]);
    expect(updated(second.messages)).toEqual([URI_A]);
    await first.stream.cancel();
    await second.stream.cancel();
  });

  it('re-syncs an expired cursor by announcing every watched resource once, then reads on from now', async () => {
    const feed = createFakeChangeFeed();
    const { stream, messages } = await open(feedServer(feed), [URI_A, URI_B]);
    feed.expire('tenant-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(messages)).toEqual([URI_A, URI_B]);
    expect(feed.source.head).toHaveBeenCalledTimes(2);

    // From the new position on, only what changes.
    calendars.set('vehicle-a', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(messages)).toEqual([URI_A, URI_B, URI_A]);
    await stream.cancel();
  });

  it('stops the reader and its wake-up when the last subscription closes or its request aborts', async () => {
    const feed = createFakeChangeFeed();
    const server = feedServer(feed);
    const first = await open(server, [URI_A]);
    await first.stream.cancel();
    expect(feed.stopped).toEqual(['tenant-a']);
    expect(feed.listening()).toEqual([]);

    const abort = new AbortController();
    const aborted = new SseReader(
      await server.fetch(
        new Request(listen({ resourceSubscriptions: [URI_B] }), { signal: abort.signal }),
      ),
    );
    await aborted.message();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.listening()).toEqual(['tenant-a']);
    abort.abort();
    expect(feed.stopped).toEqual(['tenant-a', 'tenant-a']);
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'client', resources: 1 },
      { type: 'subscription', outcome: 'closed', reason: 'client', resources: 1 },
    ]);
    feed.source.listChanges.mockClear();
    getFreeBusy.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(feed.source.listChanges).not.toHaveBeenCalled();
    expect(getFreeBusy).not.toHaveBeenCalled();
  });

  it('reads a feed with no wake-up on a short interval that backs off to one second', async () => {
    const feed = createFakeChangeFeed({ wakes: false });
    const { stream, messages } = await open(feedServer(feed), [URI_A]);
    await vi.advanceTimersByTimeAsync(30_000);
    feed.source.listChanges.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    // Quiet: once a second (SLOTLOCK_FEED_IDLE_MS), one indexed query for the tenant.
    expect(feed.source.listChanges).toHaveBeenCalledTimes(10);

    calendars.set('vehicle-a', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updated(messages)).toEqual([URI_A]);
    await stream.cancel();
  });

  it('still re-reads at the fallback interval when the feed fails, and reports why', async () => {
    const onError = vi.fn();
    const feed = createFakeChangeFeed();
    feed.source.listChanges.mockRejectedValue(new Error('feed down'));
    const { stream, messages } = await open(
      buildServer({
        onError,
        subscriptions: { pollIntervalMs: 60_000, maxDurationMs: 600_000, changes: feed.source },
      }),
      [URI_A],
    );
    expect(onError).toHaveBeenCalledWith(new Error('feed down'), { operation: null });
    calendars.set('vehicle-a', [HANDOVER]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updated(messages)).toEqual([URI_A]);
    await stream.cancel();
  });

  it('keeps the subscription caps', async () => {
    const feed = createFakeChangeFeed();
    const server = feedServer(feed, { maxPerPrincipal: 1, maxPerTenant: 1, maxTotal: 2 });
    const first = await open(server, [URI_A]);
    // Per principal, then per tenant.
    expect((await server.fetch(listen({ resourceSubscriptions: [URI_B] }))).status).toBe(429);
    expect(
      (await server.fetch(listen({ resourceSubscriptions: [URI_B] }, 'Bearer other'))).status,
    ).toBe(429);
    const second = await open(server, [URI_B], 'Bearer third');
    expect(feed.listening().sort()).toEqual(['tenant-a', 'tenant-b']);
    await first.stream.cancel();
    await second.stream.cancel();
    expect(feed.listening()).toEqual([]);
  });

  it('reads the feed at most every quarter second and re-reads a subscription at most once a second, however fast changes come', async () => {
    const feed = createFakeChangeFeed();
    const { stream, messages } = await open(feedServer(feed), [URI_A]);
    await vi.advanceTimersByTimeAsync(5_000);
    feed.source.listChanges.mockClear();
    getFreeBusy.mockClear();

    // A burst: 40 changes to the watched resource in two seconds, each waking the reader.
    for (let change = 0; change < 40; change += 1) {
      const end = new Date(Date.parse(HANDOVER.end) + change * 60_000).toISOString();
      calendars.set('vehicle-a', [{ ...HANDOVER, end }]);
      feed.publish('tenant-a', 'vehicle-a');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(feed.source.listChanges.mock.calls.length).toBeLessThanOrEqual(2_000 / 250 + 1);
    expect(getFreeBusy.mock.calls.length).toBeLessThanOrEqual(3);
    // The last change is still announced once the burst is over.
    const before = getFreeBusy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getFreeBusy.mock.calls.length).toBeLessThanOrEqual(before + 1);
    expect(updated(messages).length).toBeGreaterThanOrEqual(1);
    expect(updated(messages).length).toBeLessThanOrEqual(4);
    await stream.cancel();
  });

  it('revalidates the caller every 15 seconds by default with a feed, so a revoked key ends a quiet subscription', async () => {
    const feed = createFakeChangeFeed();
    const server = buildServer({ subscriptions: { maxDurationMs: 600_000, changes: feed.source } });
    const stream = new SseReader(await server.fetch(listen({ resourceSubscriptions: [URI_A] })));
    await stream.message();
    await vi.advanceTimersByTimeAsync(0);
    authenticate.mockResolvedValue(null);
    // No change reaches the feed: only the periodic re-read can notice.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closedEvents()).toEqual([
      { type: 'subscription', outcome: 'closed', reason: 'revoked', resources: 1 },
    ]);
    expect(feed.listening()).toEqual([]);
  });

  it("runs the shared reader outside the request that started it, and each subscription's re-reads in its own", async () => {
    const requests = new AsyncLocalStorage<string>();
    const feed = createFakeChangeFeed();
    const feedContexts: (string | undefined)[] = [];
    const listChanges = feed.source.listChanges.getMockImplementation();
    feed.source.listChanges.mockImplementation(async (params) => {
      feedContexts.push(requests.getStore());
      return (listChanges as NonNullable<typeof listChanges>)(params);
    });
    const readContexts: [string | undefined, string][] = [];
    const getFreeBusyImplementation = getFreeBusy.getMockImplementation();
    getFreeBusy.mockImplementation(async (context, input) => {
      readContexts.push([requests.getStore(), context.principal.subject]);
      return (getFreeBusyImplementation as BackendMethod)(context, input);
    });
    const server = feedServer(feed);
    const first = new SseReader(
      await requests.run('first', () => server.fetch(listen({ resourceSubscriptions: [URI_A] }))),
    );
    await first.message();
    const second = new SseReader(
      await requests.run('second', () =>
        server.fetch(listen({ resourceSubscriptions: [URI_A] }, 'Bearer other')),
      ),
    );
    await second.message();
    await vi.advanceTimersByTimeAsync(2_000);
    feedContexts.length = 0;
    readContexts.length = 0;

    calendars.set('vehicle-a', [HANDOVER]);
    feed.publish('tenant-a', 'vehicle-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feedContexts.length).toBeGreaterThan(0);
    expect(new Set(feedContexts)).toEqual(new Set([undefined]));
    expect(readContexts.sort()).toEqual([
      ['first', PRINCIPALS['Bearer valid']?.subject],
      ['second', PRINCIPALS['Bearer other']?.subject],
    ].sort());
    await first.cancel();
    await second.cancel();
  });

  it('polls when a custom source\'s watch throws, returns no promise or rejects, and frees everything when the subscription ends', async () => {
    const failures: NonNullable<SlotlockAgentChangeSource['watch']>[] = [
      () => {
        throw new Error('watch threw');
      },
      (() => 'not a stop function') as never,
      async () => {
        throw new Error('watch rejected');
      },
    ];
    for (const watch of failures) {
      const onError = vi.fn();
      const feed = createFakeChangeFeed({ wakes: false });
      const source = { ...feed.source, watch };
      const server = buildServer({
        onError,
        subscriptions: { maxPerPrincipal: 1, maxDurationMs: 600_000, changes: source },
      });
      const { stream, messages } = await open(server, [URI_A]);
      expect(onError).toHaveBeenCalledTimes(1);
      calendars.set('vehicle-a', [HANDOVER]);
      feed.publish('tenant-a', 'vehicle-a');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(updated(messages)).toEqual([URI_A]);

      await stream.cancel();
      feed.source.listChanges.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(feed.source.listChanges).not.toHaveBeenCalled();
      // The slot came back: the caller may open its one subscription again.
      const again = await open(server, [URI_A]);
      await again.stream.cancel();
      calendars.set('vehicle-a', []);
    }
  });

  it('rejects a change source without head and listChanges', () => {
    expect(() =>
      buildServer({ subscriptions: { changes: { head: async () => '0' } as never } }),
    ).toThrow(/subscriptions\.changes is invalid/);
  });
});
