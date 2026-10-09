// Requests and SSE reading for tests of the MCP 2026-07-28 (stateless, per-request `_meta`) era.
import { SLOTLOCK_MCP_PROTOCOL_VERSION } from '../../agent-server.js';

export const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
export const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
export const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';

export interface ModernOptions {
  /** `undefined` sends `id: "req-1"`; `'none'` sends a notification. */
  id?: string | number | null | 'none';
  /** Extra or replacement `_meta` entries; `null` sends no `_meta` at all. */
  meta?: Record<string, unknown> | null;
  /** Header overrides; `null` removes the header. */
  headers?: Record<string, string | null>;
}

/** A well-formed MCP 2026-07-28 request: `_meta` envelope plus the mirrored HTTP headers. */
export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: ModernOptions = {},
): Request {
  const meta =
    options.meta === null
      ? undefined
      : {
          [PROTOCOL_VERSION_KEY]: SLOTLOCK_MCP_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_KEY]: {},
          [CLIENT_INFO_KEY]: { name: 'modern-test', version: '1.0.0' },
          ...options.meta,
        };
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
    params: meta === undefined ? params : { ...params, _meta: meta },
  };
  if (options.id !== 'none') body.id = options.id === undefined ? 'req-1' : options.id;
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer valid',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION,
    'Mcp-Method': method,
  });
  const name = method === 'resources/read' ? params.uri : params.name;
  if (typeof name === 'string') headers.set('Mcp-Name', name);
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request('http://localhost/slotlock/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export async function rpc(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export type SseBlock =
  | { type: 'message'; message: Record<string, unknown> }
  | { type: 'comment' }
  | { type: 'end' };

/** Reads an SSE response one block at a time: a JSON-RPC message, a comment, or the stream's end. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    if (!response.body) throw new Error('SSE response has no body');
    this.reader = response.body.getReader();
  }

  async next(): Promise<SseBlock> {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        if (block.startsWith(':')) return { type: 'comment' };
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        return { type: 'message', message: JSON.parse(data) as Record<string, unknown> };
      }
      const { value, done } = await this.reader.read();
      if (done) return { type: 'end' };
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** The next JSON-RPC message, skipping keep-alive comments; `null` at the end of the stream. */
  async message(): Promise<Record<string, unknown> | null> {
    for (;;) {
      const block = await this.next();
      if (block.type === 'end') return null;
      if (block.type === 'message') return block.message;
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}
