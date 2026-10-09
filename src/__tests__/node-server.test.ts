import { request as requestHttp } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockNodeServer,
  type SlotlockNodeServerFetchTarget,
  createSlotlockNodeServer,
} from '../node-server.js';

const runningServers: SlotlockNodeServer[] = [];

async function startServer(
  target: SlotlockNodeServerFetchTarget,
  overrides: Partial<Parameters<typeof createSlotlockNodeServer>[1]> = {},
) {
  const adapter = createSlotlockNodeServer(target, {
    requestOrigin: 'https://calendar.example.test',
    ...overrides,
  });
  runningServers.push(adapter);
  const address = await adapter.listen({ host: '127.0.0.1', port: 0 });
  return { adapter, address };
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close({ graceMs: 0 })));
});

describe('Slotlock Node HTTP server adapter', () => {
  it('serves the fetch boundary over a real listener with a canonical request origin', async () => {
    const fetchTarget = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.url).toBe('https://calendar.example.test/slotlock/mcp?trace=bounded');
        expect(request.method).toBe('POST');
        expect(request.headers.get('authorization')).toBe('Bearer package-test');
        expect(await request.json()).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        return Response.json(
          { jsonrpc: '2.0', id: 1, result: { tools: [] } },
          { headers: { 'X-Slotlock-Test': 'passed' } },
        );
      }),
    };
    const { address } = await startServer(fetchTarget);

    const response = await fetch(`${address.origin}/slotlock/mcp?trace=bounded`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer package-test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-slotlock-test')).toBe('passed');
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect(fetchTarget.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized error and reports the private exception only to the host callback', async () => {
    const onError = vi.fn();
    const { address } = await startServer(
      {
        fetch: async () => {
          throw new Error('private-provider-credential');
        },
      },
      { onError },
    );

    const response = await fetch(`${address.origin}/slotlock/healthz`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe('{"error":{"code":"internal_error"}}');
    expect(body).not.toContain('private-provider-credential');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'private-provider-credential' }),
      'request',
    );
  });

  it('contains host observability failures and reports server errors after startup', async () => {
    const throwingObserver = vi.fn(() => {
      throw new Error('observer failed');
    });
    const { adapter } = await startServer(
      { fetch: async () => new Response('ok') },
      {
        onError: throwingObserver,
      },
    );

    expect(() => adapter.server.emit('error', new Error('accept failed'))).not.toThrow();
    expect(throwingObserver).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'accept failed' }),
      'server',
    );
  });

  it('aborts a stalled fetch target and returns a bounded gateway timeout', async () => {
    let observedAbort = false;
    const { address } = await startServer(
      {
        fetch: async (request) => {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          return new Response('late response');
        },
      },
      { handlerTimeoutMs: 20 },
    );

    const response = await fetch(`${address.origin}/slotlock/healthz`);

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: { code: 'gateway_timeout' } });
    expect(observedAbort).toBe(true);
  });

  it('propagates a disconnected client as an abort signal', async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let abortedResolve: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    const { address } = await startServer({
      fetch: async (request) => {
        enteredResolve?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              abortedResolve?.();
              resolve();
            },
            { once: true },
          );
        });
        return new Response('client left');
      },
    });

    const request = requestHttp(`${address.origin}/slotlock/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end('{}');
    await entered;
    request.destroy();

    await aborted;
  });

  it('forces bounded shutdown and aborts work that outlives the grace period', async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let requestWasAborted = false;
    const { adapter, address } = await startServer(
      {
        fetch: async (request) => {
          enteredResolve?.();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              'abort',
              () => {
                requestWasAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return new Response('shutdown');
        },
      },
      { handlerTimeoutMs: 5_000, shutdownGraceMs: 15 },
    );
    const response = fetch(`${address.origin}/slotlock/healthz`).catch(() => null);
    await entered;

    const outcome = await adapter.close();
    await response;

    expect(outcome).toEqual({ forced: true });
    expect(requestWasAborted).toBe(true);
  });

  it('uses an aborted listener lifecycle signal to begin graceful shutdown', async () => {
    const lifecycle = new AbortController();
    const adapter = createSlotlockNodeServer(
      { fetch: async () => new Response('ok') },
      { requestOrigin: 'https://calendar.example.test' },
    );
    runningServers.push(adapter);
    await adapter.listen({ host: '127.0.0.1', port: 0, signal: lifecycle.signal });

    lifecycle.abort();

    await expect(adapter.close()).resolves.toEqual({ forced: false });
  });

  it("ends a long-lived response through the target's shutdown hook instead of forcing it", async () => {
    let finish: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const shutdown = vi.fn(async () => finish());
    const { adapter, address } = await startServer(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode('event: message\ndata: {}\n\n'));
                await released;
                controller.close();
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        shutdown,
      },
      // Shorter than the keep-alive timeout: the finished stream's socket must not be left idle.
      { shutdownGraceMs: 1_000, keepAliveTimeoutMs: 5_000 },
    );
    const response = await fetch(`${address.origin}/slotlock/mcp`);
    const body = response.text();

    await expect(adapter.close()).resolves.toEqual({ forced: false });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(await body).toBe('event: message\ndata: {}\n\n');
  });

  it('reports a failing shutdown hook and still closes', async () => {
    const onError = vi.fn();
    const { adapter } = await startServer(
      {
        fetch: async () => new Response('ok'),
        shutdown: () => {
          throw new Error('hook failed');
        },
      },
      { onError },
    );

    await expect(adapter.close()).resolves.toEqual({ forced: false });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'hook failed' }),
        'shutdown',
      ),
    );
  });

  it('rejects absolute-form request targets instead of forwarding an attacker-controlled origin', async () => {
    const fetchTarget = { fetch: vi.fn(async () => new Response('unexpected')) };
    const { address } = await startServer(fetchTarget);

    const status = await new Promise<number>((resolve, reject) => {
      const request = requestHttp(
        {
          host: address.host,
          port: address.port,
          path: 'http://attacker.example/slotlock/manifest.json',
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.once('error', reject);
      request.end();
    });

    expect(status).toBe(400);
    expect(fetchTarget.fetch).not.toHaveBeenCalled();
  });

  it('rejects unbounded listener configuration before opening a socket', () => {
    const target = { fetch: async () => new Response('ok') };

    expect(() =>
      createSlotlockNodeServer(target, { requestOrigin: 'https://calendar.example.test/path' }),
    ).toThrow('requestOrigin must be an HTTP(S) origin');
    expect(() =>
      createSlotlockNodeServer(target, {
        requestOrigin: 'https://calendar.example.test',
        handlerTimeoutMs: 300_001,
      }),
    ).toThrow('handlerTimeoutMs must be an integer between 1 and 300000');
  });
});
