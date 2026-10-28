// Request limits for `slotlock serve`, a public multi-tenant server whose only rate limit this is:
// token buckets per client address (counted before any credential is looked up), per API key, per
// tenant and for the whole server, with reads and writes counted apart; one key lookup per request,
// answered busy rather than anonymous when the lookup queue is full; caps on writes that may expand
// a recurring series, and on maintenance runs, running at once; and counts of what was refused,
// logged with each client as a pseudonym. A process keeps its counts in memory, so each instance of
// a scaled-out server limits alone.
//
// Refusals carry Retry-After and the RateLimit and RateLimit-Policy fields of
// draft-ietf-httpapi-ratelimit-headers-11 (23 May 2026, read 2026-10-24): `"<policy>";r=<remaining>;
// t=<seconds>` and `"<policy>";q=<quota>;w=<window seconds>`, or `qu="concurrent-requests"` for a
// cap on requests at once. Retry-After is never earlier than the end of the effective window (§6).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE,
  type SlotlockAgentOperation,
  SlotlockAgentOperationError,
  type SlotlockAgentPrincipal,
  slotlockAgentOperationScope,
} from './agent-server.js';
import { slotlockBearerCredential } from './api-keys.js';
import { SLOTLOCK_APPLICATION_SCOPE, type SlotlockApplicationOperation } from './application-api.js';
import type { SlotlockLimits, SlotlockRate, SlotlockRateName } from './config.js';
import type { SlotlockNodeServerConnection, SlotlockNodeServerFetchTarget } from './node-server.js';
import { SLOTLOCK_APPLICATION_REST_ROUTES, matchSlotlockRestRoute } from './rest-api.js';

/** Keys one policy remembers; past this, the least recently used tenth is dropped at once. */
const MAX_BUCKET_KEYS = 100_000;
/** Series writes that may wait for the server's slot, and how long each may wait. */
const MAX_SERIES_WAITING = 64;
const MAX_SERIES_WAIT_MS = 2_000;
/** A tenant's series writes that may wait behind its running one. */
const MAX_TENANT_SERIES_WAITING = 4;
/** The longest a freed slot rests, however long the event loop was busy while its write held it. */
const MAX_SLOT_REST_MS = 1_000;
/** A key's use of the slots counts half as much after this long. */
const SLOT_USE_HALF_LIFE_MS = 10_000;
/**
 * Fields a proxy puts the client's address in: CF-Connecting-IP, True-Client-IP and X-Forwarded-For
 * (developers.cloudflare.com/fundamentals/reference/http-headers, read 2026-10-24), X-Real-IP, and
 * RFC 7239's Forwarded.
 */
const PROXY_CLIENT_FIELDS = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
];
/** How often the refusal counts are logged when there are any. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;
/** Clients named in one refusal log line, most refused first. */
const MAX_LOGGED_CLIENTS = 10;
/** Clients counted between two log lines; past this the rest are counted in the totals only. */
const MAX_COUNTED_CLIENTS = 1_000;

export type SlotlockRefusalReason =
  | 'auth_refused'
  | 'rate_limited'
  | 'lookup_overflow'
  | 'series_writes_busy'
  | 'maintenance_busy'
  | 'request_too_large';

/** One `refusals` log line: counts since the last one, and the most refused clients as pseudonyms. */
export interface SlotlockRefusalCounts extends Record<SlotlockRefusalReason, number> {
  window_seconds: number;
  /** Each client's address keyed by a per-process secret: comparable within one run, not reversible. */
  clients: { client: string; refusals: number }[];
}

