// A fetch-style handler served by node:http: the request body read up to a limit (413 past it), the
// response written as the handler made it, and a handler that throws answered 500 with nothing of
// the error.
import type { IncomingMessage, ServerResponse } from 'node:http';

export function serveFetchHandler(
  handler: (request: Request) => Promise<Response>,
  options: { maxBodyBytes: number; onError?: (error: unknown) => void },
): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  return (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    const fail = (status: number): void => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify({ error: { code: status === 413 ? 'payload_too_large' : 'internal_error' } }));
    };
    incoming.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > options.maxBodyBytes) {
        refused = true;
        fail(413);
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('error', () => {
      refused = true;
    });
    incoming.on('end', () => {
      if (refused) return;
      void (async () => {
        try {
          const method = incoming.method ?? 'GET';
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each);
          }
          // The URL's origin is not trusted for anything: links are built from the public URL.
          const request = new Request(new URL(incoming.url ?? '/', 'http://localhost'), {
            method,
            headers,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
          });
          const response = await handler(request);
          const answer: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            answer[name] = value;
          });
          outgoing.writeHead(response.status, answer);
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          options.onError?.(error);
          fail(500);
        }
      })();
    });
  };
}

/** Run `task` now and every `everyMs` until `signal` aborts; one at a time, never overlapping. */
export async function every(everyMs: number, signal: AbortSignal, task: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    await task().catch(() => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, everyMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

/** A setting from the environment, or exit naming it. */
export function setting(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) {
    console.error(JSON.stringify({ level: 'error', message: `${name} is not set` }));
    process.exit(2);
  }
  return value;
}
