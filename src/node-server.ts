// Kept in the emitted node-server.d.ts: this entry point's types import `node:http`.
/// <reference types="node" preserve="true" />
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Readable, finished } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** How often Node checks its connections against headersTimeout and requestTimeout, at most. */
const DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_MAX_HEADER_BYTES = 16_384;
const DEFAULT_MAX_REQUESTS_PER_SOCKET = 100;
const MAX_TIMEOUT_MS = 300_000;
const MAX_SHUTDOWN_GRACE_MS = 60_000;
const MAX_HEADER_BYTES = 65_536;
const MAX_REQUESTS_PER_SOCKET = 10_000;
const HANDLER_TIMEOUT = Symbol('handler_timeout');

export type SlotlockNodeServerErrorPhase = 'client' | 'listen' | 'request' | 'server' | 'shutdown';

/** The narrow Fetch-compatible boundary returned by `createSlotlockAgentServer`. */
export interface SlotlockNodeServerFetchTarget {
  fetch(request: Request): Promise<Response>;
  /**
   * Called once when `close()` begins, after the listener stops accepting connections, to end
   * long-lived responses (MCP subscription streams) so they drain within the grace period.
   */
  shutdown?(): Promise<void> | void;
}

export interface SlotlockNodeServerOptions {
  /**
   * Canonical origin used to construct the Request passed to authentication and policy callbacks.
   * It is explicit so an untrusted Host or forwarding header can never choose security context.
   */
  requestOrigin: string;
  handlerTimeoutMs?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxHeaderBytes?: number;
  maxRequestsPerSocket?: number;
  onError?: (error: Error, phase: SlotlockNodeServerErrorPhase) => void;
}

export interface SlotlockNodeListenOptions {
  port: number;
  host?: string;
  /** Aborting this signal begins the same bounded graceful shutdown as `close()`. */
  signal?: AbortSignal;
}

export interface SlotlockNodeServerAddress {
  host: string;
  port: number;
  /** Plain HTTP listener origin. Terminate public TLS at a trusted reverse proxy. */
  origin: string;
}

export interface SlotlockNodeServerCloseResult {
  /** True when in-flight work exceeded the grace period and connections were destroyed. */
  forced: boolean;
}

export interface SlotlockNodeServer {
  readonly server: Server;
  listen(options: SlotlockNodeListenOptions): Promise<SlotlockNodeServerAddress>;
  close(options?: { graceMs?: number }): Promise<SlotlockNodeServerCloseResult>;
}

interface ValidatedOptions {
  requestOrigin: string;
  handlerTimeoutMs: number;
  shutdownGraceMs: number;
  onError?: (error: Error, phase: SlotlockNodeServerErrorPhase) => void;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('requestOrigin must be an HTTP(S) origin without credentials, path, or query');
  }
  return parsed.origin;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('unknown_error');
}

function safeReport(
  callback: ValidatedOptions['onError'],
  error: unknown,
  phase: SlotlockNodeServerErrorPhase,
): void {
  try {
    callback?.(toError(error), phase);
  } catch {
    // Observability must never alter protocol or shutdown behaviour.
  }
}

function abortReason(code: string): Error {
  const error = new Error(code);
  error.name = 'AbortError';
  return error;
}

function timer(ms: number): { promise: Promise<void>; clear(): void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
  });
  return {
    promise,
    clear() {
      if (timeout) clearTimeout(timeout);
    },
  };
}

function appendIncomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/** A request body as the fetch target reads it, and how to drop what the client still sends. */
interface RequestBody {
  stream: ReadableStream<Uint8Array>;
  /** Stop delivering the body and discard the rest of it as it arrives. */
  discard(): void;
}

/**
 * The request body as a web stream that a target may cancel, as it does a body over its size limit.
 * Cancelling a `Readable.toWeb` stream destroys the IncomingMessage: Node emits 'aborted', read
 * here as the client leaving, and the unread rest stays on the connection, which then holds
 * `close()` until it is forced. Cancelling this one only stops delivery; once the response is
 * written the rest is discarded as it arrives, as Node discards a body no handler reads, within
 * `requestTimeout`.
 */
