// Suspending and erasing a tenant, deployed as README's deployment role (NOSUPERUSER NOBYPASSRLS,
// reached through SET ROLE) under forced row-level security, and served by a LOGIN role that
// grantApplicationRole granted. A suspended tenant may read, and write nothing, its writes in flight
// are waited for, and only the deployment role suspends. Erasure deletes every row the tenant owns in
// every table with a tenant column (the catalog is enumerated, so a table added later must be
// covered), retires its keys, leaves another tenant as it was, and deletes nothing the second time.
// A database and roles of their own; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboardState } from '../dashboard.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const HOUR = 60 * 60 * 1000;
const AGENT = `agent:${'c'.repeat(64)}`;
const slot = (n: number) => ({
  start: new Date(Date.UTC(2027, 1, 1, 0) + n * HOUR),
  end: new Date(Date.UTC(2027, 1, 1, 0) + (n + 1) * HOUR),
});

describe.skipIf(!url)('tenant suspension and erasure (real Postgres, deployment role)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_tenant_admin_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const serving = `slotlock_app_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let admin: postgres.Sql;
  /** A superuser on the test database: it inspects past row-level security. */
  let superuser: postgres.Sql;
  let application: postgres.Sql;
  /** The store as the serving role. */
  let app: SlotlockStore;

  /** Run `work` as the deployment role, through SET ROLE, in one transaction. */
  async function asOwner<T>(work: (store: SlotlockStore) => Promise<T>): Promise<T> {
    return (await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      return work(createSlotlockStore(tx));
    })) as T;
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(
      `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(
      `CREATE ROLE ${serving} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
    await asOwner(async (store) => {
      await store.applySchema();
      await store.applyTenantRls();
      await store.grantApplicationRole(serving);
    });
    const applicationUrl = new URL(target.href);
    applicationUrl.username = serving;
    applicationUrl.password = password;
    application = postgres(applicationUrl.href, { max: 12, onnotice: () => undefined });
    app = createSlotlockStore(application);
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await superuser?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${serving}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  /**
   * As the serving role, issue a key (create_api_key) or a new secret for one (rotate_api_key) in a
   * READ COMMITTED transaction held open until `release` is called; `inFlight` resolves once the
   * function has returned inside it.
   */
  function keyInFlight(tenantRef: string, rotateId?: string) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const prefix = `slk_${randomBytes(4).toString('hex')}`;
    const committed = application.begin('isolation level read committed', async (tx) => {
      if (rotateId === undefined) {
        await tx`
          SELECT key_id FROM slotlock.create_api_key(
            ${tenantRef}::text, 'Racing key', ${prefix}::text, ${randomBytes(32)}::bytea,
            pg_catalog.string_to_array('read', ','), NULL::timestamptz, NULL::text)`;
      } else {
        await tx`
          SELECT key_id FROM slotlock.rotate_api_key(
            ${tenantRef}::text, ${rotateId}::uuid, ${prefix}::text, ${randomBytes(32)}::bytea)`;
      }
      started();
      await gate;
    });
    return { committed, inFlight, release };
  }

  /** Whether `pending` is still unsettled after `ms`. */
  async function stillWaiting(pending: Promise<unknown>, ms = 300): Promise<boolean> {
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return !settled;
  }

  async function freshTenant(prefix = 'tenant') {
    const tenantRef = `${prefix}-${randomUUID()}`;
    const resource = await app.withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef: 'vehicle-1', timezone: 'UTC' }),
    );
    return { tenantRef, resourceId: resource.id };
  }

  describe('suspension', () => {
    it('refuses every write and keeps every read, for that tenant only', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const other = await freshTenant();
      await expect(
        asOwner((store) => store.suspendTenant({ tenantRef, reason: 'abuse report 42' })),
      ).resolves.toEqual({
        suspended: true,
      });
      await expect(asOwner((store) => store.suspendTenant({ tenantRef }))).resolves.toEqual({
        suspended: false,
      });
      await expect(app.isTenantSuspended({ tenantRef })).resolves.toBe(true);
      await expect(app.isTenantSuspended({ tenantRef: other.tenantRef })).resolves.toBe(false);

      await app.withTenant(tenantRef, async (tenant) => {
        await expect(
          tenant.acquireHold({ tenantRef, resourceId, ...slot(0), ttlMs: 60_000 }),
        ).rejects.toMatchObject({ code: 'tenant_suspended' });
        await expect(
          tenant.createResource({ tenantRef, externalRef: 'vehicle-2' }),
        ).rejects.toMatchObject({ code: 'tenant_suspended' });
        await expect(tenant.listResources({ tenantRef })).resolves.toHaveLength(1);
        await expect(
          tenant.getFreeBusy({ tenantRef, resourceId, window: slot(0) }),
        ).resolves.toMatchObject({ busy: [] });
      });
      await expect(
        app.withTenant(other.tenantRef, (tenant) =>
          tenant.acquireHold({
            tenantRef: other.tenantRef,
            resourceId: other.resourceId,
            ...slot(0),
            ttlMs: 60_000,
          }),
        ),
      ).resolves.toMatchObject({ ok: true });

      // No new key; one it has still authenticates (reads go on).
      const keys = createSlotlockApiKeyStore(application);
      await expect(keys.create({ tenantRef, name: 'New key', scopes: ['read'] })).rejects.toThrow(/suspended/);
      const kept = await keys.create({ tenantRef: other.tenantRef, name: 'Kept key', scopes: ['read'] });
      await asOwner((store) => store.suspendTenant({ tenantRef: other.tenantRef }));
      await expect(keys.authenticate(kept.key)).resolves.toMatchObject({
        tenantRef: other.tenantRef,
      });
      await expect(keys.rotate({ tenantRef: other.tenantRef, id: kept.apiKey.id })).rejects.toThrow(
        /suspended/,
      );

      await expect(asOwner((store) => store.unsuspendTenant({ tenantRef }))).resolves.toEqual({
        unsuspended: true,
      });
      await expect(asOwner((store) => store.unsuspendTenant({ tenantRef }))).resolves.toEqual({
        unsuspended: false,
      });
      await expect(
        app.withTenant(tenantRef, (tenant) =>
          tenant.acquireHold({ tenantRef, resourceId, ...slot(1), ttlMs: 60_000 }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it('is the deployment role’s alone: the serving role may not suspend or lift one', async () => {
      const { tenantRef } = await freshTenant();
      await expect(app.suspendTenant({ tenantRef })).rejects.toMatchObject({
        code: 'tenant_suspension_not_permitted',
      });
      await asOwner((store) => store.suspendTenant({ tenantRef }));
      await expect(app.unsuspendTenant({ tenantRef })).rejects.toMatchObject({
        code: 'tenant_suspension_not_permitted',
      });
      await expect(app.isTenantSuspended({ tenantRef })).resolves.toBe(true);
      await expect(
        asOwner((store) => store.suspendTenant({ tenantRef, reason: 'bad\u0007reason' })),
      ).rejects.toMatchObject({ code: 'invalid_suspension_reason' });
    });

    it('waits for a write in flight, and refuses every one that starts after it', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => {};
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      const writer = app.withTenant(tenantRef, async (tenant) => {
        const hold = await tenant.acquireHold({ tenantRef, resourceId, ...slot(0), ttlMs: 60_000 });
        started();
        await gate;
        return hold;
      });
      await inFlight;
      let suspendedAt = 0;
      const suspension = asOwner((store) => store.suspendTenant({ tenantRef })).then((result) => {
        suspendedAt = Date.now();
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(suspendedAt).toBe(0);
      release();
      await expect(writer).resolves.toMatchObject({ ok: true });
      await expect(suspension).resolves.toEqual({ suspended: true });
      await expect(
        app.withTenant(tenantRef, (tenant) =>
          tenant.acquireHold({ tenantRef, resourceId, ...slot(1), ttlMs: 60_000 }),
        ),
      ).rejects.toMatchObject({ code: 'tenant_suspended' });
    });

    it('waits for a key or a secret being issued, and none is issued after it', async () => {
      const { tenantRef } = await freshTenant();
      const keys = createSlotlockApiKeyStore(application);

      const creating = keyInFlight(tenantRef);
      await creating.inFlight;
      const suspension = asOwner((store) => store.suspendTenant({ tenantRef }));
      expect(await stillWaiting(suspension)).toBe(true);
      creating.release();
      await creating.committed;
      await expect(suspension).resolves.toEqual({ suspended: true });
      await expect(keys.create({ tenantRef, name: 'Late key', scopes: ['read'] })).rejects.toThrow(
        /suspended/,
      );

      const other = await freshTenant();
      const kept = await keys.create({
        tenantRef: other.tenantRef,
        name: 'Kept',
        scopes: ['read'],
      });
      const rotating = keyInFlight(other.tenantRef, kept.apiKey.id);
      await rotating.inFlight;
      const second = asOwner((store) => store.suspendTenant({ tenantRef: other.tenantRef }));
      expect(await stillWaiting(second)).toBe(true);
      rotating.release();
      await rotating.committed;
      await expect(second).resolves.toEqual({ suspended: true });
      await expect(keys.rotate({ tenantRef: other.tenantRef, id: kept.apiKey.id })).rejects.toThrow(
        /suspended/,
      );
    });

    it('lets racing writes either commit before it or be refused, nothing else', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const writes = Array.from({ length: 24 }, (_, n) =>
        app
          .withTenant(tenantRef, (tenant) =>
            tenant.acquireHold({ tenantRef, resourceId, ...slot(n), ttlMs: 600_000 }),
          )
          .then(
            (result) => (result.ok ? 'held' : result.code),
            (error: { code?: string }) => error.code ?? 'error',
          ),
      );
      const suspension = asOwner((store) => store.suspendTenant({ tenantRef }));
      const outcomes = await Promise.all(writes);
      await suspension;
      expect(new Set(outcomes).size).toBeLessThanOrEqual(2);
      for (const outcome of outcomes) expect(['held', 'tenant_suspended']).toContain(outcome);
      const [stored] = await superuser<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.reservations WHERE resource_id = ${resourceId}`;
      expect(stored?.count).toBe(outcomes.filter((outcome) => outcome === 'held').length);
      const late = await app
        .withTenant(tenantRef, (tenant) =>
          tenant.acquireHold({ tenantRef, resourceId, ...slot(30), ttlMs: 600_000 }),
        )
        .catch((error: { code?: string }) => error.code);
      expect(late).toBe('tenant_suspended');
    });
  });

  describe('erasure', () => {
    /** Every slotlock table with a tenant column, from the catalog. */
    async function tenantTables(): Promise<string[]> {
      const rows = await superuser<{ table_name: string }[]>`
        SELECT columns.table_name
          FROM information_schema.columns columns
          JOIN information_schema.tables tables
            ON tables.table_schema = columns.table_schema
           AND tables.table_name = columns.table_name
         WHERE columns.table_schema = 'slotlock' AND columns.column_name = 'tenant_ref'
           AND tables.table_type = 'BASE TABLE'
         ORDER BY columns.table_name`;
      return rows.map((row) => row.table_name);
    }

    /** The tenant's rows in each table (holds, which carry no tenant, by their resource). */
    async function counts(tenantRef: string, tables: readonly string[]) {
      const result: Record<string, number> = {};
      for (const table of tables) {
        const [row] =
          table === 'reservations'
            ? await superuser<{ count: number }[]>`
                SELECT count(*)::int AS count FROM slotlock.reservations
                 WHERE tenant_ref = ${tenantRef}
                    OR resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef})`
            : await superuser.unsafe<{ count: number }[]>(
                `SELECT count(*)::int AS count FROM slotlock.${table} WHERE tenant_ref = $1`,
                [tenantRef],
              );
        result[table] = row?.count ?? 0;
      }
      return result;
    }

    const ownerDigest = (uid: string) =>
      superuser<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.dashboard_tokens
         WHERE kind = 'form'
           AND owner_hash = sha256(convert_to(${`slotlock-dashboard-owner.${uid}`}, 'UTF8'))`;

    /** A tenant with a row in every table it can own rows in. */
    async function populate(tenantRef: string, uid: string) {
      await app.withTenant(tenantRef, async (tenant) => {
        const resource = await tenant.createResource({
          tenantRef,
          externalRef: 'van-1',
          timezone: 'UTC',
        });
        const resourceId = resource.id;
        const hold = await tenant.acquireHold({
          tenantRef,
          resourceId,
          ...slot(0),
          ttlMs: 600_000,
          idempotencyKey: 'hold-1',
          principalRef: 'key-1',
        });
        if (!hold.ok) throw new Error(hold.code);
        const confirmed = await tenant.acquireHold({
          tenantRef,
          resourceId,
          ...slot(1),
          ttlMs: 600_000,
        });
        if (!confirmed.ok) throw new Error(confirmed.code);
        expect((await tenant.confirmHold(confirmed.hold.id, { tenantRef })).ok).toBe(true);
        expect(
          (
            await tenant.createExternalReservation({
              tenantRef,
              externalRef: 'booking-1',
              resourceId,
              ...slot(2),
              bufferAfterMs: 0,
              revision: 1,
            })
          ).ok,
        ).toBe(true);
        expect(
          (
            await tenant.cancelExternalReservation({
              tenantRef,
              externalRef: 'never-booked',
              revision: 1,
            })
          ).ok,
        ).toBe(true);
        const series = await tenant.putCalendarEvent({
          tenantRef,
          externalRef: 'shift-1',
          idempotencyKey: 'shift-create',
          expectedRevision: 0,
          resourceId,
          start: new Date('2027-02-02T09:00:00Z'),
          end: new Date('2027-02-02T10:00:00Z'),
          timezone: 'UTC',
          summary: 'Shift',
          attendees: [{ email: 'driver@example.com', name: 'Driver' }],
          reminders: [{ action: 'email', minutesBeforeStart: 30 }],
          recurrence: {
            rrule: 'FREQ=DAILY;COUNT=5',
            exceptions: [{ recurrenceId: new Date('2027-02-03T09:00:00Z'), cancelled: true }],
          },
          materializationWindow: {
            start: new Date('2027-02-01T00:00:00Z'),
            end: new Date('2027-03-01T00:00:00Z'),
          },
        });
        if (!series.ok) throw new Error(series.code);
        const agentEvent = await tenant.putCalendarEvent({
          tenantRef,
          ownerRef: AGENT,
          externalRef: 'agent-1',
          idempotencyKey: 'agent-create',
          expectedRevision: 0,
          resourceId,
          ...slot(20),
          timezone: 'UTC',
          summary: 'Collection',
        });
        if (!agentEvent.ok) throw new Error(agentEvent.code);
        expect(
          (
            await tenant.cancelCalendarEvent({
              tenantRef,
              ownerRef: AGENT,
              externalRef: 'agent-1',
              idempotencyKey: 'agent-cancel',
              expectedRevision: 1,
            })
          ).ok,
        ).toBe(true);
        expect(
          (
            await tenant.recordCalendarCoverage({
              tenantRef,
              resourceId,
              source: 'ics:fleet',
              window: { start: slot(0).start, end: slot(48).end },
              revision: 1,
            })
          ).ok,
        ).toBe(true);
        return resourceId;
      });
      const resourceId = (
        await superuser<{ id: string }[]>`
        SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`
      )[0]?.id as string;
      // A booking an upgrade set aside, which only the deployment DDL writes.
      await superuser`
        INSERT INTO slotlock.reservation_conflict_archive (
          tenant_ref, original_reservation_id, original_resource_id, keeper_resource_id,
          external_ref, starts_at, ends_at, status, original_created_at, reason
        ) VALUES (
          ${tenantRef}, ${randomUUID()}, ${resourceId}, ${resourceId}, 'archived-1',
          ${slot(5).start}, ${slot(5).end}, 'confirmed', now(), 'test'
        )`;
      const keys = createSlotlockApiKeyStore(application);
      const key = await keys.create({ tenantRef, name: 'Agent key', scopes: ['read', 'write'] });
      await keys.revoke({
        tenantRef,
        id: (await keys.create({ tenantRef, name: 'Old key', scopes: ['read'] })).apiKey.id,
      });
      const dashboard = createSlotlockDashboardState(application);
      expect(await dashboard.use('form', `form-${randomUUID()}`, Date.now() + HOUR, uid)).toBe(
        true,
      );
      return { key: key.key, resourceId };
    }

    it('deletes every row the tenant owns in every table with a tenant column, and nothing else', async () => {
      const uid = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const canaryUid = `${uid}9`;
      const tenantRef = `github:${uid}`;
      const canary = `github:${canaryUid}`;
      const erasedKey = (await populate(tenantRef, uid)).key;
      const canaryKey = (await populate(canary, canaryUid)).key;
      await asOwner((store) => store.suspendTenant({ tenantRef, reason: 'erasure test' }));

      const tables = await tenantTables();
      // The suspension is kept on purpose (an erased abuser stays suspended); every other table with
      // a tenant column is the tenant's data and must be erased.
      const owned = tables.filter((table) => table !== 'tenant_suspensions');
      expect(tables).toContain('tenant_suspensions');
      const before = await counts(tenantRef, owned);
      const canaryBefore = await counts(canary, owned);
      for (const table of owned) expect(before[table], table).toBeGreaterThan(0);
      expect((await ownerDigest(uid))[0]?.count).toBe(1);

      // As the serving role, under forced row-level security.
      const erased = await app.eraseTenant({ tenantRef });
      for (const table of owned) expect(erased.rows[table], table).toBe(before[table]);
      expect(erased.rows.dashboard_tokens).toBe(1);
      expect(erased.total).toBe(Object.values(before).reduce((sum, count) => sum + count, 0) + 1);
      const after = await counts(tenantRef, owned);
      for (const table of owned) expect(after[table], table).toBe(0);
      expect((await ownerDigest(uid))[0]?.count).toBe(0);
      expect(await counts(canary, owned)).toEqual(canaryBefore);
      expect((await ownerDigest(canaryUid))[0]?.count).toBe(1);

      const keys = createSlotlockApiKeyStore(application);
      await expect(keys.authenticate(erasedKey)).resolves.toBeNull();
      await expect(keys.authenticate(canaryKey)).resolves.toMatchObject({ tenantRef: canary });
      await expect(app.isTenantSuspended({ tenantRef })).resolves.toBe(true);

      // Again: nothing left, nothing deleted.
      const again = await app.eraseTenant({ tenantRef });
      expect(again.total).toBe(0);
      expect(Object.keys(again.rows).sort()).toEqual(Object.keys(erased.rows).sort());
    });

    it('waits for the tenant’s transaction in flight', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => {};
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      const writer = app.withTenant(tenantRef, async (tenant) => {
        await tenant.acquireHold({ tenantRef, resourceId, ...slot(3), ttlMs: 600_000 });
        started();
        await gate;
      });
      await inFlight;
      const erasure = app.eraseTenant({ tenantRef });
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await writer;
      // The hold committed before the erasure began deleting, so it went with the rest.
      await expect(erasure).resolves.toMatchObject({ rows: { reservations: 1, resources: 1 } });
    });

    it('waits for a key being issued, so the erased tenant keeps none', async () => {
      const { tenantRef } = await freshTenant();
      const creating = keyInFlight(tenantRef);
      await creating.inFlight;
      const erasure = app.eraseTenant({ tenantRef });
      expect(await stillWaiting(erasure)).toBe(true);
      creating.release();
      await creating.committed;
      await expect(erasure).resolves.toMatchObject({ rows: { api_keys: 1 } });
      const [left] = await superuser<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.api_keys WHERE tenant_ref = ${tenantRef}`;
      expect(left?.count).toBe(0);
    });
  });
});
