// Shutdown while a refused body is still arriving: the keep-alive connection a 413 left open must
// close once the client finishes the body, or close() waits out its grace and forces every one.
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SlotlockAgentCalendarBackend, createSlotlockAgentServer } from '../agent-server.js';
import { type SlotlockNodeServer, createSlotlockNodeServer } from '../node-server.js';

const running: SlotlockNodeServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close({ graceMs: 0 })));
});
const backend = {
  listResources: vi.fn(async () => ({ resources: [], next_cursor: null })),
} as unknown as SlotlockAgentCalendarBackend;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function shutdownAround413(finishBodyBeforeAnswer: boolean) {
  const agent = createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    maxRequestBytes: 1_024,
    backend,
    // A slow credential check, so shutdown begins while the request is in flight.
    authenticate: async () => {
      await wait(300);
      return { subject: 'principal-1', tenantRef: 'tenant-a' };
    },
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
  });
  const node = createSlotlockNodeServer(agent, { requestOrigin: 'http://localhost' });
  running.push(node);
  const { port } = await node.listen({ host: '127.0.0.1', port: 0 });
  const socket = connect(port, '127.0.0.1');
  let text = '';
  socket.on('data', (data) => {
    text += data.toString('latin1');
  });
  socket.on('error', () => undefined);
  socket.write(
    'POST /slotlock/mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
      'MCP-Protocol-Version: 2025-11-25\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `800\r\n${' '.repeat(0x800)}\r\n${finishBodyBeforeAnswer ? '0\r\n\r\n' : ''}`,
  );
  await wait(100);
  const started = Date.now();
  const closing = node.close({ graceMs: 3_000 });
  await wait(400); // the 413 is written during shutdown
  if (!finishBodyBeforeAnswer) socket.write('0\r\n\r\n'); // the client then finishes its body
  const result = await closing;
  socket.destroy();
  return { status: text.slice(9, 12), result, tookMs: Date.now() - started };
}

describe('closing while a 413 body is still arriving', () => {
  it('closes at once when the body was complete before the 413 (the canary)', async () => {
    const outcome = await shutdownAround413(true);
    expect(outcome.status).toBe('413');
    expect(outcome.result).toEqual({ forced: false });
    expect(outcome.tookMs).toBeLessThan(1_000);
  });

  it('closes the connection once the body that was still arriving ends', async () => {
    const outcome = await shutdownAround413(false);
    expect(outcome.status).toBe('413');
    expect(outcome.result).toEqual({ forced: false });
    expect(outcome.tookMs).toBeLessThan(1_000);
  });

  it('drops a client that trickles its refused body past requestTimeout', async () => {
    const agent = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost/slotlock',
      allowInsecureLocalhost: true,
      maxRequestBytes: 1_024,
      backend,
      authenticate: async () => ({ subject: 'principal-1', tenantRef: 'tenant-a' }),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
    });
    const node = createSlotlockNodeServer(agent, {
      requestOrigin: 'http://localhost',
      requestTimeoutMs: 1_000,
      headersTimeoutMs: 1_000,
    });
    running.push(node);
    const { port } = await node.listen({ host: '127.0.0.1', port: 0 });
    const socket = connect(port, '127.0.0.1');
    let closedAt: number | undefined;
    // Read the 413, or the socket never reaches the server's end and never closes.
    socket.resume();
    socket.on('close', () => {
      closedAt = Date.now();
    });
    socket.on('error', () => undefined);
    const started = Date.now();
    socket.write(
      'POST /slotlock/mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
        'MCP-Protocol-Version: 2025-11-25\r\nTransfer-Encoding: chunked\r\n\r\n' +
        `800\r\n${' '.repeat(0x800)}\r\n`,
    );
    // One byte at a time after the 413, for up to four seconds.
    for (let i = 0; i < 20 && closedAt === undefined; i += 1) {
      await wait(200);
      if (!socket.destroyed) socket.write('1\r\n \r\n');
    }
    socket.destroy();
    expect(closedAt).toBeDefined();
    expect((closedAt as number) - started).toBeLessThan(3_000);
  });
});
