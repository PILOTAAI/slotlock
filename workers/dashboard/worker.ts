// The dashboard (src/dashboard.ts) as a Cloudflare Worker: GitHub sign-in, and the API keys and
// resources of each person's tenant, served from its own origin (SLOTLOCK_PUBLIC_URL) while the
// server agents use runs elsewhere (SLOTLOCK_SERVICE_URL). It reaches Postgres through Hyperdrive
// with caching off: a sign-in, a sent form and a sign-out are recorded and read back at once.
//
// A Worker may not use a database client from another request, so each request opens its own
// (Hyperdrive keeps the connections). The dashboard is built once per isolate, like one
// `slotlock serve` process, and reaches the request's client through AsyncLocalStorage, so its
// limit on sign-ins in flight holds across the requests that isolate serves. Workers run many
// isolates, so three rate limiting bindings bound the requests of all of them together.
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { type SlotlockApiKeyStore, createSlotlockApiKeyStore } from '../../src/api-keys.js';
import {
  SlotlockConfigError,
  type SlotlockEnv,
  readAvailability,
  readDashboardConfig,
  readServerUrl,
} from '../../src/config.js';
import {
  type SlotlockDashboard,
  type SlotlockDashboardResources,
  type SlotlockDashboardState,
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../../src/dashboard.js';
import { slotlockClientKey, slotlockClientNetwork } from '../../src/rate-limit.js';
import { createSlotlockStore } from '../../src/store.js';

/**
 * A Workers rate limiting binding (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit,
 * read 2026-10-18). Its counts are per Cloudflare location and eventually consistent: it bounds a
 * flood, it is not an exact quota.
 */
export interface SlotlockRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** What wrangler.jsonc and `wrangler secret put` give the Worker. */
export interface SlotlockDashboardWorkerEnv {
  HYPERDRIVE: { connectionString: string };
  /** Every dashboard request, counted per client (see clientOf). */
  SLOTLOCK_CLIENT_RATE_LIMIT?: SlotlockRateLimit;
  /** GitHub sign-ins and their callbacks, counted per client network (slotlockClientNetwork). */
  SLOTLOCK_SIGN_IN_RATE_LIMIT?: SlotlockRateLimit;
  /**
   * GitHub sign-ins and their callbacks, counted for every client together: a ceiling well above one
   * client's limit, so a few clients cannot use it up for everyone. Without it, a configuration
   * from before it existed, SLOTLOCK_SIGN_IN_RATE_LIMIT counts every client together instead, as it
   * did then, and the Worker logs a warning.
   */
  SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT?: SlotlockRateLimit;
  [name: string]: unknown;
}

/** The part of a Worker's ExecutionContext the dashboard uses. */
export interface SlotlockDashboardWorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SlotlockDashboardWorkerOptions {
  /** Reaches GitHub; a test passes a fake. */
  fetch?: typeof fetch;
}

interface RequestScope {
  keys: SlotlockApiKeyStore;
  resources: SlotlockDashboardResources;
  state: SlotlockDashboardState;
}

/** Connections one request may hold: a Worker may have six open at once. */
const MAX_CONNECTIONS = 5;

/** An object whose every method is that of the current request's own. */
function perRequest<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = current();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The client a request is counted as: CF-Connecting-IP, which Cloudflare sets itself, keyed as
 * `slotlock serve` keys an address, so an IPv6 client is its whole /64 and rotating the rest of its
 * address buys it no new budget. Undefined without a valid address.
 */
function clientOf(request: Request): string | undefined {
  return slotlockClientKey(request.headers.get('cf-connecting-ip') ?? '') ?? undefined;
}

function isRateLimit(value: unknown): value is SlotlockRateLimit {
  return typeof (value as SlotlockRateLimit | undefined)?.limit === 'function';
}

function tooManyRequests(): Response {
  return new Response('Too many requests. Try again in a minute.', {
    status: 429,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
  });
}

/** The Worker's variables and secrets, the text ones only, as the configuration readers take them. */
function variables(env: SlotlockDashboardWorkerEnv): SlotlockEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function createSlotlockDashboardWorker(options: SlotlockDashboardWorkerOptions = {}) {
  const scope = new AsyncLocalStorage<RequestScope>();
  const current = () => {
    const found = scope.getStore();
    if (!found) throw new Error('The Slotlock dashboard was used outside a request');
    return found;
  };
  let built:
    | {
        dashboard: SlotlockDashboard;
        root: string;
        signInPaths: Set<string>;
        limits: {
          client: SlotlockRateLimit;
          signIn: SlotlockRateLimit;
          signInCeiling: SlotlockRateLimit | null;
        };
      }
    | undefined;

  function build(env: SlotlockDashboardWorkerEnv) {
    // A sign-in costs a database write and a request to GitHub under the app's client secret, and
    // anyone may start one, while the limit on sign-ins in flight is one isolate's and Workers run
    // many: without these bindings nothing bounds them all together, so the Worker does not serve.
    const client = env.SLOTLOCK_CLIENT_RATE_LIMIT;
    const signIn = env.SLOTLOCK_SIGN_IN_RATE_LIMIT;
    const ceiling = env.SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT;
    if (!isRateLimit(client) || !isRateLimit(signIn)) {
      throw new SlotlockConfigError(
        'the SLOTLOCK_CLIENT_RATE_LIMIT and SLOTLOCK_SIGN_IN_RATE_LIMIT rate limiting bindings are required',
      );
    }
    const signInCeiling = isRateLimit(ceiling) ? ceiling : null;
    if (!signInCeiling) {
      console.warn(
        JSON.stringify({
          message:
            'slotlock dashboard sign-ins share one budget for every client: add the SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT rate limiting binding to limit them per client',
        }),
      );
    }
    const vars = variables(env);
    const publicUrl = readServerUrl(vars, 'SLOTLOCK_PUBLIC_URL');
    const serviceUrl = readServerUrl(vars, 'SLOTLOCK_SERVICE_URL');
    const config = readDashboardConfig(vars);
    if (config === undefined) {
      throw new SlotlockConfigError(
        'SLOTLOCK_GITHUB_CLIENT_ID, SLOTLOCK_GITHUB_CLIENT_SECRET, SLOTLOCK_SESSION_SECRET and SLOTLOCK_DASHBOARD_USERS are required',
      );
    }
    if (typeof env.HYPERDRIVE?.connectionString !== 'string') {
      throw new SlotlockConfigError('the HYPERDRIVE binding is required');
    }
    const dashboard = createSlotlockDashboard({
      publicUrl,
      serviceUrl,
      github: { clientId: config.githubClientId, clientSecret: config.githubClientSecret },
      sessionSecret: config.sessionSecret,
      allowedUsers: config.allowedUsers,
      ...(config.organizations ? { organizations: config.organizations } : {}),
      availability: readAvailability(vars),
      // Cloudflare sets CF-Connecting-IP itself, so one client's sign-ins in flight are capped.
      clientAddress: clientOf,
      keys: perRequest(() => current().keys),
      resources: perRequest(() => current().resources),
      state: perRequest(() => current().state),
      onError: (error) =>
        console.error(
          JSON.stringify({
            message: 'slotlock dashboard request failed',
            error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
          }),
        ),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const root = `${publicUrl}/dashboard`;
    const base = new URL(root).pathname;
    return {
      dashboard,
      root,
      signInPaths: new Set([`${base}/sign-in`, `${base}/callback`]),
      limits: { client, signIn, signInCeiling },
    };
  }

  return {
    async fetch(
      request: Request,
      env: SlotlockDashboardWorkerEnv,
      ctx: SlotlockDashboardWorkerContext,
    ): Promise<Response> {
      try {
        built ??= build(env);
      } catch (error) {
        if (!(error instanceof SlotlockConfigError)) throw error;
        // The message names the variable, never its value.
        console.error(
          JSON.stringify({ message: 'slotlock dashboard misconfigured', error: error.message }),
        );
        return new Response('The dashboard is not configured.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      const { dashboard, root, signInPaths, limits } = built;
      const path = new URL(request.url).pathname;
      if (path === '/') return Response.redirect(root, 302);
      if (!dashboard.handles(request)) {
        return new Response('Not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      // Before any database client or GitHub request.
      const address = clientOf(request) ?? 'unknown';
      if (!(await limits.client.limit({ key: `client:${address}` })).success) {
        return tooManyRequests();
      }
      // The dashboard routes a path with one trailing slash as the path without it, so a sign-in is
      // recognised as it recognises one: `/dashboard/sign-in/` is a sign-in too.
      const route = path.replace(/\/$/, '');
      if (signInPaths.has(route)) {
        // Per network, not per /64: a site rotating through the /64s of its /48 is one client
        // here, so it cannot use up the ceiling every other client shares.
        const network = slotlockClientNetwork(address);
        const allowed = limits.signInCeiling
          ? (await limits.signIn.limit({ key: `sign-in:${network}` })).success &&
            (await limits.signInCeiling.limit({ key: 'sign-in' })).success
          : (await limits.signIn.limit({ key: 'sign-in' })).success;
        if (!allowed) return tooManyRequests();
      }
      const sql = postgres(env.HYPERDRIVE.connectionString, {
        max: MAX_CONNECTIONS,
        onnotice: () => {},
      });
      try {
        const requestScope: RequestScope = {
          keys: createSlotlockApiKeyStore(sql),
          resources: createSlotlockDashboardResources(createSlotlockStore(sql)),
          state: createSlotlockDashboardState(sql),
        };
        return await scope.run(requestScope, () => dashboard.fetch(request));
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    },
  };
}

export default createSlotlockDashboardWorker();
