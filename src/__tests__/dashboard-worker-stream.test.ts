// The dashboard Worker closes each request's database connection once the response is sent. A
// streamed assistant reply is still writing then: the relay holds the close until its last byte.
import { describe, expect, it } from 'vitest';
import { slotlockRelayStream } from '../../workers/dashboard/worker.js';

describe('the dashboard Worker and a streamed reply', () => {
  it('settles only after the stream has ended, passing every line through as written', async () => {
    let write: ((line: string) => void) | undefined;
    let end: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        write = (line) => controller.enqueue(encoder.encode(line));
        end = () => controller.close();
      },
    });
    const { response, done } = slotlockRelayStream(
      new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-test': 'kept' } }),
    );
    expect(done).not.toBeNull();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-test')).toBe('kept');
    let settled = false;
    void done?.then(() => {
      settled = true;
    });
    const read = response.text();
    write?.('{"t":"text","d":"a"}\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The turn is still running: the connection must stay open.
    expect(settled).toBe(false);
    write?.('{"t":"done"}\n');
    end?.();
    expect(await read).toBe('{"t":"text","d":"a"}\n{"t":"done"}\n');
    await done;
    expect(settled).toBe(true);
  });

  it('settles when the client goes away mid-stream, so the connection is still closed', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const { response, done } = slotlockRelayStream(
      new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
    );
    await response.body?.cancel();
    await expect(done).resolves.toBeUndefined();
  });

  it('waits, when the client goes, for the stream\u2019s own cancel to finish before it settles', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // The dashboard's stream: cancelling it stops the turn, which settles once the turn is kept.
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel: () => finished });
    const { response, done } = slotlockRelayStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }));
    let settled = false;
    void done?.then(() => {
      settled = true;
    });
    void response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    finish();
    await done;
    expect(settled).toBe(true);
  });

  it('passes any other response as it is, with nothing to wait for', () => {
    const page = new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const relayed = slotlockRelayStream(page);
    expect(relayed.response).toBe(page);
    expect(relayed.done).toBeNull();
  });
});
