// API keys against real Postgres, as a LOGIN role without BYPASSRLS that `grantApplicationRole`
// granted: the role the server runs as. It reaches keys only through the schema's functions, so a
// key belongs to one tenant, a revoked or expired key stays dead, and the table itself is out of
// reach. Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SLOTLOCK_API_KEY_ACTIVE_LIMIT,
  type SlotlockApiKeyStore,
  createSlotlockApiKeyStore,
} from '../api-keys.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('API keys (real Postgres)', () => {
  const role = `slotlock_keys_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenantA = `keys-a-${randomUUID()}`;
  const tenantB = `keys-b-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let keys: SlotlockApiKeyStore;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    const applicationUrl = new URL(url as string);
    applicationUrl.username = role;
    applicationUrl.password = password;
    application = postgres(applicationUrl.href, { max: 4, onnotice: () => {} });
    keys = createSlotlockApiKeyStore(application);
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref IN (${tenantA}, ${tenantB})`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps only a digest of the key and resolves it to its tenant and scopes', async () => {
    const created = await keys.create({
      tenantRef: tenantA,
      name: 'Booking agent',
      scopes: ['write', 'read', 'read'],
      createdBy: 'cli',
    });
    expect(created.key).toMatch(/^slk_[0-9A-Za-z]{46}$/);
    expect(created.apiKey).toMatchObject({
      tenantRef: tenantA,
      name: 'Booking agent',
      prefix: created.key.slice(0, 12),
      scopes: ['read', 'write'],
      createdBy: 'cli',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(Object.values(created.apiKey)).not.toContain(created.key);

    const [row] = await admin<{ secret_hash: Buffer; stored: string }[]>`
      SELECT secret_hash, row_to_json(api_keys)::text AS stored
        FROM slotlock.api_keys WHERE id = ${created.apiKey.id}`;
    expect(row?.secret_hash).toEqual(createHash('sha256').update(created.key, 'utf8').digest());
    expect(row?.stored).not.toContain(created.key.slice(12));

    await expect(keys.authenticate(created.key)).resolves.toEqual({
      id: created.apiKey.id,
      tenantRef: tenantA,
      scopes: ['read', 'write'],
    });
    const [listed] = await keys.list({ tenantRef: tenantA });
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("lists, and revokes, only the tenant's own keys", async () => {
    const a = await keys.create({ tenantRef: tenantA, name: 'A reader', scopes: ['read'] });
    const b = await keys.create({ tenantRef: tenantB, name: 'B reader', scopes: ['read'] });

    const listedA = await keys.list({ tenantRef: tenantA });
    const listedB = await keys.list({ tenantRef: tenantB });
    expect(listedA.map(({ id }) => id)).toContain(a.apiKey.id);
    expect(listedA.every(({ tenantRef }) => tenantRef === tenantA)).toBe(true);
    expect(listedB.map(({ id }) => id)).toEqual([b.apiKey.id]);

    // Tenant B names tenant A's key: nothing happens, and B learns nothing about it.
    await expect(keys.revoke({ tenantRef: tenantB, id: a.apiKey.id })).resolves.toBeNull();
    await expect(keys.authenticate(a.key)).resolves.toMatchObject({ tenantRef: tenantA });

    const revoked = await keys.revoke({ tenantRef: tenantA, id: a.apiKey.id });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    await expect(keys.authenticate(a.key)).resolves.toBeNull();
    // Revoking again is idempotent and keeps the first revocation time.
    await expect(keys.revoke({ tenantRef: tenantA, id: a.apiKey.id })).resolves.toEqual(revoked);
    await expect(keys.revoke({ tenantRef: tenantA, id: randomUUID() })).resolves.toBeNull();
  });

  it('refuses an expired key', async () => {
    const expiring = await keys.create({
      tenantRef: tenantA,
      name: 'Short-lived',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(keys.authenticate(expiring.key)).resolves.not.toBeNull();
    await admin`
      UPDATE slotlock.api_keys
         SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE id = ${expiring.apiKey.id}`;
    await expect(keys.authenticate(expiring.key)).resolves.toBeNull();
  });

  it('gives the serving role the functions and nothing on the table', async () => {
    const created = await keys.create({ tenantRef: tenantB, name: 'Probe', scopes: ['read'] });
    for (const statement of [
      'SELECT * FROM slotlock.api_keys',
      'UPDATE slotlock.api_keys SET revoked_at = NULL',
      `INSERT INTO slotlock.api_keys (tenant_ref, name, prefix, secret_hash, scopes)
       VALUES ('x', 'x', 'slk_x', sha256('x'), ARRAY['read'])`,
      'DELETE FROM slotlock.api_keys',
    ]) {
      await expect(application.unsafe(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    await keys.revoke({ tenantRef: tenantB, id: created.apiKey.id });
    await expect(keys.authenticate(created.key)).resolves.toBeNull();
  });

  it("erases a tenant's keys and no other tenant's", async () => {
    const tenant = `keys-erase-${randomUUID()}`;
    const doomed = await keys.create({ tenantRef: tenant, name: 'Doomed', scopes: ['read'] });
    await keys.revoke({
      tenantRef: tenant,
      id: (await keys.create({ tenantRef: tenant, name: 'Revoked', scopes: ['read'] })).apiKey.id,
    });
    const survivor = await keys.create({ tenantRef: tenantA, name: 'Survivor', scopes: ['read'] });

    await expect(keys.erase({ tenantRef: tenant })).resolves.toBe(2);
    await expect(keys.list({ tenantRef: tenant })).resolves.toEqual([]);
    await expect(keys.authenticate(doomed.key)).resolves.toBeNull();
    await expect(keys.authenticate(survivor.key)).resolves.toMatchObject({ tenantRef: tenantA });
    await expect(keys.erase({ tenantRef: tenant })).resolves.toBe(0);
  });

  it('refuses a key past the active limit, even when the requests race', async () => {
    const tenant = `keys-limit-${randomUUID()}`;
    try {
      for (let index = 0; index < SLOTLOCK_API_KEY_ACTIVE_LIMIT - 2; index += 1) {
        await keys.create({ tenantRef: tenant, name: `key ${index}`, scopes: ['read'] });
      }
      const racing = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          keys.create({ tenantRef: tenant, name: `racing ${index}`, scopes: ['read'] }),
        ),
      );
      expect(racing.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
      for (const outcome of racing.filter(({ status }) => status === 'rejected')) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          code: 'api_key_limit_reached',
        });
      }
      // A revoked key stops counting.
      const [first] = await keys.list({ tenantRef: tenant });
      await keys.revoke({ tenantRef: tenant, id: first?.id as string });
      await expect(
        keys.create({ tenantRef: tenant, name: 'after revoke', scopes: ['read'] }),
      ).resolves.toMatchObject({ key: expect.any(String) });
    } finally {
      await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref = ${tenant}`;
    }
  });
});
