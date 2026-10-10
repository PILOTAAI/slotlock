// Two dashboard instances sharing one real Postgres, as two servers behind a load balancer would:
// a sign-in, a sent form and a signed-out session are each honoured by both, and racing resource
// adds on both stop at the cap. The serving role is a LOGIN role without BYPASSRLS granted by
// grantApplicationRole. Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  SLOTLOCK_DASHBOARD_MAX_RESOURCES,
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';

describe.skipIf(!url)('dashboard state shared through Postgres (real Postgres)', () => {
  const role = `slotlock_share_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const githubId = 800_000 + Math.floor(Math.random() * 99_999);
  const tenantRef = `github:${githubId}`;
  const sessionSecret = randomBytes(32).toString('hex');
  let admin: ReturnType<typeof postgres>;
  const pools: ReturnType<typeof postgres>[] = [];
  const github = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith('/access_token')
      ? Response.json({ access_token: 'gho_fake' })
      : Response.json({ id: githubId, login: 'two-servers' }),
  );

  function connectAsServer(): ReturnType<typeof postgres> {
    const pool = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
    pools.push(pool);
    return pool;
  }

  /** One server: its own pool, the shared database. */
  function server() {
    const sql = connectAsServer();
    return createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liShared', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret,
      allowedUsers: [String(githubId)],
      keys: createSlotlockApiKeyStore(sql),
      resources: createSlotlockDashboardResources(createSlotlockStore(sql)),
      state: createSlotlockDashboardState(sql),
      fetch: github as unknown as typeof fetch,
    });
  }

  const get = (target: ReturnType<typeof server>, path: string, cookie?: string) =>
    target.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
  const post = (
    target: ReturnType<typeof server>,
    path: string,
    fields: Record<string, string>,
    cookie: string,
  ) =>
    target.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const sessionOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0];

  async function startSignIn(target: ReturnType<typeof server>) {
    const start = await get(target, '/dashboard/sign-in');
    return {
      state: new URL(start.headers.get('location') ?? '').searchParams.get('state') as string,
      pending: start.headers.getSetCookie()[0]?.split('; ')[0] as string,
    };
  }

  async function signIn(target: ReturnType<typeof server>) {
    const { state, pending } = await startSignIn(target);
    const callback = await get(target, `/dashboard/callback?code=c&state=${state}`, pending);
    return sessionOf(callback) as string;
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref = ${tenantRef}`;
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    for (const pool of pools) await pool.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps the records out of the serving role, which reaches them only through the functions', async () => {
    const sql = connectAsServer();
    for (const statement of [
      'SELECT count(*) FROM slotlock.dashboard_tokens',
      "INSERT INTO slotlock.dashboard_tokens VALUES ('form', decode(repeat('00', 32), 'hex'), now())",
      'DELETE FROM slotlock.dashboard_tokens',
    ]) {
      await expect(sql.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    }
    // A kind outside the three, or a digest that is not 32 bytes, is refused by the table itself.
    await expect(
      sql`SELECT slotlock.use_dashboard_token('session', ${Buffer.alloc(32)}, now() + interval '1 hour')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`SELECT slotlock.use_dashboard_token('form', ${Buffer.alloc(31)}, now() + interval '1 hour')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records a token once until it expires, and prunes expired records as it goes', async () => {
    const state = createSlotlockDashboardState(connectAsServer());
    const live = randomBytes(18).toString('base64url');
    expect(await state.use('form', live, Date.now() + 3_600_000)).toBe(true);
    expect(await state.use('form', live, Date.now() + 3_600_000)).toBe(false);
    // The same value is a different record under another kind.
    expect(await state.use('sign_in', live, Date.now() + 3_600_000)).toBe(true);

    // Expired (past the five-minute skew allowance): absent, so it is recorded again.
    const old = randomBytes(18).toString('base64url');
    expect(await state.use('form', old, Date.now() - 3_600_000)).toBe(true);
    expect(await state.use('form', old, Date.now() - 3_600_000)).toBe(true);

    await admin`
      INSERT INTO slotlock.dashboard_tokens (kind, token_hash, expires_at)
      SELECT 'form', decode(md5(random()::text) || md5(random()::text), 'hex'), now() - interval '1 hour'
        FROM generate_series(1, 3)`;
    const expired = async () =>
      Number(
        (await admin<{ count: string }[]>`
          SELECT count(*) AS count FROM slotlock.dashboard_tokens WHERE expires_at <= now()`)[0]?.count,
      );
    const before = await expired();
    expect(before).toBeGreaterThanOrEqual(3);
    await state.use('form', randomBytes(18).toString('base64url'), Date.now() + 3_600_000);
    expect(await expired()).toBeLessThanOrEqual(Math.max(0, before - 100));
    await expect(state.use('form', 'x'.repeat(22), Number.NaN)).rejects.toThrow('finite expiry');
  });

  it('keeps a stored record no longer than a day, plus the skew allowance', async () => {
    const state = createSlotlockDashboardState(connectAsServer());
    const value = randomBytes(18).toString('base64url');
    await state.use('form', value, Date.now() + 365 * 86_400_000);
    const [row] = await admin<{ hours: number }[]>`
      SELECT extract(epoch FROM max(expires_at) - now()) / 3600 AS hours
        FROM slotlock.dashboard_tokens
       WHERE kind = 'form'
         AND token_hash = sha256(convert_to(${`slotlock-dashboard-form.${value}`}, 'UTF8'))`;
    expect(Number(row?.hours)).toBeGreaterThan(24);
    expect(Number(row?.hours)).toBeLessThanOrEqual(24 + 5 / 60);
  });

  it('finishes a sign-in once, whichever server the callback reaches', async () => {
    const [first, second] = [server(), server()];
    const { state, pending } = await startSignIn(first);
    github.mockClear();
    const done = await get(first, `/dashboard/callback?code=c&state=${state}`, pending);
    expect(done.status).toBe(303);
    const replay = await get(second, `/dashboard/callback?code=c&state=${state}`, pending);
    expect(replay.status).toBe(400);
    expect(github.mock.calls.filter(([input]) => String(input).endsWith('/access_token'))).toHaveLength(1);
  });

  it('keeps a signed-out session out on every server', async () => {
    const [first, second] = [server(), server()];
    const session = await signIn(first);
    expect(await (await get(second, '/dashboard', session)).text()).toContain('@two-servers');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await get(first, '/dashboard', session)).text())?.[1] as string;
    await post(first, '/dashboard/sign-out', { csrf }, session);
    expect(await (await get(second, '/dashboard', session)).text()).not.toContain('@two-servers');
    expect(await (await get(first, '/dashboard', session)).text()).not.toContain('@two-servers');
  });

  it('runs a form once, whichever server it is sent to again', async () => {
    const [first, second] = [server(), server()];
    const session = await signIn(first);
    const html = await (await get(first, '/dashboard', session)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    const once = /action="\/dashboard\/keys">\s*<input type="hidden" name="csrf" value="[^"]+">\s*<input type="hidden" name="once" value="([^"]+)">/.exec(html)?.[1] as string;
    const fields = { csrf, once, name: 'Shared', access: 'read', expires: 'never' };
    expect((await post(first, '/dashboard/keys', fields, session)).status).toBe(200);
    expect((await post(second, '/dashboard/keys', fields, session)).status).toBe(409);
    const keys = await createSlotlockApiKeyStore(admin).list({ tenantRef });
    expect(keys.filter(({ name }) => name === 'Shared')).toHaveLength(1);
  });

  it('holds the resource cap when adds race on two servers', async () => {
    const [first, second] = [server(), server()];
    const session = await signIn(first);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await get(first, '/dashboard', session)).text())?.[1] as string;
    const store = createSlotlockStore(connectAsServer());
    for (let index = 0; index < SLOTLOCK_DASHBOARD_MAX_RESOURCES - 5; index += 1) {
      await store.withTenant(tenantRef, (tenant) =>
        tenant.createResource({ tenantRef, externalRef: `seed-${index}`, timezone: 'UTC' }),
      );
    }
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post(index % 2 === 0 ? first : second, '/dashboard/resources', { csrf, reference: `race-${index}`, timezone: 'UTC' }, session),
      ),
    );
    const [counted] = await admin<{ count: string }[]>`
      SELECT count(*) FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    expect(Number(counted?.count)).toBe(SLOTLOCK_DASHBOARD_MAX_RESOURCES);
    expect(outcomes.filter(({ status }) => status === 303)).toHaveLength(5);
    expect(outcomes.filter(({ status }) => status === 409)).toHaveLength(15);

    // At the cap, an existing reference can still be re-zoned; a new one cannot be added.
    const rezone = await post(first, '/dashboard/resources', { csrf, reference: 'seed-0', timezone: 'Europe/Paris' }, session);
    expect(rezone.status).toBe(303);
    const added = await post(second, '/dashboard/resources', { csrf, reference: 'one-more', timezone: 'UTC' }, session);
    expect(added.status).toBe(409);
  });
});

describe.skipIf(!url)('capped resource creation in the store (real Postgres)', () => {
  const role = `slotlock_cap_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenantRef = `cap-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let repeatable: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    await admin.unsafe(`ALTER ROLE ${role} SET default_transaction_isolation = 'repeatable read'`);
    repeatable = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 8,
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    await repeatable?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('holds the cap under a REPEATABLE READ default by creating in READ COMMITTED', async () => {
    const store = createSlotlockStore(repeatable);
    const add = (externalRef: string) =>
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.createResource({ tenantRef, externalRef, timezone: 'UTC', maxTenantResources: 10 }),
        { isolation: 'read committed' },
      );
    for (let index = 0; index < 8; index += 1) await add(`base-${index}`);
    const racing = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => add(`race-${index}`)));
    expect(racing.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
    for (const outcome of racing.filter(({ status }) => status === 'rejected')) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'resource_limit_reached' });
    }
    // A capped create inside a REPEATABLE READ transaction cannot count exactly, so it refuses.
    await expect(
      store.withTenant(tenantRef, (tenant) =>
        tenant.createResource({ tenantRef, externalRef: 'x', timezone: 'UTC', maxTenantResources: 50 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_transaction_isolation' });
  });

  it('records a token once under a REPEATABLE READ role default, while the first use commits', async () => {
    const state = createSlotlockDashboardState(repeatable);
    const value = randomBytes(18).toString('base64url');
    const digest = createHash('sha256').update(`slotlock-dashboard-form.${value}`).digest();
    let second: Promise<boolean> | undefined;
    // The first use holds its row uncommitted; the second waits on it, then finds it committed.
    await repeatable.begin(async (tx) => {
      const [first] = await tx<{ used: boolean }[]>`
        SELECT slotlock.use_dashboard_token('form', ${digest}, now() + interval '1 hour') AS used`;
      expect(first?.used).toBe(true);
      second = state.use('form', value, Date.now() + 3_600_000);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await expect(second).resolves.toBe(false);
  });

  it("adds through the dashboard's adapter under a REPEATABLE READ role default", async () => {
    const resources = createSlotlockDashboardResources(createSlotlockStore(repeatable));
    const added = await resources.add(tenantRef, 'adapter', 'Europe/London');
    expect(added).toMatchObject({ externalRef: 'adapter', timezone: 'Europe/London' });
  });

  it.each([0, -1, 1.5, 100_001, Number.NaN])('refuses a cap of %s', async (max) => {
    const store = createSlotlockStore(repeatable);
    await expect(
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.createResource({ tenantRef, externalRef: 'y', timezone: 'UTC', maxTenantResources: max }),
        { isolation: 'read committed' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_resource_limit' });
  });
});
