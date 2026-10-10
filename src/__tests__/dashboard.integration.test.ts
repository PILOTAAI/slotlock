// The dashboard against real Postgres, as a LOGIN role without BYPASSRLS that grantApplicationRole
// granted: a person signs in (GitHub is a fake `fetch`), and the key the page shows authenticates as
// their tenant, the resource they add lands in their tenant only, and revoking the key ends it.
// Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';

describe.skipIf(!url)('dashboard (real Postgres)', () => {
  const role = `slotlock_dash_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const githubId = 900_000 + Math.floor(Math.random() * 99_999);
  const tenantRef = `github:${githubId}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(
      Object.assign(new URL(url as string), { username: role, password }).href,
      { max: 2, onnotice: () => {} },
    );
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref = ${tenantRef}`;
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('issues a key that authenticates as the signed-in person, and adds their resources', async () => {
    const keys = createSlotlockApiKeyStore(application);
    const store = createSlotlockStore(application);
    const dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liIntegration', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: [String(githubId)],
      keys,
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      fetch: async (input) =>
        String(input).endsWith('/access_token')
          ? Response.json({ access_token: 'gho_fake' })
          : Response.json({ id: githubId, login: 'fleet-owner' }),
    });
    const get = (path: string, cookie?: string) =>
      dashboard.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
    const post = (path: string, fields: Record<string, string>, cookie: string) =>
      dashboard.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            cookie,
            origin: ORIGIN,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    const start = await get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(`/dashboard/callback?code=c&state=${state}`, pending);
    const session = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0] as string;
    expect(session).toBeDefined();
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/dashboard', session)).text())?.[1] as string;

    const created = await post(
      '/dashboard/keys',
      { csrf, name: 'Fleet agent', access: 'read_write', expires: '90' },
      session,
    );
    expect(created.status).toBe(200);
    const key = /id="key" readonly value="(slk_[0-9A-Za-z]{46})"/.exec(await created.text())?.[1] as string;
    expect(key).toBeDefined();
    await expect(keys.authenticate(key)).resolves.toMatchObject({
      tenantRef,
      scopes: ['read', 'write'],
    });
    const [listed] = await keys.list({ tenantRef });
    expect(listed).toMatchObject({ name: 'Fleet agent', createdBy: tenantRef });

    const added = await post(
      '/dashboard/resources',
      { csrf, reference: 'van-7', timezone: 'Europe/London' },
      session,
    );
    expect(added.status).toBe(303);
    const mine = await store.withTenant(tenantRef, (tenant) =>
      tenant.listResources({ tenantRef, limit: 10 }),
    );
    expect(mine.map(({ externalRef, timezone }) => ({ externalRef, timezone }))).toEqual([
      { externalRef: 'van-7', timezone: 'Europe/London' },
    ]);
    const someoneElse = `github:${githubId + 1}`;
    await expect(
      store.withTenant(someoneElse, (tenant) =>
        tenant.listResources({ tenantRef: someoneElse, limit: 10 }),
      ),
    ).resolves.toEqual([]);

    const revoked = await post('/dashboard/keys/revoke', { csrf, id: listed?.id as string }, session);
    expect(revoked.status).toBe(303);
    await expect(keys.authenticate(key)).resolves.toBeNull();
  });
});
