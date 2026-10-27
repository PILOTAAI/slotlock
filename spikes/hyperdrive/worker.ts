// RFC 0001's spike: what Slotlock's API needs from PostgreSQL, asked through a Worker's Hyperdrive
// binding. run.mjs calls these routes and judges the answers; this Worker only reports what happened.
// Times come from the database's clock (clock_timestamp()), so two requests' intervals compare
// without trusting either isolate's clock. Every request opens its own client and ends it, as the
// dashboard Worker does.
import postgres from 'postgres';
import { SLOTLOCK_TENANT_CONTEXT_SETTING } from '../../src/ddl.js';
import { createSlotlockStore } from '../../src/store.js';

export interface SpikeEnv {
  HYPERDRIVE: { connectionString: string };
  /** Guards every route: the spike Worker is public while it runs. */
  SPIKE_TOKEN: string;
}

type Sql = ReturnType<typeof postgres>;

function open(env: SpikeEnv, max = 1): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max,
    fetch_types: false,
    prepare: true,
    onnotice: () => {},
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorOf(error: unknown) {
  const e = error as { name?: string; message?: string; code?: string };
  return { name: e?.name ?? 'Error', code: e?.code ?? null, message: e?.message ?? String(error) };
}

function lockKey(name: string): string {
  return `slotlock-spike:${name}`;
}

/**
 * Check 1: take a transaction advisory lock, hold it `hold` ms, and commit (or, with `fail`, throw
 * after taking it so the transaction rolls back). Reports when it asked, got and gave up the lock.
 */
