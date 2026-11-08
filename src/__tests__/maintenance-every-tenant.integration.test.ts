// `slotlock serve` maintains every tenant with data, not only the ones whose keys it has served
// since it started: a tenant gone quiet still has its feed pruned past retention. Real Postgres, a
// database of its own, an owner and a serving role that RLS confines. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockEnv, runSlotlockCli } from '../self-host.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

function output() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!url)('serve maintains every tenant with data (real Postgres)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const owner = `slotlock_mt_owner_${suffix}`;
  const application = `slotlock_mt_app_${suffix}`;
  const database = `slotlock_mt_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const served = `served-${randomUUID()}`;
  const idle = `idle-${randomUUID()}`;
  const other = `other-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let superuser: ReturnType<typeof postgres>;
  let deployment: ReturnType<typeof postgres>;
  let serving: ReturnType<typeof postgres>;
  let ownerStore: SlotlockStore;
  let store: SlotlockStore;
  let target: URL;

  const changes = async (tenantRef: string) => {
    const [row] = await superuser<{ old: number; fresh: number }[]>`
      SELECT count(*) FILTER (WHERE occurred_at < now() - interval '30 days')::int AS old,
             count(*) FILTER (WHERE occurred_at >= now() - interval '30 days')::int AS fresh
        FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`;
    return row ?? { old: -1, fresh: -1 };
  };
  const listed = async () =>
    (
      await superuser<{ tenant_ref: string }[]>`
        SELECT tenant_ref FROM slotlock.maintenance_tenants ORDER BY tenant_ref`
    ).map(({ tenant_ref }) => tenant_ref);
  const vehicle = (tenantRef: string) =>
    store.withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef: `vehicle-${randomUUID()}`, timezone: 'UTC' }),
    );

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(
      `CREATE ROLE ${owner} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(
      `CREATE ROLE ${application} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
    deployment = postgres(Object.assign(new URL(target.href), { username: owner, password }).href, {
      max: 2,
      onnotice: () => undefined,
    });
    serving = postgres(
      Object.assign(new URL(target.href), { username: application, password }).href,
      { max: 2, onnotice: () => undefined },
    );
    ownerStore = createSlotlockStore(deployment);
    await ownerStore.applySchema();
    await ownerStore.applyTenantRls();
    await ownerStore.grantApplicationRole(application);
    store = createSlotlockStore(serving);
  });

  afterAll(async () => {
    await serving?.end();
    await deployment?.end();
    await superuser?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${application}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  it("prunes an idle tenant's feed past retention on the first pass, and keeps what is fresh", async () => {
    // The idle tenant's first two changes are 31 days old; its third, and the other tenant's, are new.
    await vehicle(idle);
    await vehicle(idle);
    await superuser`
      UPDATE slotlock.outbox SET occurred_at = now() - interval '31 days' WHERE tenant_ref = ${idle}`;
    await vehicle(idle);
    await vehicle(other);
    expect(await changes(idle)).toEqual({ old: 2, fresh: 1 });
    expect(await changes(other)).toEqual({ old: 0, fresh: 1 });

    // No key of the idle tenant's calls: the server is configured with another tenant.
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const env: SlotlockEnv = {
      DATABASE_URL: Object.assign(new URL(target.href), { username: application, password }).href,
      SLOTLOCK_TENANT: served,
      SLOTLOCK_AUTH_TOKEN: randomBytes(32).toString('hex'),
      HOST: '127.0.0.1',
      PORT: '0',
      SLOTLOCK_PUBLIC_URL: 'http://localhost:8080',
    };
    const running = runSlotlockCli(['serve'], { env, stdout, stderr, signal: shutdown.signal });
    try {
      await eventually(async () => (await changes(idle)).old === 0);
    } finally {
      shutdown.abort();
      expect(await running).toBe(0);
    }
    expect(stderr.text()).toBe('');
    expect(stdout.text()).not.toContain('maintenance_failed');
    expect(await changes(idle)).toEqual({ old: 0, fresh: 1 });
    expect(await changes(other)).toEqual({ old: 0, fresh: 1 });
  }, 30_000);

  it('lists tenants by name for the owner only, takes erased ones off, and starts from every tenant known', async () => {
    expect(await listed()).toEqual([idle, other].sort());
    // The serving role reads names only through slotlock.maintenance_tenants(text), never the table.
    await expect(serving`SELECT tenant_ref FROM slotlock.maintenance_tenants`).rejects.toMatchObject({
      code: '42501',
    });
    const page = await serving<{ tenant: string }[]>`
      SELECT slotlock.maintenance_tenants(${null}::text) AS tenant`;
    expect(page.map(({ tenant }) => tenant)).toEqual([idle, other].sort());

    await ownerStore.eraseTenant({ tenantRef: other });
    expect(await listed()).toEqual([idle]);

    // A deployment that predates the list starts it from the rows already there, with FORCE on.
    await superuser`DROP TABLE slotlock.maintenance_tenants`;
    await superuser`UPDATE slotlock.schema_version SET ddl_sha256 = NULL, catalog_sha256 = NULL`;
    await ownerStore.applySchema();
    expect(await listed()).toEqual([idle]);
    await vehicle(other);
    expect(await listed()).toEqual([idle, other].sort());
  });
});