function requestBody(request: IncomingMessage): RequestBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Once the stream is closed, errored or cancelled, what arrives is dropped.
  let settled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(started) {
        controller = started;
        request.pause();
        request.on('data', (chunk: Buffer) => {
          if (settled) return;
          started.enqueue(new Uint8Array(chunk));
          if ((started.desiredSize ?? 0) <= 0) request.pause();
        });
        finished(request, (error) => {
          if (settled) return;
          settled = true;
          if (error) started.error(error);
          else started.close();
        });
      },
      pull() {
        if (!settled) request.resume();
      },
      cancel() {
        // Held until the response is written, so the client is not read from while it waits.
        settled = true;
        request.pause();
      },
    },
    { highWaterMark: request.readableHighWaterMark, size: (chunk) => chunk.byteLength },
  );
  return {
    stream,
    discard() {
      // A target still reading a body it has already answered gets an error, not a read that
      // never settles.
      if (!settled) {
        settled = true;
        controller?.error(abortReason('request_body_discarded'));
      }
      request.resume();
    },
  };
}

function toWebRequest(
  request: IncomingMessage,
  requestOrigin: string,
  signal: AbortSignal,
): { request: Request; body?: RequestBody } {
  const target = request.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//')) {
    throw new Error('invalid_request_target');
  }
  // URL parsing resolves dot segments, `%2E` spellings included: `/v1/resources/%2E%2E/availability`
  // would reach the target as `/v1/availability`, a path parameter of `..` naming another route.
  const path = target.split(/[?#]/, 1)[0] ?? '';
  if (path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('invalid_request_target');
  }
  const url = new URL(target, requestOrigin);
  if (url.origin !== requestOrigin) throw new Error('invalid_request_target');

  // Node's fetch implementation requires `duplex: 'half'` for streamed request bodies, but the
  // DOM RequestInit visible to workspace consumers does not declare that Node-only extension.
  // Keep the cast at this adapter boundary; real-socket tests exercise the actual undici contract.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method ?? 'GET',
    headers: appendIncomingHeaders(request),
    signal,
  };
  let body: RequestBody | undefined;
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    body = requestBody(request);
    init.body = body.stream as unknown as NonNullable<RequestInit['body']>;
    init.duplex = 'half';
  }
  try {
    return { request: new Request(url, init), ...(body ? { body } : {}) };
  } catch (error) {
    // A method the Fetch API forbids, say: nothing will read the body, so drop it as it arrives.
    body?.discard();
    throw error;
  }
}

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function writeWebResponse(webResponse: Response, response: ServerResponse): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(name)) response.setHeader(name, value);
  });
  const headersWithCookies = webResponse.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headersWithCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader('set-cookie', cookies);

  if (!webResponse.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(webResponse.body as NodeReadableStream<Uint8Array>);
  await pipeline(body, response);
}

function writeJsonError(
  response: ServerResponse,
  status: number,
  code: 'bad_request' | 'gateway_timeout' | 'internal_error' | 'server_shutting_down',
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = status;
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify({ error: { code } }));
}

