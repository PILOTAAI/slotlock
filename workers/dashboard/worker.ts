// The dashboard (src/dashboard.ts) as a Cloudflare Worker: GitHub sign-in, and the API keys and
// resources of each person's tenant, served from its own origin (SLOTLOCK_PUBLIC_URL) while the
// server agents use runs elsewhere (SLOTLOCK_SERVICE_URL). It reaches Postgres through Hyperdrive
// with caching off: a sign-in, a sent form and a sign-out are recorded and read back at once.
//
// A Worker may not use a database client from another request, so each request opens its own
// (Hyperdrive keeps the connections). The dashboard is built once per isolate, like one
// `slotlock serve` process, and reaches the request's client through AsyncLocalStorage, so its
// limit on sign-ins in flight holds across the requests the isolate serves.
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
import { createSlotlockStore } from '../../src/store.js';

/** What wrangler.jsonc and `wrangler secret put` give the Worker. */
export interface SlotlockDashboardWorkerEnv {
  HYPERDRIVE: { connectionString: string };
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
  let built: { dashboard: SlotlockDashboard; root: string } | undefined;

  function build(env: SlotlockDashboardWorkerEnv) {
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
      availability: readAvailability(vars),
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
    return { dashboard, root: `${publicUrl}/dashboard` };
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
      const { dashboard, root } = built;
      if (new URL(request.url).pathname === '/') return Response.redirect(root, 302);
      if (!dashboard.handles(request)) {
        return new Response('Not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
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
