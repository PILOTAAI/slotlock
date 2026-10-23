// Defects an audit reproduced on the Node HTTP adapter: a chunked request body over
// `maxRequestBytes` answered only after the client finished sending it, and a `close()` during
// startup that left `listen()` pending forever.
import { once } from 'node:events';
import { request as requestHttp } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SlotlockAgentCalendarBackend, createSlotlockAgentServer } from '../agent-server.js';
import { type SlotlockNodeServer, createSlotlockNodeServer } from '../node-server.js';

const running: SlotlockNodeServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close({ graceMs: 0 })));
});

const listResources = vi.fn(async () => ({ resources: [], next_cursor: null }));
const backend = {
  listResources,
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
} as unknown as SlotlockAgentCalendarBackend;

async function startAgentServer(maxRequestBytes: number) {
  const agentServer = createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    maxRequestBytes,
    rest: true,
    backend,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer valid'
        ? { subject: 'principal-1', tenantRef: 'tenant-a' }
        : null,
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
  });
  // Whether the request the agent server answered had been aborted by then: a refused body is not
  // a client that left.
  const aborted: boolean[] = [];
  const node = createSlotlockNodeServer(
    {
      fetch: async (request) => {
        const response = await agentServer.fetch(request);
        aborted.push(request.signal.aborted);
        return response;
      },
      shutdown: () => agentServer.shutdown(),
    },
    { requestOrigin: 'http://localhost' },
  );
  running.push(node);
  return { node, aborted, address: await node.listen({ host: '127.0.0.1', port: 0 }) };
}

interface ChunkedOutcome {
  status: number | null;
  body: string;
  /** Whether the response's head arrived while the client was still sending the body. */
  answeredWhileSending: boolean;
  sentBytes: number;
  error?: string;
}

/**
 * POST a body of up to `totalBytes` with chunked transfer coding (no Content-Length), as fast as
 * the connection takes it, and stop sending as soon as the response's head arrives.
 */
function sendChunked(url: string, totalBytes: number): Promise<ChunkedOutcome> {
  return new Promise((resolve) => {
    const outcome: ChunkedOutcome = {
      status: null,
      body: '',
      answeredWhileSending: false,
      sentBytes: 0,
    };
    let sending = true;
    let answered: () => void = () => {};
    const answer = new Promise<void>((settle) => {
      answered = settle;
    });
    const request = requestHttp(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
    });
    request.on('response', (response) => {
      outcome.status = response.statusCode ?? null;
      outcome.answeredWhileSending = sending;
      answered();
      response.setEncoding('utf8');
      response.on('data', (text: string) => {
        outcome.body += text;
      });
      response.once('end', () => {
        request.destroy();
        resolve(outcome);
      });
      response.once('error', () => resolve(outcome));
    });
    request.once('error', (error) => {
      outcome.error = error.message;
      answered();
      resolve(outcome);
    });
    void (async () => {
      const chunk = Buffer.alloc(16 * 1_024, ' ');
      request.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"');
      while (outcome.sentBytes < totalBytes && outcome.status === null && !request.destroyed) {
        outcome.sentBytes += chunk.byteLength;
        if (!request.write(chunk)) {
          await Promise.race([once(request, 'drain'), answer]);
        }
      }
      if (outcome.status === null && !request.destroyed) {
        sending = false;
        request.end('"}}');
      }
    })();
  });
}

