// The site's one piece of Worker code: a blog post's videos, in the parts a player asks for.
//
// Workers static assets answer a request with a Range header with the whole file, 200 OK, and some
// players play a video only from a server that answers with the part asked for, 206 Partial Content
// (Safari among them): "Requests with a Range header don't get partial content ... Some clients need
// range support, for example Safari when it plays video"
// (https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/, read
// 2026-11-14). So wrangler.jsonc runs this first for /blog/*/*.mp4 and /blog/*/*.webm only (every
// other path is served as an asset, without it): it reads the file through the ASSETS binding, whose
// answer keeps public/_headers' headers, and answers one byte range of it, or the whole file.

/** One range of a file of `size` bytes, as RFC 9110 14.1.2 writes it: [first, last], 'none' when it cannot be met, or null for the whole file. */
export function byteRange(header, size) {
  const asked = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(header ?? '').trim());
  // Several ranges, or a unit other than bytes: the whole file, which a server may always send.
  if (!asked || (asked[1] === '' && asked[2] === '')) return null;
  if (asked[1] === '') {
    const length = Number(asked[2]);
    return length === 0 || size === 0 ? 'none' : [Math.max(size - length, 0), size - 1];
  }
  const first = Number(asked[1]);
  const last = asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1);
  return first >= size || last < first ? 'none' : [first, last];
}

/** The bytes first..last of a stream, reading no further than last. */
function slice(body, first, last) {
  const reader = body.getReader();
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const from = Math.max(first - at, 0);
        const to = Math.min(last + 1 - at, value.byteLength);
        at += value.byteLength;
        if (from < to) controller.enqueue(value.subarray(from, to));
        if (at > last) {
          controller.close();
          await reader.cancel();
          return;
        }
        if (from < to) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const ask = new Headers(request.headers);
    ask.delete('Range');
    ask.delete('If-Range');
    const asset = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: ask }));
    const headers = new Headers(asset.headers);
    headers.set('Accept-Ranges', 'bytes');
    const range = request.headers.get('Range');
    if (asset.status !== 200 || range === null) return new Response(asset.body, { status: asset.status, headers });
    // If-Range names the version the player has part of: another version is sent whole.
    const ifRange = request.headers.get('If-Range');
    if (ifRange !== null && ifRange !== asset.headers.get('ETag')) return new Response(asset.body, { status: 200, headers });
    let body = asset.body;
    let size = Number(asset.headers.get('Content-Length') ?? 'NaN');
    if (!Number.isSafeInteger(size)) {
      // No length given: read it (a post's video is at most 20 MB).
      const bytes = new Uint8Array(await asset.arrayBuffer());
      size = bytes.length;
      body = new Response(bytes).body;
    }
    const part = byteRange(range, size);
    if (part === null) return new Response(body, { status: 200, headers });
    if (part === 'none') {
      await body?.cancel();
      headers.set('Content-Range', `bytes */${size}`);
      headers.delete('Content-Length');
      return new Response(null, { status: 416, headers });
    }
    const [first, last] = part;
    headers.set('Content-Range', `bytes ${first}-${last}/${size}`);
    headers.set('Content-Length', String(last - first + 1));
    if (request.method === 'HEAD' || body === null) return new Response(null, { status: 206, headers });
    const bytes = slice(body, first, last);
    // In a Worker, a FixedLengthStream sends the Content-Length it was made with instead of chunks.
    if (typeof FixedLengthStream === 'function') {
      const fixed = new FixedLengthStream(last - first + 1);
      bytes.pipeTo(fixed.writable).catch(() => undefined);
      return new Response(fixed.readable, { status: 206, headers });
    }
    return new Response(bytes, { status: 206, headers });
  },
};
