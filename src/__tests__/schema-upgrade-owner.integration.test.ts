// Upgrading as the deployment role itself, after applyTenantRls has forced row-level security: FORCE
// binds the table owner too, and applySchema sets no tenant, yet every data step of the upgrade must
// see every row. The role is NOSUPERUSER NOBYPASSRLS, owns what it deploys and is reached through
// SET ROLE, as README's deployment role is. A database and a role of their own; skipped without
// DATABASE_URL; the connecting role must create databases and roles.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SLOTLOCK_CORE_DDL, SLOTLOCK_TENANT_TABLES } from '../ddl.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const HOUR = 3_600_000;

/** Put back the 0.1 overlap constraints in place of this release's (as schema-upgrade does). */
async function shapeAsRelease01(sql: postgres.Sql) {
  await sql.unsafe(`
    ALTER TABLE slotlock.reservations DROP CONSTRAINT slotlock_reservations_no_overlap;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      );
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_buffered_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, occupied_ends_at, '[)') WITH &&
      ) WHERE (tenant_ref IS NOT NULL);
  `);
}

describe.skipIf(!url)('upgrading as the owning role under forced RLS', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_owner_upgrade_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const tenantRef = `owner-upgrade-${randomUUID()}`;
  let admin: postgres.Sql;
  /** A superuser on the test database: it stands for rows 0.1 accepted and for inspection. */
  let superuser: postgres.Sql;

  /** Run `work` as the owning role, through SET ROLE, in one transaction. */
  async function asOwner<T>(work: (store: SlotlockStore) => Promise<T>): Promise<T> {
    return (await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      return work(createSlotlockStore(tx));
    })) as T;
  }

  async function forcedTables() {
    const rows = await superuser<{ name: string }[]>`
      SELECT rel.relname AS name
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock' AND rel.relforcerowsecurity
       ORDER BY rel.relname`;
    return rows.map(({ name }) => name);
  }

  async function constraintsOfReservations() {
    const rows = await superuser<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'slotlock.reservations'::regclass AND contype = 'x'`;
    return Object.fromEntries(rows.map(({ name, definition }) => [name, definition]));
  }

  /** A resource and, tomorrow, a booking that keeps it busy for an hour after; made as the owner. */
  async function bufferedBooking() {
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
    return asOwner((store) =>
      store.withTenant(tenantRef, async (tenant) => {
        const resource = await tenant.createResource({
          tenantRef,
          externalRef: 'van-1',
          timezone: 'UTC',
        });
        const booked = await tenant.createExternalReservation({
          tenantRef,
          externalRef: `booking-${randomUUID()}`,
          resourceId: resource.id,
          start,
          end: new Date(start.getTime() + HOUR),
          bufferAfterMs: HOUR,
          revision: 1,
        });
        if (!booked.ok) throw new Error(`expected a booking, got ${booked.code}`);
        return booked.reservation;
      }),
    );
  }

  /** A hold 0.1 accepted inside a booking's buffer, written past RLS: 15 to 45 minutes after it. */
  async function holdInBuffer(booking: { resourceId: string; end: Date }, expiresInMs: number) {
    const [row] = await superuser<{ id: string }[]>`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at)
      VALUES (${booking.resourceId}, ${new Date(booking.end.getTime() + HOUR / 4)},
              ${new Date(booking.end.getTime() + (3 * HOUR) / 4)},
              'held', now() + ${expiresInMs} * interval '1 millisecond')
      RETURNING id`;
    return row?.id as string;
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(
      `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
  });

  afterAll(async () => {
    await superuser?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  beforeEach(async () => {
    await superuser.unsafe('DROP SCHEMA IF EXISTS slotlock CASCADE');
    await asOwner(async (store) => {
      await store.applySchema();
      await store.applyTenantRls();
    });
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
  });

  it('reaps an expired hold in a buffer and replaces the 0.1 constraints, keeping FORCE', async () => {
    await shapeAsRelease01(superuser);
    const booking = await bufferedBooking();
    const expired = await holdInBuffer(booking, -60_000);

    await expect(asOwner((store) => store.applySchema())).resolves.toBeUndefined();

    const ids = (await superuser<{ id: string }[]>`SELECT id FROM slotlock.reservations`).map(
      ({ id }) => id,
    );
    expect(ids).toEqual([booking.id]);
    expect(ids).not.toContain(expired);
    const constraints = await constraintsOfReservations();
    expect(constraints.slotlock_reservations_no_overlap).toContain(
      'COALESCE(occupied_ends_at, ends_at)',
    );
    expect(constraints).not.toHaveProperty('slotlock_reservations_buffered_no_overlap');
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
  });

  it('refuses while a live hold is in a buffer, naming both rows, and changes nothing', async () => {
    await shapeAsRelease01(superuser);
    const booking = await bufferedBooking();
    const live = await holdInBuffer(booking, 600_000);
    const before = await constraintsOfReservations();

    const refused = await asOwner((store) => store.applySchema()).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string; detail?: string },
    );
    expect(refused).toMatchObject({
      code: '23P01',
      message:
        "Slotlock cannot upgrade: 1 reservations or holds overlap another's turnaround buffer",
      detail: `Reservation ids, in pairs: ${booking.id} and ${live}`,
    });
    expect(await constraintsOfReservations()).toEqual(before);
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
  });

  it('backfills event children and binds archives it cannot see without a tenant', async () => {
    const { resourceId, eventId } = await asOwner((store) =>
      store.withTenant(tenantRef, async (tenant) => {
        const resource = await tenant.createResource({
          tenantRef,
          externalRef: 'van-1',
          timezone: 'UTC',
        });
        const put = await tenant.putCalendarEvent({
          tenantRef,
          externalRef: `handover-${randomUUID()}`,
          idempotencyKey: `create-${randomUUID()}`,
          expectedRevision: 0,
          resourceId: resource.id,
          start: new Date('2027-03-29T09:00:00Z'),
          end: new Date('2027-03-29T10:00:00Z'),
          timezone: 'UTC',
          summary: 'Vehicle handover',
          attendees: [
            { email: 'renter@example.com', participationStatus: 'needs_action', rsvp: true },
          ],
          reminders: [{ action: 'display', minutesBeforeStart: 30 }],
        });
        if (!put.ok) throw new Error(`expected an event, got ${put.code}`);
        return { resourceId: resource.id, eventId: put.eventId };
      }),
    );
    // As a release before the normalized children, and before archives carried their tenant, left them
    // (and before schemas recorded their version).
    await superuser`DROP TABLE slotlock.schema_version`;
    await superuser`DELETE FROM slotlock.calendar_event_attendees WHERE event_id = ${eventId}`;
    await superuser`DELETE FROM slotlock.calendar_event_reminders WHERE event_id = ${eventId}`;
    const [archive] = await superuser<{ archive_id: string }[]>`
      INSERT INTO slotlock.reservation_conflict_archive
        (tenant_ref, original_reservation_id, original_resource_id, keeper_resource_id, external_ref,
         starts_at, ends_at, status, original_created_at, reason)
      VALUES (NULL, ${randomUUID()}, ${randomUUID()}, ${resourceId}, 'van-1',
              '2027-03-01T09:00:00Z', '2027-03-01T10:00:00Z', 'confirmed', now(), 'overlap_conflict')
      RETURNING archive_id`;
    // An operator lifted FORCE from one table: the upgrade leaves it so.
    await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      await tx.unsafe('ALTER TABLE slotlock.calendar_coverage NO FORCE ROW LEVEL SECURITY');
    });

    await asOwner((store) => store.applySchema());

    const children = await superuser<{ attendees: number; reminders: number }[]>`
      SELECT (SELECT count(*)::int FROM slotlock.calendar_event_attendees WHERE event_id = ${eventId}) AS attendees,
             (SELECT count(*)::int FROM slotlock.calendar_event_reminders WHERE event_id = ${eventId}) AS reminders`;
    expect(children[0]).toEqual({ attendees: 1, reminders: 1 });
    const [bound] = await superuser<{ tenant_ref: string | null }[]>`
      SELECT tenant_ref FROM slotlock.reservation_conflict_archive WHERE archive_id = ${archive?.archive_id as string}`;
    expect(bound?.tenant_ref).toBe(tenantRef);
    expect(await forcedTables()).toEqual(
      [...SLOTLOCK_TENANT_TABLES].filter((table) => table !== 'calendar_coverage').sort(),
    );
  });

  it('merges duplicate resources it cannot see without a tenant before restoring their unique index', async () => {
    const booking = await bufferedBooking();
    // As a database poisoned by the pre-index race held them: a second van-1 for the same tenant.
    await superuser`DROP INDEX slotlock.slotlock_resources_tenant_external_ref_key`;
    await superuser`
      INSERT INTO slotlock.resources (tenant_ref, external_ref, timezone) VALUES (${tenantRef}, 'van-1', 'UTC')`;

    await expect(asOwner((store) => store.applySchema())).resolves.toBeUndefined();

    const resources = await superuser<{ id: string }[]>`
      SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef} AND external_ref = 'van-1'`;
    expect(resources).toHaveLength(1);
    const [kept] = await superuser<{ resource_id: string }[]>`
      SELECT resource_id FROM slotlock.reservations WHERE id = ${booking.id}`;
    expect(kept?.resource_id).toBe(resources[0]?.id);
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
  });

  it('puts FORCE back when its statements run one by one, outside one transaction', async () => {
    /** One DO block of the core DDL, by its dollar-quote tag. */
    const block = (tag: string) => {
      const start = SLOTLOCK_CORE_DDL.indexOf(`DO $${tag}$`);
      const end = SLOTLOCK_CORE_DDL.indexOf(`$${tag}$;`, start + tag.length + 5) + tag.length + 3;
      expect(start).toBeGreaterThan(0);
      return SLOTLOCK_CORE_DDL.slice(start, end);
    };
    const session = await superuser.reserve();
    try {
      await session.unsafe(`SET ROLE ${owner}`);
      // Each simple query is a transaction of its own here, as under psql without --single-transaction.
      await session.unsafe(block('slotlock_lift_forced_row_security'));
      expect(await forcedTables()).toEqual([]);
      await session.unsafe(block('slotlock_restore_forced_row_security'));
      expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
    } finally {
      await session.unsafe('RESET ROLE');
      session.release();
    }
  });
});
