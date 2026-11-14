// The site's one Worker script (site/worker/range.mjs): a blog post's videos in the byte ranges a
// player asks for, which Workers static assets do not give (they answer a Range request with the whole
// file), and which Safari needs to play a video. It runs only for a post's .mp4 and .webm files, in
// the site and in its preview Worker alike.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import worker, { byteRange } from '../../site/worker/range.mjs';

const FILE = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);

/** The ASSETS binding: the file with the headers public/_headers gives it, or a 404. */
function assets(options: { length?: boolean } = {}) {
  const asked: Request[] = [];
  return {
    asked,
    binding: {
      async fetch(request: Request): Promise<Response> {
        asked.push(request);
        if (!new URL(request.url).pathname.endsWith('/hold.mp4')) return new Response('Not found', { status: 404 });
        const headers: Record<string, string> = { 'content-type': 'video/mp4', etag: '"v1"', 'x-content-type-options': 'nosniff' };
        if (options.length !== false) headers['content-length'] = String(FILE.length);
        return new Response(request.method === 'HEAD' ? null : new Blob([FILE]).stream(), { headers });
      },
    },
  };
}
const ask = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://slotlock.pylota.io${path}`, { method, headers });

describe('the site\'s range Worker', () => {
  it('reads one byte range as RFC 9110 writes it, and the whole file for anything else', () => {
    expect(byteRange('bytes=0-1', 1000)).toEqual([0, 1]);
    expect(byteRange('bytes=900-', 1000)).toEqual([900, 999]);
    expect(byteRange('bytes=-100', 1000)).toEqual([900, 999]);
    expect(byteRange('bytes=-5000', 1000)).toEqual([0, 999]);
    expect(byteRange('bytes=10-99999', 1000)).toEqual([10, 999]);
    expect(byteRange('bytes=1000-', 1000)).toBe('none');
    expect(byteRange('bytes=5-4', 1000)).toBe('none');
    expect(byteRange('bytes=-0', 1000)).toBe('none');
    for (const header of ['bytes=0-1,5-9', 'items=0-1', 'bytes=-', 'bytes=a-b', '', null]) expect(byteRange(header, 1000), String(header)).toBeNull();
  });

  it('answers the part a player asks for, 206 with its Content-Range, keeping the asset\'s headers', async () => {
    const { binding, asked } = assets();
    const part = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=100-199' }), { ASSETS: binding });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(FILE.subarray(100, 200)))).toBe(true);
    // The asset is asked for whole: static assets would ignore the range anyway.
    expect(asked[0]?.headers.get('range')).toBeNull();
    const tail = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=-10' }), { ASSETS: binding });
    expect(Buffer.from(await tail.arrayBuffer()).equals(Buffer.from(FILE.subarray(990)))).toBe(true);
    // Safari's first question: the first two bytes.
    const first = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=0-1' }), { ASSETS: binding });
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([0, 1]);
  });

  it('sends the whole file without a range, with another version, or for several ranges; refuses a range past its end', async () => {
    const { binding } = assets();
    const whole = await worker.fetch(ask('/blog/a-post/hold.mp4'), { ASSETS: binding });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const changed = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=0-9', 'if-range': '"v0"' }), { ASSETS: binding });
    expect(changed.status).toBe(200);
    const same = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=0-9', 'if-range': '"v1"' }), { ASSETS: binding });
    expect(same.status).toBe(206);
    expect((await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=0-1,4-5' }), { ASSETS: binding })).status).toBe(200);
    const past = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=1000-' }), { ASSETS: binding });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */1000');
  });

  it('measures a file the binding gives no length for, answers HEAD without a body, passes a 404 on, and takes GET and HEAD only', async () => {
    const unmeasured = assets({ length: false });
    const part = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=990-' }), { ASSETS: unmeasured.binding });
    expect(part.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(FILE.subarray(990)))).toBe(true);
    const { binding } = assets();
    const head = await worker.fetch(ask('/blog/a-post/hold.mp4', { range: 'bytes=0-9' }, 'HEAD'), { ASSETS: binding });
    expect(head.status).toBe(206);
    expect(head.body).toBeNull();
    expect((await worker.fetch(ask('/blog/a-post/gone.mp4', { range: 'bytes=0-1' }), { ASSETS: binding })).status).toBe(404);
    const post = await worker.fetch(ask('/blog/a-post/hold.mp4', {}, 'POST'), { ASSETS: binding });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('runs first for a post\'s videos only, in the site and its preview alike', () => {
    for (const file of ['site/wrangler.jsonc', 'site/wrangler.preview.jsonc']) {
      const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { main?: string; assets?: { binding?: string; run_worker_first?: string[] } };
      expect(config.main, file).toBe('worker/range.mjs');
      expect(config.assets?.binding, file).toBe('ASSETS');
      expect(config.assets?.run_worker_first, file).toEqual(['/blog/*/*.mp4', '/blog/*/*.webm']);
    }
  });
});