describe('P1: a chunked body over maxRequestBytes, through the Node adapter', () => {
  for (const path of ['/slotlock/mcp', '/slotlock/a2a', '/slotlock/v1/events']) {
    it(`answers 413 on ${path} before the client has finished sending`, async () => {
      const { address, aborted } = await startAgentServer(1_024);
      const outcome = await sendChunked(`${address.origin}${path}`, 16 * 1_024 * 1_024);
      expect(aborted).toEqual([false]);
      expect(outcome.error).toBeUndefined();
      expect(outcome.status).toBe(413);
      expect(outcome.answeredWhileSending).toBe(true);
      expect(outcome.sentBytes).toBeLessThan(16 * 1_024 * 1_024);
      expect(outcome.body).toContain(path.endsWith('/v1/events') ? 'request_too_large' : '-32700');
      expect(listResources).not.toHaveBeenCalled();
    });
  }

  it('keeps serving: the connection that sent too much does not hold the server', async () => {
    const { node, address } = await startAgentServer(1_024);
    expect((await sendChunked(`${address.origin}/slotlock/mcp`, 4 * 1_024 * 1_024)).status).toBe(
      413,
    );
    const health = await fetch(`${address.origin}/slotlock/healthz`);
    expect(health.status).toBe(200);
    await expect(node.close({ graceMs: 1_000 })).resolves.toEqual({ forced: false });
  });

  it('still reads a chunked body within the limit whole', async () => {
    const { address } = await startAgentServer(1_024);
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = requestHttp(`${address.origin}/slotlock/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
      });
      request.once('error', reject);
      request.on('response', (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (text: string) => {
          body += text;
        });
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
      });
      const json = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slotlock_list_resources', arguments: { limit: 10 } },
      });
      request.write(json.slice(0, 30));
      setTimeout(() => request.end(json.slice(30)), 20);
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ result: { structuredContent: {} } });
    expect(listResources).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
  });
});

describe('P1: what is left of a body once it is answered', () => {
  it('errors a read the target left pending, instead of leaving it to hang', async () => {
    let read: Promise<unknown> = Promise.resolve('never read');
    const node = createSlotlockNodeServer(
      {
        fetch: async (request) => {
          const reader = (request.body as ReadableStream<Uint8Array>).getReader();
          await reader.read();
          read = reader.read().catch((error: unknown) => error);
          return new Response('answered');
        },
      },
      { requestOrigin: 'http://localhost' },
    );
    running.push(node);
    const { origin } = await node.listen({ host: '127.0.0.1', port: 0 });
    const request = requestHttp(`${origin}/upload`, { method: 'POST' });
    request.on('error', () => undefined);
    const answered = new Promise<string>((resolve) => {
      request.on('response', (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.once('end', () => resolve(text));
      });
    });
    // Part of a chunked body, and the rest never comes.
    request.write('partial');
    expect(await answered).toBe('answered');
    const outcome = await Promise.race([
      read,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 1_000)),
    ]);
    request.destroy();
    expect(outcome).toMatchObject({ name: 'AbortError', message: 'request_body_discarded' });
  });
});

describe('P3: close() during startup', () => {
  it('rejects the pending listen with listen_aborted and leaves no socket listening', async () => {
    const node = createSlotlockNodeServer(
      { fetch: async () => new Response('ok') },
      { requestOrigin: 'https://calendar.example.test' },
    );
    running.push(node);
    const listening = node.listen({ host: '127.0.0.1', port: 0 }).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    await expect(node.close()).resolves.toEqual({ forced: false });
    const settled = await Promise.race([
      listening,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 1_000)),
    ]);
    expect(settled).toBeInstanceOf(Error);
    expect(settled).toMatchObject({ name: 'AbortError', message: 'listen_aborted' });
    expect(node.server.listening).toBe(false);
  });

  it('settles once, on a busy port and with a lifecycle signal that aborts afterwards', async () => {
    const first = createSlotlockNodeServer(
      { fetch: async () => new Response('ok') },
      { requestOrigin: 'https://calendar.example.test' },
    );
    running.push(first);
    const { port } = await first.listen({ host: '127.0.0.1', port: 0 });
    const onError = vi.fn();
    const lifecycle = new AbortController();
    const second = createSlotlockNodeServer(
      { fetch: async () => new Response('ok') },
      { requestOrigin: 'https://calendar.example.test', onError },
    );
    const listening = second
      .listen({ host: '127.0.0.1', port, signal: lifecycle.signal })
      .catch((error: unknown) => error);
    const pending = (label: string) =>
      new Promise((resolve) => setTimeout(() => resolve(`${label} still pending`), 1_000));
    expect(await Promise.race([second.close(), pending('close')])).toEqual({ forced: false });
    lifecycle.abort();
    // close() came first, so the busy port is never tried: the listen is aborted, not failed.
    expect(await Promise.race([listening, pending('listen')])).toMatchObject({
      message: 'listen_aborted',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.server.listening).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