export interface SlotlockRequestLimitsOptions {
  limits: SlotlockLimits;
  /** A lower-case request field a trusted proxy sets to the client address (config.ts). */
  trustedProxyHeader?: string;
  /** The public URL's path, without a trailing slash (`''` at the origin root). */
  basePath: string;
  /** Paths, under the base path, of the dashboard's sign-in and its callback, when it is served. */
  signInPaths?: readonly string[];
  /** Resolve a request's credential: an API key lookup or the server token. Called once a request. */
  authenticate(request: Request): Promise<SlotlockAgentPrincipal | null>;
  onRefusals?: (counts: SlotlockRefusalCounts) => void;
  /**
   * Called once, with the field's name, when a request carries a field a proxy puts the client's
   * address in while `trustedProxyHeader` is not set: every client behind that proxy is then
   * counted as the proxy's one address.
   */
  onIgnoredClientField?: (field: string) => void;
  /** Milliseconds, for tests; defaults to `performance.now`. */
  now?: () => number;
  /**
   * Budgets shared by every server (`SLOTLOCK_SHARED_LIMITS`): after this process's own buckets
   * pass, each tenant budget (`tenant_*`, `app_*`) also takes a token from `take`, so N servers
   * allow a tenant its rate once, not N times. `take` failing (the database away) lets the request
   * through on this process's buckets alone, which still apply.
   */
  shared?: { take(bucket: string, rate: SlotlockRate): Promise<boolean> };
}

export interface SlotlockRequestLimits {
  /** The agent server's `authenticate`: the request's lookup from `fetch`, else a lookup now. */
  authenticate(request: Request): Promise<SlotlockAgentPrincipal | null>;
  /** The agent server's `consumeRateLimit`: the key, tenant and server buckets of the request. */
  consumeRateLimit(args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation | 'protocol';
  }): Promise<boolean>;
  /**
   * For `authorize`: when the operation may expand a recurring series, or runs maintenance, take its
   * write token and wait for a slot, holding it until the request is answered. Throws a
   * `SlotlockAgentOperationError` when none comes: `rate_limited` (429) when the write is over its
   * budget or the tenant's own writes fill its slots, `server_busy` (503) while the server's do.
   */
  admit(args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation | SlotlockApplicationOperation;
    input: Record<string, unknown>;
  }): Promise<void>;
  /** Put the limits in front of `target`: the listener's fetch target. */
  serve(target: SlotlockNodeServerFetchTarget): SlotlockNodeServerFetchTarget;
  /** The client address a request reaching `serve`'s target was counted as (the dashboard's). */
  clientAddress(request: Request): string | undefined;
  /** Log what is still counted and stop the timer. */
  close(): void;
}

type Route = 'mcp' | 'a2a' | 'rest' | 'sign_in' | 'health' | 'other';

