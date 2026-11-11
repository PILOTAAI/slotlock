// The admin console (src/admin/app.ts, RFC 0006) as a Cloudflare Worker on its own hostname, behind
// Cloudflare Access. An example configuration to copy, and the one this repository's Dashboard
// workflow bundles to check the Worker builds; deploy it from your own pipeline with your own
// Cloudflare credentials (wrangler.jsonc lists what to set).
//
// It reaches Postgres through its own Hyperdrive configuration, which connects as the console's role
// (SLOTLOCK_ADMIN_DATABASE_URL at `slotlock migrate`): a role that may run the admin functions and
// read no table. Never point it at the serving role or the schema owner.
//
// A Worker may not use a database client from another request, so each request opens its own
// (Hyperdrive keeps the connections). The console is built once per isolate and reaches the request's
// client through AsyncLocalStorage, so its cache of GitHub logins lasts as long as the isolate.
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres, { type Sql } from 'postgres';
import { createSlotlockAccessVerifier } from '../../src/admin/access.js';
import { type SlotlockAdmin, createSlotlockAdmin } from '../../src/admin/app.js';
import { slotlockClientKey } from '../../src/rate-limit.js';

/** A Workers rate limiting binding: counts per Cloudflare location, eventually consistent. */
export interface SlotlockAdminRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** What wrangler.jsonc and `wrangler secret put` give the Worker. */
export interface SlotlockAdminWorkerEnv {
  HYPERDRIVE: { connectionString: string };
  /** Every request, per client address. */
  SLOTLOCK_ADMIN_RATE_LIMIT?: SlotlockAdminRateLimit;
  SLOTLOCK_ADMIN_PUBLIC_URL?: string;
  SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN?: string;
  SLOTLOCK_ADMIN_ACCESS_AUD?: string;
  SLOTLOCK_ADMIN_GITHUB_CLIENT_ID?: string;
  SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET?: string;
  SLOTLOCK_ADMIN_SESSION_SECRET?: string;
  SLOTLOCK_ADMIN_GITHUB_TOKEN?: string;
  [name: string]: unknown;
}

export interface SlotlockAdminWorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SlotlockAdminWorkerOptions {
  /** Reaches GitHub and Cloudflare Access's keys; a test passes a fake. */
  fetch?: typeof fetch;
  /** Opens the request's database client; a test passes its own. */
  connect?: (connectionString: string) => Sql;
}

const REQUIRED = [
  'SLOTLOCK_ADMIN_PUBLIC_URL',
  'SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN',
  'SLOTLOCK_ADMIN_ACCESS_AUD',
  'SLOTLOCK_ADMIN_GITHUB_CLIENT_ID',
  'SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET',
  'SLOTLOCK_ADMIN_SESSION_SECRET',
] as const;

function unavailable(text: string, status = 503): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export function createSlotlockAdminWorker(workerOptions: SlotlockAdminWorkerOptions = {}) {
  const scope = new AsyncLocalStorage<Sql>();
  const connect =
    workerOptions.connect ?? ((connectionString: string) => postgres(connectionString, { max: 1, onnotice: () => {} }));
  let admin: SlotlockAdmin | null = null;
  let built: string | null = null;

  function build(env: SlotlockAdminWorkerEnv): SlotlockAdmin | string {
    const missing = REQUIRED.filter((name) => typeof env[name] !== 'string' || !(env[name] as string).trim());
    if (missing.length > 0) return `The admin console is not configured: set ${missing.join(', ')}.`;
    if (!isRateLimit(env.SLOTLOCK_ADMIN_RATE_LIMIT)) return 'The admin console is not configured: bind SLOTLOCK_ADMIN_RATE_LIMIT.';
    if (typeof env.HYPERDRIVE?.connectionString !== 'string') return 'The admin console is not configured: bind HYPERDRIVE.';
    // Built once per isolate, again only if its configuration changed.
    const key = REQUIRED.map((name) => env[name]).join('\n') + String(env.SLOTLOCK_ADMIN_GITHUB_TOKEN ?? '');
    if (admin && built === key) return admin;
    const publicUrl = (env.SLOTLOCK_ADMIN_PUBLIC_URL as string).trim();
    if (new URL(publicUrl).protocol !== 'https:') return 'SLOTLOCK_ADMIN_PUBLIC_URL must be https.';
    admin = createSlotlockAdmin({
      sql: () => {
        const sql = scope.getStore();
        if (!sql) throw new Error('no database client for this request');
        return sql;
      },
      publicUrl,
      sessionSecret: env.SLOTLOCK_ADMIN_SESSION_SECRET as string,
      github: {
        clientId: (env.SLOTLOCK_ADMIN_GITHUB_CLIENT_ID as string).trim(),
        clientSecret: (env.SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET as string).trim(),
      },
      access: createSlotlockAccessVerifier({
        // A bare host; https:// and a trailing slash, as the Zero Trust dashboard shows it, are dropped.
        teamDomain: (env.SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN as string).trim().replace(/^https:\/\//, '').replace(/\/$/, '').toLowerCase(),
        audience: (env.SLOTLOCK_ADMIN_ACCESS_AUD as string).trim(),
        ...(workerOptions.fetch ? { fetch: workerOptions.fetch } : {}),
      }),
      ...(typeof env.SLOTLOCK_ADMIN_GITHUB_TOKEN === 'string' && env.SLOTLOCK_ADMIN_GITHUB_TOKEN.trim()
        ? { githubToken: env.SLOTLOCK_ADMIN_GITHUB_TOKEN.trim() }
        : {}),
      ...(workerOptions.fetch ? { fetch: workerOptions.fetch } : {}),
    });
    built = key;
    return admin;
  }

  return {
    async fetch(request: Request, env: SlotlockAdminWorkerEnv, ctx: SlotlockAdminWorkerContext): Promise<Response> {
      let console_: SlotlockAdmin | string;
      try {
        console_ = build(env);
      } catch (error) {
        console_ = error instanceof Error ? error.message : 'The admin console is not configured.';
      }
      if (typeof console_ === 'string') {
        console.error(JSON.stringify({ message: 'slotlock admin not configured', detail: console_ }));
        return unavailable('The admin console is not configured.');
      }
      const address = slotlockClientKey(request.headers.get('cf-connecting-ip') ?? '') ?? 'unknown';
      if (!(await (env.SLOTLOCK_ADMIN_RATE_LIMIT as SlotlockAdminRateLimit).limit({ key: `admin:${address}` })).success) {
        return unavailable('Too many requests. Try again in a minute.', 429);
      }
      const sql = connect(env.HYPERDRIVE.connectionString);
      try {
        return await scope.run(sql, () => (console_ as SlotlockAdmin).fetch(request));
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    },
  };
}

function isRateLimit(value: unknown): value is SlotlockAdminRateLimit {
  return typeof (value as SlotlockAdminRateLimit | undefined)?.limit === 'function';
}

export default createSlotlockAdminWorker();
