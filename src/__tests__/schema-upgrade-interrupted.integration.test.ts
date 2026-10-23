// An upgrade run statement by statement (psql without --single-transaction) commits its lift of
// forced row-level security on its own. When a later data step refuses (a live conflict), the
// restore never runs. Whatever session runs the next upgrade must still put FORCE back on exactly
// the tables that had it: a list kept in a session setting died with the session, and FORCE stayed
// off for good, letting the owning role read every tenant's rows. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_CORE_DDL, SLOTLOCK_TENANT_TABLES } from '../ddl.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('an upgrade refused part way, statement by statement (real Postgres)', () => {
  const suffix = randomBytes(5).toString('hex');
  const database = `pylota_slotlock_interrupted_${suffix}`;
  const owner = `slotlock_interrupted_owner_${suffix}`;
  const tenantRef = `interrupted-${randomUUID()}`;
  let admin: postgres.Sql;
  let superuser: postgres.Sql;

  const connectToDatabase = () => {
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    return postgres(target.href, { max: 2, onnotice: () => undefined });
  };

  async function asOwner<T>(work: (store: SlotlockStore) => Promise<T>): Promise<T> {
    return (await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      return work(createSlotlockStore(tx));
    })) as T;
  }

  async function forcedTables() {
    const rows = await superuser<{ name: string }[]>`
      SELECT rel.relname AS name FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock' AND rel.relforcerowsecurity ORDER BY rel.relname`;
    return rows.map(({ name }) => name);
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    superuser = connectToDatabase();
  });

  afterAll(async () => {
    await superuser?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  it('puts FORCE back on exactly those tables at the next upgrade, from any session', async () => {
    await asOwner(async (store) => {
      await store.applySchema();
      await store.applyTenantRls();
    });
    const tenantTables = [...SLOTLOCK_TENANT_TABLES].sort();
    expect(await forcedTables()).toEqual(tenantTables);

    // A 0.1 database with a live hold inside a booking's buffer: the upgrade must refuse.
    await superuser.unsafe(`
      ALTER TABLE slotlock.reservations DROP CONSTRAINT slotlock_reservations_no_overlap;
      ALTER TABLE slotlock.reservations ADD CONSTRAINT slotlock_reservations_no_overlap
        EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&);
      ALTER TABLE slotlock.reservations ADD CONSTRAINT slotlock_reservations_buffered_no_overlap
        EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, occupied_ends_at, '[)') WITH &&)
        WHERE (tenant_ref IS NOT NULL);`);
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
    const booking = await asOwner((store) =>
      store.withTenant(tenantRef, async (tenant) => {
        const resource = await tenant.createResource({
          tenantRef,
          externalRef: 'van-1',
          timezone: 'UTC',
        });
        const booked = await tenant.createExternalReservation({
          tenantRef,
          externalRef: 'booking-1',
          resourceId: resource.id,
          start,
          end: new Date(start.getTime() + HOUR),
          bufferAfterMs: HOUR,
          revision: 1,
        });
        if (!booked.ok) throw new Error(booked.code);
        return booked.reservation;
      }),
    );
    const [live] = await superuser<{ id: string }[]>`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at)
      VALUES (${booking.resourceId}, ${new Date(booking.end.getTime() + HOUR / 4)},
              ${new Date(booking.end.getTime() + (3 * HOUR) / 4)}, 'held', now() + interval '10 minutes')
      RETURNING id`;

    // As psql -v ON_ERROR_STOP=1 without --single-transaction: what precedes the data steps commits,
    // the next statement is refused, and the run stops.
    const liftTag = '$slotlock_lift_forced_row_security$;';
    const liftEnd = SLOTLOCK_CORE_DDL.indexOf(liftTag) + liftTag.length;
    const restoreStart = SLOTLOCK_CORE_DDL.indexOf('DO $slotlock_restore_forced_row_security$');
    expect(liftEnd).toBeGreaterThan(liftTag.length);
    expect(restoreStart).toBeGreaterThan(liftEnd);
    const session = await superuser.reserve();
    let refusal: unknown = null;
    try {
      await session.unsafe(`SET ROLE ${owner}`);
      await session.unsafe(SLOTLOCK_CORE_DDL.slice(0, liftEnd));
      await session
        .unsafe(SLOTLOCK_CORE_DDL.slice(liftEnd, restoreStart))
        .catch((error: unknown) => {
          refusal = error;
        });
      await session.unsafe('RESET ROLE');
    } finally {
      session.release();
    }
    // That session, and anything it kept, is gone.
    await superuser.end();
    superuser = connectToDatabase();
    expect(refusal).toMatchObject({ code: '23P01' });
    // Lifted, and recorded where the next upgrade will find it.
    expect(await forcedTables()).toEqual([]);

    // The operator removes the conflict and upgrades again, in one transaction, in a new session.
    await superuser`DELETE FROM slotlock.reservations WHERE id = ${live?.id as string}`;
    await asOwner((store) => store.applySchema());
    expect(await forcedTables()).toEqual(tenantTables);

    // The owning role, under another tenant's context, sees none of this tenant's rows.
    const seen = await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      await tx`SELECT set_config('slotlock.tenant_ref', 'some-other-tenant', true)`;
      return tx<{ tenant_ref: string }[]>`SELECT tenant_ref FROM slotlock.reservations`;
    });
    expect(seen).toEqual([]);

    // A one-transaction upgrade of a sound database lifts and restores within itself.
    await asOwner((store) => store.applySchema());
    expect(await forcedTables()).toEqual(tenantTables);
  });
});