interface Policy {
  name: string;
  rate: SlotlockRate;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** What a request's limits found, for its answer's fields. */
interface Verdict {
  policy: Policy;
  remaining: number;
  /** Seconds until the next token (a refusal) or until the bucket is full again (an answer). */
  seconds: number;
}

/** The limits state of one request, from `fetch` to its answer. */
interface RequestState {
  route: Route;
  address: string;
  /** A REST method other than GET or HEAD. */
  write: boolean;
  /** A route of the application API, counted in its tenant's `app_*` buckets. */
  application: boolean;
  /** Aborted when the client goes, which ends a wait for a slot. */
  signal: AbortSignal;
  charged: { read: boolean; write: boolean };
  refusal?: { reason: SlotlockRefusalReason; fields: Record<string, string> };
  tightest?: Verdict;
  release: Array<() => void>;
}

/** The IPv6 /64 of an address, which one client is generally assigned whole; null if not IPv6. */
function ipv6Prefix(address: string): string | null {
  let text = address.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const before = head === '' ? [] : head.split(':');
  const after = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups =
    rest === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  // An IPv4 client of a dual-stack listener: ::ffff:a.b.c.d.
  if (numbers.slice(0, 5).every((group) => group === 0) && numbers[5] === 0xffff) {
    const [high = 0, low = 0] = numbers.slice(6);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${numbers.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** The bucket key of an address: an IPv4 address itself, an IPv6 address's /64; null if neither. */
export function slotlockClientKey(value: string): string | null {
  const address = value.trim().replace(/^\[(.*)\]$/, '$1');
  const kind = isIP(address);
  if (kind === 4) return address;
  if (kind === 6) return ipv6Prefix(address);
  return null;
}

/**
 * The network a client key (slotlockClientKey) signs in from: an IPv6 /64's /48, any other key
 * itself. A site is generally given a /48 or a /56 (RFC 6177) and may use each /64 in it, so a
 * budget per /64 would let one site sign in as thousands of clients and use up a ceiling every
 * client shares; per /48, a site counts as one, as a site behind one IPv4 address does.
 */
export function slotlockClientNetwork(key: string): string {
  const prefix = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(key);
  return prefix ? `${prefix[1]}::/48` : key;
}

/** The client a request is counted as: the trusted field's last address, else the connection's. */
function clientOf(
  request: Request,
  connection: SlotlockNodeServerConnection | undefined,
  trustedField: string | undefined,
): string {
  if (trustedField !== undefined) {
    // A proxy appends to a list field (X-Forwarded-For), so the last entry is the one it wrote.
    const claimed = request.headers.get(trustedField)?.split(',').at(-1);
    const key = claimed === undefined ? null : slotlockClientKey(claimed);
    if (key !== null) return key;
  }
  return slotlockClientKey(connection?.remoteAddress ?? '') ?? 'unknown';
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * A refusal made before the request reaches the agent server, in the shape its protocol answers
 * one: JSON-RPC on /mcp (-32029 to a 2025 client, SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE to a
 * 2026-07-28 one), a JSON-RPC error in a 200 envelope with a `google.rpc.ErrorInfo` on /a2a for a
 * rate limit (A2A §9.5), as the agent server answers its own, and openapi.json's Error elsewhere.
 */
function refusal(
  request: Request,
  route: Route,
  status: 429 | 503,
  fields: Record<string, string>,
): Response {
  const code = status === 429 ? 'rate_limited' : 'server_busy';
  const message = status === 429 ? 'Rate limit exceeded' : 'Server is busy';
  if (route === 'mcp') {
    const modern = request.headers.get('mcp-protocol-version') === SLOTLOCK_MCP_PROTOCOL_VERSION;
    const rpcCode =
      status === 503 ? -32603 : modern ? SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE : -32029;
    return json(status, { jsonrpc: '2.0', id: null, error: { code: rpcCode, message } }, fields);
  }
  if (route === 'a2a') {
    return json(
      status === 429 ? 200 : 503,
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: status === 429 ? -32029 : -32603,
          message,
          data: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: status === 429 ? 'RATE_LIMITED' : 'SERVER_BUSY',
              domain: 'slotlock',
            },
          ],
        },
      },
      fields,
    );
  }
  if (route === 'sign_in') {
    return new Response('Too many sign-ins from your network. Try again in a minute.', {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...fields },
    });
  }
  return json(status, { error: { code } }, fields);
}

/** Retry-After and the RateLimit fields for a verdict. */
function fieldsOf(verdict: Verdict, refused: boolean): Record<string, string> {
  const { name, rate } = verdict.policy;
  const window = Math.max(1, Math.ceil(rate.burst / rate.perSecond));
  const seconds = Math.max(refused ? 1 : 0, Math.ceil(verdict.seconds));
  return {
    ...(refused ? { 'Retry-After': String(seconds) } : {}),
    RateLimit: `"${name}";r=${Math.max(0, Math.floor(verdict.remaining))};t=${seconds}`,
    'RateLimit-Policy': `"${name}";q=${rate.burst};w=${window}`,
  };
}

/** Fields for a refusal by a cap on requests at once. */
function concurrencyFields(name: string, cap: number): Record<string, string> {
  return {
    'Retry-After': '1',
    RateLimit: `"${name}";r=0`,
    'RateLimit-Policy': `"${name}";q=${cap};qu="concurrent-requests"`,
  };
}

/** Token buckets of one policy, one per key, refilled lazily. */
function bucketsFor(rate: SlotlockRate, now: () => number) {
  const buckets = new Map<string, Bucket>();
  const refill = (bucket: Bucket, at: number): void => {
    bucket.tokens = Math.min(rate.burst, bucket.tokens + ((at - bucket.at) / 1_000) * rate.perSecond);
    bucket.at = at;
  };
  return {
    /** The key's bucket, refilled to `at` and moved to the most recently used end. */
    get(key: string, at: number): Bucket {
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key);
        refill(bucket, at);
      } else {
        bucket = { tokens: rate.burst, at };
        if (buckets.size >= MAX_BUCKET_KEYS) {
          // A tenth at a time, so a flood from ever new addresses costs one sweep per 10,000 of
          // them rather than one per request. A dropped key starts afresh with a full bucket.
          let dropping = MAX_BUCKET_KEYS / 10;
          for (const stale of buckets.keys()) {
            if (dropping === 0) break;
            buckets.delete(stale);
            dropping -= 1;
          }
        }
      }
      buckets.set(key, bucket);
      return bucket;
    },
  };
}

