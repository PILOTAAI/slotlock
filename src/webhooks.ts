// Webhook delivery of the event feed (RFC 0002 P1-5): each change is a CloudEvents 1.0 envelope,
// signed and headed as Standard Webhooks asks (webhook-id, webhook-timestamp, webhook-signature),
// sent to each endpoint in feed order, one at a time, and retried on a growing schedule until the
// endpoint has failed for a day. The store keeps the position and the schedule (event-feed.ts), so
// a worker that stops mid-batch loses nothing: the next one sends the rest, with the same ids.
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  type SlotlockChange,
  type SlotlockChangeOrigin,
  type SlotlockEventFeed,
  slotlockServedChange,
} from './event-feed.js';
import { ignoreRejection } from './hooks.js';

/** The CloudEvents envelope a change is delivered and listed as. */
export interface SlotlockCloudEvent {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  /** Extension attribute: where the change came from (`mcp`, `rest`, `dashboard`, ...), when recorded. */
  slotlockorigin?: SlotlockChangeOrigin;
  /** Extension attribute: the id of the API key that made the change, when one did. */
  slotlockkeyid?: string;
  data: Record<string, unknown>;
}

/**
 * A change as CloudEvents 1.0 (structured mode): `type` is `io.pylota.slotlock.<change type>`, with
 * the extension attributes `slotlockorigin` and `slotlockkeyid` when the change records them. A
 * `coverage.*` change is redacted as the feed serves it (slotlockServedChange), whoever built it.
 */
export function slotlockCloudEvent(change: SlotlockChange): SlotlockCloudEvent {
  const served = slotlockServedChange(change.type, change.subject, change.data);
  return {
    specversion: '1.0',
    id: change.id,
    source: change.resourceId ? `/slotlock/resources/${change.resourceId}` : '/slotlock',
    type: `io.pylota.slotlock.${change.type}`,
    subject: served.subject,
    time: change.occurredAt.toISOString(),
    datacontenttype: 'application/json',
    ...(change.origin ? { slotlockorigin: change.origin } : {}),
    ...(change.keyId ? { slotlockkeyid: change.keyId } : {}),
    data: served.data,
  };
}

/**
 * The Standard Webhooks signature of one attempt: `v1,` and the base64 HMAC-SHA256, keyed by the
 * secret's bytes, of `id.timestamp.body`.
 */