async function lock(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const shared = params.get('mode') === 'shared';
  const holdSeconds = Number(params.get('hold') ?? '0') / 1000;
  const fail = params.get('fail') === '1';
  const key = lockKey(params.get('key') ?? 'default');
  const sql = open(env);
  if (params.get('session') === '1') {
    // The control: a session lock, as maintenance.ts takes today, never unlocked. On a direct
    // connection it ends with the client; behind a transaction pooler it stays with the server
    // connection the pooler hands to the next client.
    try {
      const [row] = await sql<{ locked: boolean; pid: number }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked, pg_backend_pid() AS pid`;
      return json({ ok: true, session: true, ...row });
    } catch (error) {
      return json({ ok: false, error: errorOf(error) }, 500);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  try {
    const times: {
      askedAt?: string | undefined;
      acquiredAt?: string | undefined;
      releasedAt?: string | undefined;
      backend?: number | undefined;
    } = {};
    try {
      await sql.begin(async (tx) => {
        const [asked] = await tx<{ at: string; pid: number }[]>`
          SELECT clock_timestamp()::text AS at, pg_backend_pid() AS pid`;
        times.askedAt = asked?.at;
        times.backend = asked?.pid;
        const [acquired] = shared
          ? await tx<{ at: string }[]>`
              SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text AS locked,
                     clock_timestamp()::text AS at`
          : await tx<{ at: string }[]>`
              SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS locked,
                     clock_timestamp()::text AS at`;
        times.acquiredAt = acquired?.at;
        if (holdSeconds > 0) await tx`SELECT pg_sleep(${holdSeconds})`;
        const [released] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
        times.releasedAt = released?.at;
        if (fail) throw Object.assign(new Error('rolled back on purpose'), { code: 'SPIKE_ROLLBACK' });
      });
      return json({ ok: true, shared, ...times });
    } catch (error) {
      const e = errorOf(error);
      if (e.code === 'SPIKE_ROLLBACK') return json({ ok: true, rolledBack: true, shared, ...times });
      return json({ ok: false, error: e, ...times }, 500);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Check 2: what a request sees of the tenant setting and of tenant rows, as the application role. */
async function context(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const tenantRef = params.get('tenant');
  const sql = open(env);
  try {
    const [outside] = await sql<{ setting: string | null; visible: number; role: string }[]>`
      SELECT current_setting(${SLOTLOCK_TENANT_CONTEXT_SETTING}, true) AS setting,
             (SELECT count(*)::int FROM slotlock.resources) AS visible,
             current_user AS role`;
    let inside: (string | null)[] | null = null;
    if (tenantRef) {
      const store = createSlotlockStore(sql);
      inside = await store.withTenant(tenantRef, async (tenant) =>
        (await tenant.listResources({ tenantRef })).map((resource) => resource.externalRef),
      );
    }
    return json({ ok: true, outside, inside });
  } catch (error) {
    return json({ ok: false, error: errorOf(error) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Checks 2 and 3: create a resource, or book a slot on it, through Slotlock's store. */
async function store(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const tenantRef = params.get('tenant') ?? '';
  const op = params.get('op');
  const sql = open(env, 2);
  try {
    const slotlock = createSlotlockStore(sql);
    const result = await slotlock.withTenant(tenantRef, async (tenant) => {
      if (op === 'resource') {
        const resource = await tenant.createResource({
          tenantRef,
          externalRef: params.get('ref') ?? 'spike-resource',
          timezone: 'UTC',
        });
        return { resourceId: resource.id };
      }
      if (op === 'book') {
        return tenant.putCalendarEvent({
          tenantRef,
          externalRef: params.get('ref') ?? 'spike-event',
          idempotencyKey: params.get('ref') ?? 'spike-event',
          expectedRevision: 0,
          resourceId: params.get('resource') ?? '',
          start: new Date(params.get('start') ?? ''),
          end: new Date(params.get('end') ?? ''),
          timezone: 'UTC',
          summary: 'Spike',
        });
      }
      if (op === 'busy') {
        const busy = await tenant.getFreeBusy({
          tenantRef,
          resourceId: params.get('resource') ?? '',
          window: { start: new Date(params.get('start') ?? ''), end: new Date(params.get('end') ?? '') },
        });
        return busy;
      }
      throw new Error(`unknown op ${op}`);
    });
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: errorOf(error) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Check 4: a server-sent event stream that keeps one client for `seconds` and polls the resource's
 * busy time every `every` seconds, as a live-updates subscription does.
 */
function stream(env: SpikeEnv, params: URLSearchParams, ctx: ExecutionContext): Response {
  const tenantRef = params.get('tenant') ?? '';
  const resourceId = params.get('resource') ?? '';
  const seconds = Number(params.get('seconds') ?? '60');
  const every = Number(params.get('every') ?? '15');
  const window = { start: new Date(params.get('start') ?? ''), end: new Date(params.get('end') ?? '') };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const run = async () => {
    const sql = open(env);
    const slotlock = createSlotlockStore(sql);
    const startedAt = Date.now();
    try {
      for (let poll = 0; Date.now() - startedAt < seconds * 1000; poll++) {
        const busy = await slotlock.withTenant(tenantRef, (tenant) =>
          tenant.getFreeBusy({ tenantRef, resourceId, window }),
        );
        await send('poll', { poll, elapsed: Math.round((Date.now() - startedAt) / 1000), busy });
        await new Promise((resolve) => setTimeout(resolve, every * 1000));
      }
      await send('end', { elapsed: Math.round((Date.now() - startedAt) / 1000) });
    } catch (error) {
      await send('error', errorOf(error)).catch(() => {});
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
      await writer.close().catch(() => {});
    }
  };
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

/** Check 5: `n` clients at once, each holding a query for `hold` ms. */
async function connections(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const n = Math.min(Number(params.get('n') ?? '8'), 20);
  const holdSeconds = Number(params.get('hold') ?? '2000') / 1000;
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, async (_, index) => {
      const sql = open(env);
      try {
        const [row] = await sql<{ started: string; ended: string }[]>`
          SELECT clock_timestamp()::text AS started, pg_sleep(${holdSeconds})::text AS slept,
                 clock_timestamp()::text AS ended`;
        return { index, ok: true, ms: Date.now() - startedAt, ...row };
      } catch (error) {
        return { index, ok: false, ms: Date.now() - startedAt, error: errorOf(error) };
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }),
  );
  return json({ ok: true, results });
}

export default {
  async fetch(request: Request, env: SpikeEnv, ctx: ExecutionContext): Promise<Response> {
    if (!env.SPIKE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.SPIKE_TOKEN}`) {
      return new Response('Not found', { status: 404 });
    }
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/lock':
        return lock(env, url.searchParams);
      case '/context':
        return context(env, url.searchParams);
      case '/store':
        return store(env, url.searchParams);
      case '/stream':
        return stream(env, url.searchParams, ctx);
      case '/connections':
        return connections(env, url.searchParams);
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};

/** The part of a Worker's ExecutionContext this Worker uses. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