/**
 * One token bucket per key at `rate`, kept in this process like serve's own: `take` spends a token
 * of the key's bucket and is false, spending nothing, when it has less than one. The dashboard
 * assistant limits each member's messages with it.
 */
export function createSlotlockRateLimiter(
  rate: SlotlockRate,
  now: () => number = () => performance.now(),
): { take(key: string): boolean } {
  if (!(rate.perSecond > 0) || !(rate.burst >= 1)) {
    throw new Error('Slotlock rate limiter needs a positive rate and a burst of at least 1');
  }
  const buckets = bucketsFor(rate, now);
  return {
    take(key) {
      const bucket = buckets.get(key, now());
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

/**
 * Slots, at most `perKey` running for a key and `total` in all, shared between keys by how much
 * each asks for. A key's use is how long the event loop was busy while its writes held a slot,
 * halving every SLOT_USE_HALF_LIFE_MS. A freed slot goes to the waiter whose key has the fewest
 * writes in flight (running and waiting), then to the one whose key has used the slots least, then
 * to the first come. So a key sending one write at a time goes ahead of keys keeping several in
 * flight, and of keys with one each whose writes kept the loop busier; keys with one each and less
 * use, a new key included, each go ahead of it once, so its wait grows with how many there are.
 * When the queue is full, a key with fewer writes in flight than the key with the most takes the
 * place of that key's last waiter, so keys that each stay within their own cap cannot together
 * turn every other key away. A freed slot first rests for as long as the event loop was busy
 * while its write held it (up to MAX_SLOT_REST_MS): a request that needs a few turns of the loop
 * before it is answered (another tenant's read, or its write on its way to a slot) has them in
 * the rest, so writes that each hold the loop for under MAX_SLOT_REST_MS hold at most about half
 * of it.
 */
function seriesGate(perKey: number, total: number) {
  let running = 0;
  const byKey = new Map<string, number>();
  const waiting: Array<{ key: string; start(): void; give(): void }> = [];
  const add = (key: string, delta: number) => {
    const count = (byKey.get(key) ?? 0) + delta;
    if (count === 0) byKey.delete(key);
    else byKey.set(key, count);
  };
  const runningFor = new Map<string, number>();
  /** Each key's use as of `at`, in milliseconds; least recently changed first. */
  const used = new Map<string, { ms: number; at: number }>();
  const useOf = (key: string, at: number) => {
    const entry = used.get(key);
    return entry ? entry.ms * 0.5 ** ((at - entry.at) / SLOT_USE_HALF_LIFE_MS) : 0;
  };
  /** Whether a hand-over is due on a later turn: one at a time, so slots never go out in a run. */
  let handing = false;
  const release = (key: string, busyMs: number) => {
    const at = performance.now();
    const ms = useOf(key, at) + busyMs;
    used.delete(key);
    used.set(key, { ms, at });
    // Forgetting the key whose use changed longest ago forgets the use that has had longest to
    // fade.
    if (used.size > MAX_BUCKET_KEYS) used.delete(used.keys().next().value as string);
    const count = (runningFor.get(key) ?? 1) - 1;
    if (count === 0) runningFor.delete(key);
    else runningFor.set(key, count);
    add(key, -1);
    const rest = Math.min(MAX_SLOT_REST_MS, Math.floor(busyMs));
    if (rest > 0) {
      const timer = setTimeout(() => {
        running -= 1;
        next();
      }, rest);
      timer.unref?.();
      return;
    }
    running -= 1;
    // Even after a write that hardly held the loop, the slot goes over on a later turn of it, so
    // the requests waiting on I/O are served first.
    if (handing) return;
    handing = true;
    setImmediate(() => {
      handing = false;
      next();
    });
  };
  const next = () => {
    const at = performance.now();
    while (running < total) {
      let index = -1;
      let best: { inFlight: number; use: number } | undefined;
      for (const [position, { key }] of waiting.entries()) {
        if ((runningFor.get(key) ?? 0) >= perKey) continue;
        const rank = { inFlight: byKey.get(key) ?? 0, use: useOf(key, at) };
        if (
          !best ||
          rank.inFlight < best.inFlight ||
          (rank.inFlight === best.inFlight && rank.use < best.use)
        ) {
          best = rank;
          index = position;
        }
      }
      if (index === -1) return;
      const [chosen] = waiting.splice(index, 1);
      chosen?.start();
    }
  };
  return {
    /**
     * A release function once a slot is the caller's; `tenant` when the key already has as many
     * running and waiting as it may, `server` when the server's queue is full or the wait ran out.
     */
    acquire(key: string, signal: AbortSignal): Promise<(() => void) | 'tenant' | 'server'> {
      if ((byKey.get(key) ?? 0) >= perKey + MAX_TENANT_SERIES_WAITING) {
        return Promise.resolve('tenant');
      }
      const start = (): (() => void) => {
        running += 1;
        runningFor.set(key, (runningFor.get(key) ?? 0) + 1);
        // Node's performance.eventLoopUtilization(earlier).active is the time since `earlier` the
        // loop spent outside its event provider, where it waits for I/O (nodejs.org/api/
        // perf_hooks.html, read 2026-10-25): a synchronous expansion counts in full, the wait for
        // a query's answer only for the other work the loop runs meanwhile.
        const loop = performance.eventLoopUtilization();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          release(key, performance.eventLoopUtilization(loop).active);
        };
      };
      // Straight in when there is room, unless a waiter could use it: that one goes first.
      const room = (candidate: string) => (runningFor.get(candidate) ?? 0) < perKey;
      if (running < total && room(key) && !waiting.some((entry) => room(entry.key))) {
        add(key, 1);
        return Promise.resolve(start());
      }
      if (signal.aborted) return Promise.resolve('server');
      if (waiting.length >= MAX_SERIES_WAITING) {
        // A full queue makes room for a key with fewer writes in flight than another waiter's: the
        // last to come of the key with the most gives up its place. Otherwise many keys, each
        // within its own cap, could fill the queue and turn every other key away.
        const mine = (byKey.get(key) ?? 0) + 1;
        let most = mine;
        let displaced: (typeof waiting)[number] | undefined;
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          const entry = waiting[index] as (typeof waiting)[number];
          const theirs = byKey.get(entry.key) ?? 0;
          if (theirs > most) {
            most = theirs;
            displaced = entry;
          }
        }
        if (!displaced) return Promise.resolve('server');
        displaced.give();
      }
      add(key, 1);
      return new Promise((resolve) => {
        const entry = {
          key,
          give: () => give(),
          start: () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', give);
            resolve(start());
          },
        };
        const give = () => {
          const index = waiting.indexOf(entry);
          if (index === -1) return;
          waiting.splice(index, 1);
          clearTimeout(timer);
          signal.removeEventListener('abort', give);
          add(key, -1);
          resolve((runningFor.get(key) ?? 0) >= perKey ? 'tenant' : 'server');
        };
        const timer = setTimeout(give, MAX_SERIES_WAIT_MS);
        timer.unref?.();
        signal.addEventListener('abort', give, { once: true });
        waiting.push(entry);
      });
    },
  };
}