function formatListenerOrigin(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * Adapt the Fetch boundary returned by `createSlotlockAgentServer` to a hardened Node HTTP listener.
 * The listener is intentionally HTTP-only; public HTTPS termination and trusted proxy policy remain
 * deployment concerns, while Request identity always uses the explicit canonical `requestOrigin`.
 */
export function createSlotlockNodeServer(
  target: SlotlockNodeServerFetchTarget,
  options: SlotlockNodeServerOptions,
): SlotlockNodeServer {
  const requestTimeoutMs = boundedInteger(
    'requestTimeoutMs',
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const headersTimeoutMs = boundedInteger(
    'headersTimeoutMs',
    options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new RangeError('headersTimeoutMs must not exceed requestTimeoutMs');
  }
  const config: ValidatedOptions = {
    requestOrigin: validateOrigin(options.requestOrigin),
    handlerTimeoutMs: boundedInteger(
      'handlerTimeoutMs',
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    ),
    shutdownGraceMs: boundedInteger(
      'shutdownGraceMs',
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      0,
      MAX_SHUTDOWN_GRACE_MS,
    ),
  };
  if (options.onError) config.onError = options.onError;

  const activeRequests = new Set<AbortController>();
  let state: 'new' | 'starting' | 'listening' | 'closing' | 'closed' = 'new';
  // Read through a function: inside a request handler TypeScript would keep the narrowing of its
  // opening check, but `close()` can change the state while the handler awaits.
  const closing = (): boolean => state === 'closing';
  let removeLifecycleAbort: (() => void) | undefined;
  /** Rejects a listen() still starting with `listen_aborted`; set while one is. */
  let cancelStartup: (() => void) | undefined;
  let closePromise: Promise<SlotlockNodeServerCloseResult> | undefined;

  const server = createServer(
    {
      headersTimeout: headersTimeoutMs,
      requestTimeout: requestTimeoutMs,
      // Node enforces both only when it checks its connections (every 30 s by default), so a body
      // trickled after its answer could outlast requestTimeout by that much.
      connectionsCheckingInterval: Math.min(
        DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS,
        headersTimeoutMs,
        requestTimeoutMs,
      ),
      keepAliveTimeout: boundedInteger(
        'keepAliveTimeoutMs',
        options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
        1,
        MAX_TIMEOUT_MS,
      ),
      maxHeaderSize: boundedInteger(
        'maxHeaderBytes',
        options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES,
        1_024,
        MAX_HEADER_BYTES,
      ),
      insecureHTTPParser: false,
      requireHostHeader: true,
    },
    async (request, response) => {
      if (state === 'closing' || state === 'closed') {
        response.setHeader('Connection', 'close');
        writeJsonError(response, 503, 'server_shutting_down');
        return;
      }

      const controller = new AbortController();
      activeRequests.add(controller);
      const abortForClient = () => {
        if (!controller.signal.aborted) controller.abort(abortReason('client_disconnected'));
      };
      request.once('aborted', abortForClient);
      response.once('close', () => {
        if (!response.writableFinished) abortForClient();
      });

      let webRequest: Request;
      let body: RequestBody | undefined;
      try {
        ({ request: webRequest, body } = toWebRequest(
          request,
          config.requestOrigin,
          controller.signal,
        ));
      } catch {
        activeRequests.delete(controller);
        request.resume();
        writeJsonError(response, 400, 'bad_request');
        return;
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const handlerTimeout = new Promise<typeof HANDLER_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(HANDLER_TIMEOUT), config.handlerTimeoutMs);
        timeout.unref();
      });
      try {
        const outcome = await Promise.race([target.fetch(webRequest), handlerTimeout]);
        if (outcome === HANDLER_TIMEOUT) {
          controller.abort(abortReason('handler_timeout'));
          safeReport(config.onError, new Error('handler_timeout'), 'request');
          writeJsonError(response, 504, 'gateway_timeout');
          return;
        }
        if (!(outcome instanceof Response)) throw new Error('invalid_fetch_response');
        await writeWebResponse(outcome, response);
      } catch (error) {
        if (!controller.signal.aborted) {
          safeReport(config.onError, error, 'request');
          writeJsonError(response, 500, 'internal_error');
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        activeRequests.delete(controller);
        // The answer is written: what is left of a body the target did not read (one it refused as
        // too large, say) is discarded as it arrives rather than held.
        if (!request.complete) {
          body?.discard();
          // The connection is idle only once that rest has arrived: close it then if shutting down.
          request.once('end', () => {
            setImmediate(() => {
              if (closing()) server.closeIdleConnections();
            });
          });
        }
        // A keep-alive connection whose response finished during shutdown would otherwise hold
        // `server.close()` open until its idle timeout; Node closed only the idle ones at the start.
        if (closing()) server.closeIdleConnections();
      }
    },
  );
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = boundedInteger(
    'maxRequestsPerSocket',
    options.maxRequestsPerSocket ?? DEFAULT_MAX_REQUESTS_PER_SOCKET,
    1,
    MAX_REQUESTS_PER_SOCKET,
  );
  server.on('clientError', (_error, socket) => {
    safeReport(config.onError, new Error('malformed_http_request'), 'client');
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  const close = (closeOptions: { graceMs?: number } = {}) => {
    if (closePromise) return closePromise;
    const graceMs = boundedInteger(
      'graceMs',
      closeOptions.graceMs ?? config.shutdownGraceMs,
      0,
      MAX_SHUTDOWN_GRACE_MS,
    );
    closePromise = (async (): Promise<SlotlockNodeServerCloseResult> => {
      removeLifecycleAbort?.();
      removeLifecycleAbort = undefined;
      if (state === 'starting') {
        // Closed before it was listening. Node abandons a listen whose server closes first, with
        // neither 'listening' nor 'error', so the pending listen() is rejected here, as an aborted
        // signal rejects it.
        state = 'closing';
        cancelStartup?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        state = 'closed';
        return { forced: false };
      }
      if (state === 'new' || state === 'closed') {
        state = 'closed';
        return { forced: false };
      }
      state = 'closing';

      const closed = new Promise<void>((resolve) => {
        server.close((error) => {
          if (error) safeReport(config.onError, error, 'shutdown');
          resolve();
        });
        server.closeIdleConnections();
      });
      // Not awaited: a slow or failing hook must not hold shutdown past its grace period.
      void (async () => {
        try {
          await target.shutdown?.();
        } catch (error) {
          safeReport(config.onError, error, 'shutdown');
        }
      })();
      const deadline = timer(graceMs);
      const first = await Promise.race([
        closed.then(() => 'closed' as const),
        deadline.promise.then(() => 'deadline' as const),
      ]);
      if (first === 'closed') {
        deadline.clear();
        state = 'closed';
        return { forced: false };
      }

      for (const controller of activeRequests) {
        if (!controller.signal.aborted) controller.abort(abortReason('server_shutting_down'));
      }
      safeReport(config.onError, new Error('graceful_shutdown_timeout'), 'shutdown');
      server.closeAllConnections();
      await closed;
      state = 'closed';
      return { forced: true };
    })();
    return closePromise;
  };

  return {
    server,
    listen(listenOptions) {
      if (state !== 'new') return Promise.reject(new Error('Slotlock Node server can listen once'));
      const port = boundedInteger('port', listenOptions.port, 0, 65_535);
      const host = listenOptions.host ?? '127.0.0.1';
      if (!host || host.length > 253 || host.includes('\0')) {
        return Promise.reject(new Error('host must be a bounded hostname or IP address'));
      }
      if (listenOptions.signal?.aborted) {
        state = 'closed';
        return Promise.reject(abortReason('listen_aborted'));
      }
      state = 'starting';
      return new Promise<SlotlockNodeServerAddress>((resolve, reject) => {
        let abortRequested = false;
        let cancelled = false;
        const onAbort = () => {
          abortRequested = true;
          if (state === 'listening') void close();
        };
        const cleanupStartup = () => {
          cancelStartup = undefined;
          server.off('error', onListenError);
          server.off('listening', onListening);
        };
        const onListenError = (error: Error) => {
          cleanupStartup();
          listenOptions.signal?.removeEventListener('abort', onAbort);
          safeReport(config.onError, error, 'listen');
          if (cancelled) return;
          state = 'closed';
          reject(error);
        };
        const onListening = () => {
          cleanupStartup();
          if (cancelled) {
            // close() came first; a listener that bound all the same goes with it.
            server.close();
            return;
          }
          const address = server.address();
          if (!address || typeof address === 'string') {
            state = 'closing';
            void close().finally(() => reject(new Error('Slotlock Node server has no TCP address')));
            return;
          }
          state = 'listening';
          server.on('error', (error) => safeReport(config.onError, error, 'server'));
          if (listenOptions.signal) {
            removeLifecycleAbort = () =>
              listenOptions.signal?.removeEventListener('abort', onAbort);
          }
          if (abortRequested) {
            void close().finally(() => reject(abortReason('listen_aborted')));
            return;
          }
          resolve({
            host: address.address,
            port: address.port,
            origin: formatListenerOrigin(address.address, address.port),
          });
        };
        cancelStartup = () => {
          cancelled = true;
          cancelStartup = undefined;
          listenOptions.signal?.removeEventListener('abort', onAbort);
          reject(abortReason('listen_aborted'));
        };
        listenOptions.signal?.addEventListener('abort', onAbort, { once: true });
        server.once('error', onListenError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close,
  };
}