export function signSlotlockWebhook(params: {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
}): string {
  if (!params.secret.startsWith('whsec_')) throw new TypeError('Slotlock webhook secret must start with whsec_');
  const key = Buffer.from(params.secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${params.id}.${params.timestamp}.${params.body}`)
    .digest('base64');
  return `v1,${signature}`;
}

/**
 * When to try a failed endpoint again, by how many attempts have failed in a row: the Standard
 * Webhooks example schedule (5 s, 5 min, 30 min, 2 h, 5 h, then 10 h), with ±10% jitter, and never
 * sooner than the endpoint's Retry-After (capped at a day).
 */
export function slotlockWebhookRetryDelayMs(
  attempts: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const schedule = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];
  const base = schedule[Math.min(Math.max(attempts, 1), schedule.length) - 1] as number;
  const jittered = Math.round(base * (0.9 + random() * 0.2));
  return Math.max(jittered, Math.min(retryAfterMs ?? 0, 86_400_000));
}

// One list per family: a BlockList also checks an IPv4 address against IPv6 rules through its
// mapped form, so ::ffff:0:0/96 in the same list would match every IPv4 address.
const PRIVATE_IPV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE_IPV4.addSubnet(address, prefix, 'ipv4');
}
const PRIVATE_IPV6 = new BlockList();
for (const [address, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE_IPV6.addSubnet(address, prefix, 'ipv6');
}

/** Whether `address` is one a webhook may not reach: loopback, private, link-local, and the like. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_IPV4.check(address, 'ipv4');
  if (family !== 6) return true;
  // An IPv4-mapped address (::ffff:a.b.c.d, or its hex form) is the IPv4 address it carries.
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (mapped) {
    if (mapped[1]) return PRIVATE_IPV4.check(mapped[1], 'ipv4');
    const high = Number.parseInt(mapped[2] as string, 16);
    const low = Number.parseInt(mapped[3] as string, 16);
    return PRIVATE_IPV4.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, 'ipv4');
  }
  return PRIVATE_IPV6.check(address, 'ipv6');
}

export interface SlotlockWebhookResponse {
  status: number;
  /** From the response's Retry-After, when it gave one in seconds. */
  retryAfterMs?: number;
}

export type SlotlockWebhookSender = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<SlotlockWebhookResponse>;

/**
 * POST with Node's http client: no redirect is followed, the answer's body is never read beyond
 * 64 KiB, and every address the host resolves to is checked when the socket connects, so a name
 * that resolves to a private network (or is rebound to one) is refused unless `allowPrivateNetworks`.
 */
export function createSlotlockWebhookSender(
  options: { timeoutMs?: number; allowPrivateNetworks?: boolean } = {},
): SlotlockWebhookSender {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const lookup = slotlockPrivateAddressLookup({
    allowPrivateNetworks: options.allowPrivateNetworks === true,
    code: 'webhook_private_address',
    what: 'webhook',
  });
  return (request) =>
    new Promise((resolve, reject) => {
      const url = new URL(request.url);
      if (!options.allowPrivateNetworks && namesPrivateAddress(url)) {
        reject(Object.assign(new Error('webhook URL names a private address'), { code: 'webhook_private_address' }));
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const outgoing = send(
        url,
        {
          method: 'POST',
          headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body)) },
          // An agent of its own, never the global one: with NODE_USE_ENV_PROXY a proxy from the
          // environment would connect for us, and the address check below would never run.
          agent: url.protocol === 'https:' ? new HttpsAgent({ lookup }) : new HttpAgent({ lookup } as never),
          lookup,
          timeout: timeoutMs,
        },
        (response) => {
          let read = 0;
          response.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > 65_536) response.destroy();
          });
          const finish = () => {
            const retryAfter = Number(response.headers['retry-after']);
            resolve({
              status: response.statusCode ?? 0,
              ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
            });
          };
          response.on('end', finish);
          response.on('close', finish);
        },
      );
      const timedOut = () =>
        outgoing.destroy(Object.assign(new Error('webhook request timed out'), { code: 'webhook_timeout' }));
      outgoing.on('timeout', timedOut);
      // `timeout` is idleness only: an answer dripped a byte at a time would hold the request
      // open for hours. The whole exchange has this long.
      const deadline = setTimeout(timedOut, timeoutMs);
      deadline.unref?.();
      outgoing.on('close', () => clearTimeout(deadline));
      outgoing.on('error', reject);
      outgoing.end(request.body);
    });
}

/** Whether a URL's host is an IP address literal that isPrivateAddress refuses. */
function namesPrivateAddress(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/**
 * A `dns.lookup` that answers every address a name resolves to, and refuses (an error with `code`)
 * a name with any private one unless `allowPrivateNetworks`. Given to a socket's connect, it checks
 * the addresses the connection will use, so a name rebound to a private address after an earlier
 * check is still refused. `resolve` stands in for `dns.lookup` (tests).
 */
export function slotlockPrivateAddressLookup(options: {
  allowPrivateNetworks: boolean;
  code: string;
  what: string;
  resolve?: typeof dnsLookup;
}): typeof dnsLookup {
  const resolve = options.resolve ?? dnsLookup;
  return ((hostname: string, lookupOptions: object, callback: Function) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as unknown as { address: string; family: number }[];
      if (!options.allowPrivateNetworks && list.some(({ address }) => isPrivateAddress(address))) {
        return callback(Object.assign(new Error(`${options.what} host ${hostname} resolves to a private address`), { code: options.code }));
      }
      const all = (lookupOptions as { all?: boolean }).all;
      if (all) return callback(null, list);
      const first = list[0];
      return first ? callback(null, first.address, first.family) : callback(new Error('no address'));
    });
  }) as unknown as typeof dnsLookup;
}

/**
 * A `fetch` for a server reaching a URL a tenant chose (the dashboard assistant's model): Node's
 * http client with the webhooks' address check. A URL naming a private address, or a host that
 * resolves to one when the socket connects, is refused with an error whose `code` is
 * `private_address`, unless `allowPrivateNetworks`. No redirect is followed (the answer is
 * returned as is) and no proxy from the environment is used. Takes a string body only.
 */
export function createSlotlockGuardedFetch(
  options: { allowPrivateNetworks?: boolean; resolve?: typeof dnsLookup } = {},
): typeof fetch {
  const allow = options.allowPrivateNetworks === true;
  const lookup = slotlockPrivateAddressLookup({
    allowPrivateNetworks: allow,
    code: 'private_address',
    what: 'requested',
    ...(options.resolve ? { resolve: options.resolve } : {}),
  });
  const refused = () =>
    Object.assign(new Error('the URL names a private address'), { code: 'private_address' });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('unsupported URL');
    if (!allow && namesPrivateAddress(url)) throw refused();
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          // An agent of its own: a proxy from the environment would skip the address check.
          agent: url.protocol === 'https:' ? new HttpsAgent({ lookup }) : new HttpAgent({ lookup } as never),
          lookup,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const answer = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
              answer.append(name, each);
            }
          }
          if (status < 200 || status > 599) {
            response.destroy();
            reject(new Error(`unexpected HTTP status ${status}`));
            return;
          }
          const stream =
            status === 204 || status === 304 ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          resolve(new Response(stream, { status, headers: answer }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }) as typeof fetch;
}

export interface SlotlockWebhookPassResult {
  /** Changes an endpoint accepted. */
  delivered: number;
  /** Endpoints whose next change failed, to be tried again later. */
  failed: number;
}

/**
 * One delivery pass for a tenant: claim each endpoint with changes due, send them in order until
 * one fails, and record how far each got. A 2xx is delivered; 410 disables the endpoint; anything
 * else, or no answer, is retried on the schedule. The send happens outside any transaction.
 */
export async function deliverSlotlockWebhooks(params: {
  feed: Pick<SlotlockEventFeed, 'claimWebhookDeliveries' | 'settleWebhookDelivery'>;
  tenantRef: string;
  send: SlotlockWebhookSender;
  batch?: number;
  leaseMs?: number;
  /** After this long (default 30,000 ms) no further change is sent this pass; the rest wait. */
  budgetMs?: number;
  now?: () => number;
}): Promise<SlotlockWebhookPassResult> {
  const now = params.now ?? Date.now;
  const claims = await params.feed.claimWebhookDeliveries({
    tenantRef: params.tenantRef,
    leaseMs: params.leaseMs ?? 60_000,
    batch: params.batch ?? 20,
  });
  let delivered = 0;
  let failed = 0;
  const stopAt = now() + (params.budgetMs ?? 30_000);
  await Promise.all(
    claims.map(async (claim) => {
      let last: string | undefined;
      let failure: { status: number | null; error: string; retryInMs: number; gone?: boolean } | undefined;
      // The failures before this pass set the delay: the schedule grows across passes.
      let attempts = claim.endpoint.attempts;
      for (const change of claim.changes) {
        if (now() >= stopAt) break;
        const body = JSON.stringify(slotlockCloudEvent(change));
        const timestamp = Math.floor(now() / 1_000);
        try {
          const response = await params.send({
            url: claim.endpoint.url,
            headers: {
              'Content-Type': 'application/cloudevents+json',
              'User-Agent': 'Slotlock-Webhooks/1',
              'webhook-id': change.id,
              'webhook-timestamp': String(timestamp),
              'webhook-signature': signSlotlockWebhook({
                secret: claim.endpoint.secret,
                id: change.id,
                timestamp,
                body,
              }),
            },
            body,
          });
          if (response.status >= 200 && response.status < 300) {
            last = change.position;
            delivered++;
            continue;
          }
          attempts = last ? 1 : attempts + 1;
          failure = {
            status: response.status,
            error: `HTTP ${response.status}`,
            retryInMs: slotlockWebhookRetryDelayMs(attempts, response.retryAfterMs),
            ...(response.status === 410 ? { gone: true } : {}),
          };
        } catch (error) {
          attempts = last ? 1 : attempts + 1;
          const code = (error as { code?: unknown }).code;
          failure = {
            status: null,
            error: typeof code === 'string' ? code : 'webhook_unreachable',
            retryInMs: slotlockWebhookRetryDelayMs(attempts),
          };
        }
        break;
      }
      if (failure) failed++;
      await params.feed.settleWebhookDelivery({
        tenantRef: params.tenantRef,
        endpointId: claim.endpoint.id,
        leaseToken: claim.leaseToken,
        ...(last ? { delivered: last } : {}),
        ...(failure ? { failure } : {}),
      });
    }),
  );
  return { delivered, failed };
}

export interface SlotlockWebhookScheduler {
  /** Deliver for this tenant too (a server calls it for each tenant it serves). */
  touch(tenantRef: string): void;
  close(): Promise<void>;
}

/**
 * Delivery passes every `intervalMs` (250-60,000, default 2,000) for the tenants `tenants()` lists
 * (the store's webhook_tenants(), say) and those touched, one tenant at a time. A pass that fails
 * is reported and the next one runs as usual.
 */
export function startSlotlockWebhookDelivery(options: {
  tenants: () => Promise<readonly string[]>;
  /** Tenants delivered at once (1-64, default 8), so one slow tenant's endpoints hold up none other. */
  concurrency?: number;
  deliver: (tenantRef: string) => Promise<SlotlockWebhookPassResult>;
  intervalMs?: number;
  onPass?: (tenantRef: string, result: SlotlockWebhookPassResult) => void;
  onError?: (error: unknown) => void;
}): SlotlockWebhookScheduler {
  const intervalMs = options.intervalMs ?? 2_000;
  if (!(Number.isSafeInteger(intervalMs) && intervalMs >= 250 && intervalMs <= 60_000)) {
    throw new RangeError('Slotlock webhook interval must be 250-60,000 ms');
  }
  const touched = new Set<string>();
  let closed = false;
  let running: Promise<void> | null = null;
  const concurrency = options.concurrency ?? 8;
  if (!(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 64)) {
    throw new RangeError('Slotlock webhook concurrency must be 1-64');
  }
  const pass = async () => {
    const queue = [...new Set([...(await options.tenants()), ...touched])];
    const worker = async () => {
      for (let tenantRef = queue.shift(); tenantRef !== undefined && !closed; tenantRef = queue.shift()) {
        try {
          const result = await options.deliver(tenantRef);
          if (result.delivered + result.failed > 0) options.onPass?.(tenantRef, result);
        } catch (error) {
          options.onError?.(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  };
  const timer = setInterval(() => {
    // A pass still running skips this tick rather than queue another behind it.
    if (running || closed) return;
    running = pass()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
    ignoreRejection(running);
  }, intervalMs);
  timer.unref?.();
  return {
    touch(tenantRef) {
      touched.add(tenantRef);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