/**
 * The slots an operation waits for: `series` for a write that may expand a recurring series (a
 * recurring create, an update), `maintenance` for a maintenance run, which rolls many series and so
 * has slots of its own rather than holding every other tenant's writes; null for the rest.
 */
function slotsFor(
  operation: SlotlockAgentOperation | SlotlockApplicationOperation,
  input: Record<string, unknown>,
): 'series' | 'maintenance' | null {
  if (operation === 'slotlock_run_maintenance') return 'maintenance';
  if (operation === 'slotlock_create_event') {
    return input.recurrence_rule !== undefined && input.recurrence_rule !== null ? 'series' : null;
  }
  return operation === 'slotlock_update_event' ? 'series' : null;
}

/** The limits `slotlock serve` puts in front of its agent server and dashboard. */
export function createSlotlockRequestLimits(
  options: SlotlockRequestLimitsOptions,
): SlotlockRequestLimits {
  const now = options.now ?? (() => performance.now());
  const { rates, caps } = options.limits;
  const policies = new Map<SlotlockRateName, { policy: Policy; buckets: ReturnType<typeof bucketsFor> }>();
  for (const [name, rate] of Object.entries(rates) as [SlotlockRateName, SlotlockRate | null][]) {
    if (rate !== null) policies.set(name, { policy: { name, rate }, buckets: bucketsFor(rate, now) });
  }
  const states = new AsyncLocalStorage<RequestState>();
  const looked = new WeakMap<Request, SlotlockAgentPrincipal | null>();
  const addresses = new WeakMap<Request, string>();
  const gates = {
    series: {
      gate: seriesGate(caps.tenant_series_writes, caps.series_writes),
      tenant: { name: 'tenant_series_writes', cap: caps.tenant_series_writes },
      server: { name: 'series_writes', cap: caps.series_writes },
      busy: 'series_writes_busy',
    },
    // One a tenant: a second would roll the same series again.
    maintenance: {
      gate: seriesGate(1, caps.maintenance_runs),
      tenant: { name: 'tenant_maintenance_runs', cap: 1 },
      server: { name: 'maintenance_runs', cap: caps.maintenance_runs },
      busy: 'maintenance_busy',
    },
  } as const;
  const signInPaths = new Set(options.signInPaths ?? []);
  let fieldIgnored = false;

  // Refusal counts, logged with each client keyed by a secret this process alone holds.
  const pseudonymKey = randomBytes(32);
  const pseudonym = (address: string) =>
    createHmac('sha256', pseudonymKey).update(address).digest('hex').slice(0, 16);
  let counted = emptyCounts();
  let countedSince = now();
  let clients = new Map<string, number>();
  function emptyCounts(): Record<SlotlockRefusalReason, number> {
    return {
      auth_refused: 0,
      rate_limited: 0,
      lookup_overflow: 0,
      series_writes_busy: 0,
      maintenance_busy: 0,
      request_too_large: 0,
    };
  }
  const count = (reason: SlotlockRefusalReason, address: string) => {
    counted[reason] += 1;
    const client = pseudonym(address);
    if (clients.has(client) || clients.size < MAX_COUNTED_CLIENTS) {
      clients.set(client, (clients.get(client) ?? 0) + 1);
    }
  };
  const flush = () => {
    const total = Object.values(counted).reduce((sum, value) => sum + value, 0);
    const at = now();
    if (total > 0) {
      const line: SlotlockRefusalCounts = {
        window_seconds: Math.round((at - countedSince) / 1_000),
        ...counted,
        clients: [...clients]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_LOGGED_CLIENTS)
          .map(([client, refusals]) => ({ client, refusals })),
      };
      try {
        options.onRefusals?.(line);
      } catch {
        // Observability must never change an answer.
      }
    }
    counted = emptyCounts();
    clients = new Map();
    countedSince = at;
  };
  const timer = setInterval(flush, REFUSAL_LOG_INTERVAL_MS);
  timer.unref?.();

  /**
   * Take a token from every bucket named, or from none: one with less than a token refuses the
   * request, and the one that frees soonest is not the answer, the one that frees last is.
   */
  function charge(checks: Array<{ name: SlotlockRateName; key: string }>): {
    ok: boolean;
    verdict?: Verdict;
  } {
    const at = now();
    const found = checks.flatMap(({ name, key }) => {
      const entry = policies.get(name);
      return entry ? [{ policy: entry.policy, bucket: entry.buckets.get(key, at) }] : [];
    });
    if (found.length === 0) return { ok: true };
    const short = found.filter(({ bucket }) => bucket.tokens < 1);
    if (short.length > 0) {
      const waits = short.map(({ policy, bucket }) => ({
        policy,
        remaining: 0,
        seconds: (1 - bucket.tokens) / policy.rate.perSecond,
      }));
      waits.sort((a, b) => b.seconds - a.seconds);
      return { ok: false, verdict: waits[0] as Verdict };
    }
    let tightest: Verdict | undefined;
    for (const { policy, bucket } of found) {
      bucket.tokens -= 1;
      const verdict = {
        policy,
        remaining: bucket.tokens,
        seconds: (policy.rate.burst - bucket.tokens) / policy.rate.perSecond,
      };
      if (!tightest || verdict.remaining < tightest.remaining) tightest = verdict;
    }
    return tightest ? { ok: true, verdict: tightest } : { ok: true };
  }

  /**
   * Take the read or write tokens a request has not yet been charged: from its key and tenant, or
   * its tenant's application buckets when it may use the application API (an embedder's principal
   * with no scopes, or one with the admin scope), and from the server's. A key that may not is
   * charged its own buckets, so its refused application calls cannot spend the application's.
   * False, with the refusal recorded, when one is short.
   */
  async function chargeRequest(
    state: RequestState,
    principal: SlotlockAgentPrincipal,
    classes: Array<'read' | 'write'>,
  ): Promise<boolean> {
    const due = classes.filter((kind) => !state.charged[kind]);
    if (due.length === 0) return true;
    const keyOf = `${principal.tenantRef}\0${principal.subject}`;
    const application =
      state.application &&
      (principal.scopes === undefined || principal.scopes.includes(SLOTLOCK_APPLICATION_SCOPE));
    const checks = due.flatMap((kind) => [
      ...(application
        ? [{ name: `app_${kind}` as SlotlockRateName, key: principal.tenantRef }]
        : [
            { name: `key_${kind}` as SlotlockRateName, key: keyOf },
            { name: `tenant_${kind}` as SlotlockRateName, key: principal.tenantRef },
          ]),
      { name: `global_${kind}` as SlotlockRateName, key: '' },
    ]);
    const outcome = charge(checks);
    if (!outcome.ok) {
      state.refusal = {
        reason: 'rate_limited',
        fields: fieldsOf(outcome.verdict as Verdict, true),
      };
      return false;
    }
    if (options.shared) {
      for (const check of checks) {
        if (!check.name.startsWith('tenant_') && !check.name.startsWith('app_')) continue;
        const policy = policies.get(check.name)?.policy;
        if (!policy) continue;
        let allowed = true;
        try {
          allowed = await options.shared.take(`${check.name}\0${check.key}`, policy.rate);
        } catch {
          // The shared budget is out of reach: this process's own buckets decided.
        }
        if (!allowed) {
          state.refusal = {
            reason: 'rate_limited',
            fields: fieldsOf({ policy, remaining: 0, seconds: Math.max(1, Math.ceil(1 / policy.rate.perSecond)) }, true),
          };
          return false;
        }
      }
    }
    for (const kind of due) state.charged[kind] = true;
    if (outcome.verdict) state.tightest = outcome.verdict;
    return true;
  }

  function routeOf(request: Request): Route {
    const pathname = new URL(request.url).pathname;
    const base = options.basePath;
    if (base !== '' && pathname !== base && !pathname.startsWith(`${base}/`)) return 'other';
    const path = pathname.slice(base.length) || '/';
    if (path === '/mcp') return 'mcp';
    if (path === '/a2a') return 'a2a';
    if (path === '/healthz' && request.method === 'GET') return 'health';
    if (path.startsWith('/v1/') || path === '/openapi.json') return 'rest';
    // The dashboard routes one trailing slash as the path without it.
    if (signInPaths.has(path.replace(/(.)\/$/, '$1'))) return 'sign_in';
    return 'other';
  }

  /** Whether a REST request is to a route of the application API rather than an agent tool. */
  function isApplicationRoute(request: Request): boolean {
    const path = new URL(request.url).pathname.slice(options.basePath.length);
    const match = matchSlotlockRestRoute(request.method, path, SLOTLOCK_APPLICATION_REST_ROUTES);
    return match !== null && 'route' in match;
  }

  return {
    async authenticate(request) {
      if (looked.has(request)) return looked.get(request) ?? null;
      return options.authenticate(request);
    },

    async consumeRateLimit({ principal, operation }) {
      const state = states.getStore();
      if (!state) return true;
      const classes: Array<'read' | 'write'> = [];
      if (operation === 'protocol') {
        classes.push('read');
        if (state.write) classes.push('write');
      } else if (slotlockAgentOperationScope(operation) === 'write') {
        classes.push('write');
      }
      return chargeRequest(state, principal, classes);
    },

    async admit({ principal, operation, input }) {
      const state = states.getStore();
      const kind = state ? slotsFor(operation, input) : null;
      if (!state || kind === null) return;
      // One slot a request: the confirmation round or a retry within it holds the same one.
      if (state.release.length > 0) return;
      // Each operation that waits here writes. Its token is taken now rather than after authorize,
      // where consumeRateLimit would take it (on /mcp and /a2a a request is charged a read token
      // only): a write over its budget is refused at once, not after holding a place in the queue
      // for a slot it could not use.
      if (!(await chargeRequest(state, principal, ['write']))) {
        throw new SlotlockAgentOperationError('rate_limited', 429);
      }
      const slots = gates[kind];
      const slot = await slots.gate.acquire(principal.tenantRef, state.signal);
      if (typeof slot === 'function') {
        state.release.push(slot);
        return;
      }
      if (slot === 'tenant') {
        state.refusal = {
          reason: 'rate_limited',
          fields: concurrencyFields(slots.tenant.name, slots.tenant.cap),
        };
        throw new SlotlockAgentOperationError('rate_limited', 429);
      }
      state.refusal = {
        reason: slots.busy,
        fields: concurrencyFields(slots.server.name, slots.server.cap),
      };
      throw new SlotlockAgentOperationError('server_busy', 503);
    },

    serve(target) {
      const limited: SlotlockNodeServerFetchTarget = {
        async fetch(request, connection) {
          const route = routeOf(request);
          const address = clientOf(request, connection, options.trustedProxyHeader);
          addresses.set(request, address);
          if (options.trustedProxyHeader === undefined && !fieldIgnored) {
            const field = PROXY_CLIENT_FIELDS.find((name) => request.headers.has(name));
            if (field !== undefined) {
              fieldIgnored = true;
              try {
                options.onIgnoredClientField?.(field);
              } catch {
                // Observability must never change an answer.
              }
            }
          }
          // Before anything is looked up: every request from the address, and its sign-ins from
          // its network, as the dashboard Worker counts them. Not the health check, which a proxy
          // in front asks from the address its requests share, and which reuses one database
          // check a second.
          const before = charge([
            ...(route === 'health' ? [] : [{ name: 'address' as const, key: address }]),
            ...(route === 'sign_in'
              ? [{ name: 'sign_in' as const, key: slotlockClientNetwork(address) }]
              : []),
          ]);
          if (!before.ok) {
            count('rate_limited', address);
            return refusal(request, route, 429, fieldsOf(before.verdict as Verdict, true));
          }
          const state: RequestState = {
            route,
            address,
            write: route === 'rest' && request.method !== 'GET' && request.method !== 'HEAD',
            application: route === 'rest' && isApplicationRoute(request),
            signal: request.signal,
            charged: { read: false, write: false },
            release: [],
          };
          if (
            (route === 'mcp' || route === 'a2a' || route === 'rest') &&
            slotlockBearerCredential(request) !== undefined
          ) {
            // One lookup a request, made here so a full queue answers busy instead of anonymous.
            try {
              looked.set(request, await options.authenticate(request));
            } catch (error) {
              if (!(error instanceof SlotlockAgentOperationError) || error.status !== 503) throw error;
              count('lookup_overflow', address);
              return refusal(request, route, 503, { 'Retry-After': '1' });
            }
          }
          let response: Response;
          try {
            response = await states.run(state, () => target.fetch(request, connection));
          } finally {
            for (const release of state.release.splice(0)) release();
          }
          if (response.status === 401) count('auth_refused', address);
          if (response.status === 413) count('request_too_large', address);
          if (state.refusal) count(state.refusal.reason, address);
          const fields =
            state.refusal?.fields ??
            (state.tightest && (route === 'mcp' || route === 'a2a' || route === 'rest')
              ? fieldsOf(state.tightest, false)
              : undefined);
          if (!fields) return response;
          // A response's own headers may be immutable (Response.redirect): answer with a copy.
          const headers = new Headers(response.headers);
          for (const [name, value] of Object.entries(fields)) headers.set(name, value);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      };
      if (target.shutdown) limited.shutdown = () => target.shutdown?.();
      return limited;
    },

    clientAddress(request) {
      return addresses.get(request);
    },

    close() {
      clearInterval(timer);
      flush();
    },
  };
}
